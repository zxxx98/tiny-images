import type { FastifyReply, FastifyRequest } from "fastify";
import type { AppContext } from "../app.js";
import { ValidationError } from "../core/errors.js";
import type { UnifiedGenRequest } from "../core/types.js";
import { localizeImage } from "../media/b64cache.js";
import type { GenerationRow } from "../store/repo.js";
import { fileBaseUrlFor, validateGenBody } from "./generations.js";
import type { JobManager, JobRecord } from "./jobs.js";

type ApiImage = { file: string; url: string; revisedPrompt?: string };

function toApiImages(ctx: AppContext, req: FastifyRequest, images: { file: string; revisedPrompt?: string }[]): ApiImage[] {
  const base = fileBaseUrlFor(ctx, req);
  return images.map((img) => ({ ...img, url: `${base}/files/${img.file}` }));
}

function serializeJob(ctx: AppContext, req: FastifyRequest, job: JobRecord): Record<string, unknown> {
  return {
    status: job.status,
    progress: job.progress,
    channel: job.channelName,
    latencyMs: job.latencyMs,
    error: job.errorMessage,
    createdAt: job.createdAt,
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
  routeOpts: { callerUserId: number | null; allowedChannelIds: number[] | null },
): Promise<void> {
  const started = Date.now();
  try {
    const r = await ctx.deps.executor.generate(model, genReq, {
      callerApiKeyId: apiKeyId,
      callerUserId: routeOpts.callerUserId,
      allowedChannelIds: routeOpts.allowedChannelIds,
    });
    const images: { file: string; revisedPrompt?: string }[] = [];
    for (const img of r.result.images) {
      const saved = await localizeImage(ctx.deps.env.dataDir, img, r.channel.timeoutMs);
      if (saved) {
        const entry = { file: saved.file, ...(img.revisedPrompt !== undefined ? { revisedPrompt: img.revisedPrompt } : {}) };
        images.push(entry);
        jobManager.addImage(jobId, entry);
      }
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
    const job = ctx.deps.jobManager.create({ apiKeyId, generationId, model, prompt: genReq.prompt });
    void runJob(ctx, ctx.deps.jobManager, job.id, model, genReq, apiKeyId, generationId, {
      callerUserId: req.callerUserId ?? null,
      allowedChannelIds: ctx.deps.repo.allowedChannelIds(req.callerUserId ?? null),
    });
    return (reply as FastifyReply).code(200).send({ jobId: job.id });
  });

  ctx.app.get("/v1/images/jobs/:id", { preHandler: ctx.requireApiKey }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = ctx.deps.jobManager.get(id, req.callerApiKeyId ?? null);
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
    const viewer = {
      admin: req.callerRole === "admin",
      userId: req.callerUserId ?? null,
      apiKeyId: req.callerApiKeyId ?? null,
    };
    const rows = ctx.deps.repo.listGenerations(viewer, before, limit);
    return { items: rows.map((r) => serializeRow(ctx, req, r)) };
  });
}
