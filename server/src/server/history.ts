import type { FastifyReply, FastifyRequest } from "fastify";
import fs from "node:fs";
import path from "node:path";
import type { AppContext } from "../app.js";
import { ValidationError } from "../core/errors.js";
import type { UnifiedEditRequest, UnifiedGenRequest } from "../core/types.js";
import type { ModelAccessPolicy } from "../core/types.js";
import { localizeImage } from "../media/b64cache.js";
import type { GenerationRow } from "../store/repo.js";
import { parseEditMultipart } from "./edits.js";
import { fileBaseUrlFor, imageFetchOptions, validateGenBody } from "./generations.js";
import type { JobImage, JobManager, JobRecord } from "./jobs.js";

type ApiImage = JobImage & { url: string };

function toApiImages(ctx: AppContext, req: FastifyRequest, images: JobImage[]): ApiImage[] {
  const base = fileBaseUrlFor(ctx, req);
  return images.map((img) => ({ ...img, url: `${base}/files/${img.file}` }));
}

function serializeJob(ctx: AppContext, req: FastifyRequest, job: JobRecord): Record<string, unknown> {
  return {
    kind: job.kind,
    status: job.status,
    progress: job.progress,
    channel: job.channelName,
    latencyMs: job.latencyMs,
    error: job.errorMessage,
    createdAt: job.createdAt,
    generationId: job.generationId,
    images: toApiImages(ctx, req, job.images),
  };
}

function serializeRow(ctx: AppContext, req: FastifyRequest, r: GenerationRow): Record<string, unknown> {
  return {
    id: r.id,
    createdAt: r.createdAt,
    model: r.model,
    prompt: r.prompt,
    params: JSON.parse(r.params || "{}"),
    status: r.status,
    latencyMs: r.latencyMs,
    errorMessage: r.errorMessage,
    images: toApiImages(ctx, req, JSON.parse(r.images || "[]")),
  };
}

function genParams(genReq: UnifiedGenRequest): string {
  return JSON.stringify({
    n: genReq.n,
    size: genReq.size,
    quality: genReq.quality,
    responseFormat: genReq.responseFormat,
    passthrough: genReq.passthrough,
    horde: genReq.providerOptions?.horde,
  });
}

function editParams(editReq: UnifiedEditRequest): string {
  return JSON.stringify({
    n: editReq.n,
    size: editReq.size,
    responseFormat: editReq.responseFormat,
    passthrough: editReq.passthrough,
    horde: editReq.providerOptions?.horde,
  });
}

// 后台执行生成：与客户端连接解耦，切走页面不影响；完成后写内存 job 与历史记录
async function runJob(
  ctx: AppContext,
  jobManager: JobManager,
  jobId: string,
  model: string,
  genReq: UnifiedGenRequest,
  apiKeyId: number | null,
  generationId: number,
  routeOpts: { callerUserId: number | null; modelAccess: ModelAccessPolicy },
): Promise<void> {
  const started = Date.now();
  try {
    const r = await ctx.deps.executor.generate(model, genReq, {
      callerApiKeyId: apiKeyId,
      callerUserId: routeOpts.callerUserId,
      modelAccess: routeOpts.modelAccess,
    });
    const images: JobImage[] = [];
    for (const img of r.result.images) {
      const saved = await localizeImage(ctx.deps.env.dataDir, img, r.channel.timeoutMs, imageFetchOptions(ctx, r.channel));
      if (saved) {
        const entry: JobImage = {
          file: saved.file,
          width: saved.width,
          height: saved.height,
          ...(img.revisedPrompt !== undefined ? { revisedPrompt: img.revisedPrompt } : {}),
        };
        images.push(entry);
        jobManager.addImage(jobId, entry);
      }
    }
    if (images.length < r.result.images.length) {
      ctx.app.log.warn(`job ${jobId}: localized ${images.length}/${r.result.images.length} images (download or validation failed)`);
    }
    jobManager.finish(jobId, { status: "ok", channelId: r.channel.id, channelName: r.channel.name, latencyMs: r.latencyMs, errorMessage: null });
    ctx.deps.repo.completeGeneration(generationId, {
      status: "ok",
      channelId: r.channel.id,
      latencyMs: r.latencyMs,
      images: JSON.stringify(images),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const latencyMs = Date.now() - started;
    jobManager.finish(jobId, { status: "error", channelId: null, channelName: null, latencyMs, errorMessage: message });
    ctx.deps.repo.completeGeneration(generationId, { status: "error", latencyMs, errorMessage: message });
  }
}

async function runEditJob(
  ctx: AppContext,
  jobId: string,
  model: string,
  editReq: UnifiedEditRequest,
  apiKeyId: number | null,
  generationId: number,
  routeOpts: { callerUserId: number | null; modelAccess: ModelAccessPolicy },
): Promise<void> {
  const started = Date.now();
  try {
    const r = await ctx.deps.executor.edit(model, editReq, {
      callerApiKeyId: apiKeyId,
      callerUserId: routeOpts.callerUserId,
      modelAccess: routeOpts.modelAccess,
    });
    const images: JobImage[] = [];
    if (r.result.images.length === 0) throw new Error("edit job returned no images to localize");
    for (const img of r.result.images) {
      const saved = await localizeImage(ctx.deps.env.dataDir, img, r.channel.timeoutMs, imageFetchOptions(ctx, r.channel));
      if (!saved) throw new Error("failed to localize an edited image");
      images.push({
        file: saved.file,
        width: saved.width,
        height: saved.height,
        ...(img.revisedPrompt !== undefined ? { revisedPrompt: img.revisedPrompt } : {}),
      });
    }
    for (const image of images) ctx.deps.jobManager.addImage(jobId, image);
    ctx.deps.jobManager.finish(jobId, {
      status: "ok",
      channelId: r.channel.id,
      channelName: r.channel.name,
      latencyMs: r.latencyMs,
      errorMessage: null,
    });
    ctx.deps.repo.completeGeneration(generationId, {
      status: "ok",
      channelId: r.channel.id,
      latencyMs: r.latencyMs,
      images: JSON.stringify(images),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const latencyMs = Date.now() - started;
    ctx.deps.jobManager.finish(jobId, { status: "error", channelId: null, channelName: null, latencyMs, errorMessage: message });
    ctx.deps.repo.completeGeneration(generationId, { status: "error", latencyMs, errorMessage: message });
  }
}

// 删除记录引用的本地生成图；文件已过期被清理或名字异常时静默跳过
function deleteRowFiles(dataDir: string, row: GenerationRow): void {
  let images: { file?: unknown }[];
  try {
    images = JSON.parse(row.images || "[]");
  } catch {
    return;
  }
  for (const img of images) {
    if (typeof img?.file !== "string" || !/^[0-9a-f]{32}\.(?:png|jpe?g|webp)$/.test(img.file)) continue;
    try {
      fs.rmSync(path.join(dataDir, "generated", img.file), { force: true });
    } catch {
      // 文件可能已被并发删除
    }
  }
}

function historyViewer(req: FastifyRequest): { admin: boolean; userId: number | null; apiKeyId: number | null } {
  return {
    admin: req.callerRole === "admin",
    userId: req.callerUserId ?? null,
    apiKeyId: req.callerApiKeyId ?? null,
  };
}

export function registerHistory(ctx: AppContext): void {
  ctx.app.post("/v1/images/jobs", { preHandler: ctx.requireApiKey }, async (req, reply) => {
    const { model, req: genReq } = validateGenBody(req.body);
    const apiKeyId = req.callerApiKeyId ?? null;
    const userId = req.callerUserId ?? null;
    const generationId = ctx.deps.repo.insertGeneration({
      createdAt: Date.now(),
      apiKeyId,
      userId,
      model,
      prompt: genReq.prompt,
      params: genParams(genReq),
      status: "pending",
      channelId: null,
      latencyMs: null,
      errorMessage: null,
      images: "[]",
    });
    const job = ctx.deps.jobManager.create({ apiKeyId, userId, generationId, model, prompt: genReq.prompt, kind: "generate" });
    void runJob(ctx, ctx.deps.jobManager, job.id, model, genReq, apiKeyId, generationId, {
      callerUserId: req.callerUserId ?? null,
      modelAccess: ctx.deps.repo.modelAccessPolicy(req.callerUserId ?? null),
    });
    return (reply as FastifyReply).code(200).send({ jobId: job.id });
  });

  ctx.app.post("/v1/images/edit-jobs", { preHandler: ctx.requireApiKey }, async (req, reply) => {
    const { model, editReq } = await parseEditMultipart(req);
    const apiKeyId = req.callerApiKeyId ?? null;
    const userId = req.callerUserId ?? null;
    const generationId = ctx.deps.repo.insertGeneration({
      createdAt: Date.now(),
      apiKeyId,
      userId,
      model,
      prompt: editReq.prompt,
      params: editParams(editReq),
      status: "pending",
      channelId: null,
      latencyMs: null,
      errorMessage: null,
      images: "[]",
    });
    const job = ctx.deps.jobManager.create({ apiKeyId, userId, generationId, model, prompt: editReq.prompt, kind: "edit" });
    void runEditJob(ctx, job.id, model, editReq, apiKeyId, generationId, {
      callerUserId: userId,
      modelAccess: ctx.deps.repo.modelAccessPolicy(userId),
    });
    return (reply as FastifyReply).code(200).send({ jobId: job.id });
  });

  ctx.app.get("/v1/images/jobs/:id", { preHandler: ctx.requireApiKey }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = ctx.deps.jobManager.get(id, {
      apiKeyId: req.callerApiKeyId ?? null,
      userId: req.callerUserId ?? null,
      admin: req.callerRole === "admin",
    });
    if (!job) {
      return reply.code(404).send({ error: { message: "job not found", type: "invalid_request_error", code: null } });
    }
    return serializeJob(ctx, req, job);
  });

  ctx.app.get("/v1/history", { preHandler: ctx.requireApiKey }, async (req) => {
    const q = req.query as { before?: string; limit?: string };
    const limit = Math.min(100, Math.max(1, Number.parseInt(q.limit ?? "30", 10) || 30));
    let before: number | null = null;
    if (q.before !== undefined) {
      before = Number.parseInt(q.before, 10);
      if (Number.isNaN(before)) throw new ValidationError("'before' must be an integer id");
    }
    const viewer = historyViewer(req);
    const rows = ctx.deps.repo.listGenerations(viewer, before, limit);
    return { items: rows.map((r) => serializeRow(ctx, req, r)) };
  });

  ctx.app.delete("/v1/history/:id", { preHandler: ctx.requireApiKey }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const recordId = Number.parseInt(id, 10);
    if (Number.isNaN(recordId)) throw new ValidationError("'id' must be an integer");
    const row = ctx.deps.repo.deleteGeneration(historyViewer(req), recordId);
    if (!row) {
      return reply.code(404).send({ error: { message: "record not found", type: "invalid_request_error", code: null } });
    }
    deleteRowFiles(ctx.deps.env.dataDir, row);
    return reply.code(204).send();
  });
}
