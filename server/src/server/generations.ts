import type { FastifyReply, FastifyRequest } from "fastify";
import { ValidationError } from "../core/errors.js";
import type { UnifiedEditRequest, UnifiedGenRequest, UnifiedImage, UnifiedImageResult } from "../core/types.js";
import { conformImages } from "../media/b64cache.js";
import { localizeImage } from "../media/b64cache.js";
import type { AppContext } from "../app.js";
import { streamImageFlow } from "./stream.js";
import { requireString, validateCommonFields } from "./validate.js";

export function validateGenBody(body: unknown): { model: string; req: UnifiedGenRequest; stream: boolean } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ValidationError("request body must be a JSON object");
  }
  const b = body as Record<string, unknown>;
  const model = requireString(b, "model");
  const prompt = requireString(b, "prompt");
  const common = validateCommonFields(b);
  return {
    model,
    stream: common.stream,
    req: {
      prompt,
      n: common.n,
      size: common.size,
      quality: b.quality as string | undefined,
      responseFormat: common.responseFormat,
      passthrough: common.passthrough,
    },
  };
}

export function toDataItem(img: UnifiedImage): Record<string, unknown> {
  const item: Record<string, unknown> = {};
  if (img.b64 !== undefined) item.b64_json = img.b64;
  if (img.url !== undefined) item.url = img.url;
  if (img.revisedPrompt !== undefined) item.revised_prompt = img.revisedPrompt;
  return item;
}

export function toImagesResponse(result: UnifiedImageResult, images: UnifiedImage[]): Record<string, unknown> {
  const body: Record<string, unknown> = { created: result.created, data: images.map(toDataItem) };
  if (result.raw && typeof result.raw === "object") {
    for (const [k, v] of Object.entries(result.raw as Record<string, unknown>)) {
      if (k === "created" || k === "data") continue;
      body[k] = v;
    }
  }
  return body;
}

export function fileBaseUrlFor(ctx: AppContext, req: FastifyRequest): string {
  if (ctx.deps.env.publicBaseUrl) return ctx.deps.env.publicBaseUrl.replace(/\/+$/, "");
  const host = req.headers.host ?? `localhost:${ctx.deps.env.port}`;
  const proto = req.protocol === "https" || req.headers["x-forwarded-proto"] === "https" ? "https" : "http";
  return `${proto}://${host}`;
}

export function requestSignal(req: FastifyRequest, reply: FastifyReply): AbortSignal {
  const ac = new AbortController();
  req.raw.on("close", () => {
    if (!reply.raw.writableEnded) ac.abort(new Error("client disconnected"));
  });
  return ac.signal;
}

type UnifiedPayload = UnifiedGenRequest | UnifiedEditRequest;

export async function finishSync(
  ctx: AppContext,
  req: FastifyRequest,
  reply: FastifyReply,
  model: string,
  kind: "generate" | "edit",
  payload: UnifiedPayload,
): Promise<unknown> {
  const r =
    kind === "generate"
      ? await ctx.deps.executor.generate(model, payload as UnifiedGenRequest, {
          callerApiKeyId: req.callerApiKeyId ?? null,
          signal: requestSignal(req, reply),
        })
      : await ctx.deps.executor.edit(model, payload as UnifiedEditRequest, {
          callerApiKeyId: req.callerApiKeyId ?? null,
          signal: requestSignal(req, reply),
        });
  const images = await conformImages({
    images: r.result.images,
    wanted: payload.responseFormat,
    dataDir: ctx.deps.env.dataDir,
    fileBaseUrl: fileBaseUrlFor(ctx, req),
    fetchTimeoutMs: r.channel.timeoutMs,
    signal: requestSignal(req, reply),
  });
  reply.header("x-tiny-channel", r.channel.name);
  reply.header("x-tiny-latency-ms", r.latencyMs);
  return toImagesResponse(r.result, images);
}

export function registerGenerations(ctx: AppContext): void {
  ctx.app.post("/v1/images/generations", { preHandler: ctx.requireApiKey }, async (req, reply) => {
    const { model, req: genReq, stream } = validateGenBody(req.body);
    if (stream) {
      return streamImageFlow(ctx, req, reply, model, "generate", genReq, fileBaseUrlFor(ctx, req));
    }
    const started = Date.now();
    try {
      const body = await finishSync(ctx, req, reply, model, "generate", genReq);
      await recordGeneration(ctx, req, model, genReq, "ok", Date.now() - started, null, await extractHistoryImages(ctx, body as Record<string, unknown>));
      return body;
    } catch (err) {
      await recordGeneration(ctx, req, model, genReq, "error", Date.now() - started, err instanceof Error ? err.message : String(err), []);
      throw err;
    }
  });
}

// 兼容端点同样进历史：从响应里提取图片并本地化落盘（失败忽略该张）
async function extractHistoryImages(ctx: AppContext, body: Record<string, unknown>): Promise<{ file: string; revisedPrompt?: string }[]> {
  const out: { file: string; revisedPrompt?: string }[] = [];
  const items = ((body.data as unknown) as Record<string, unknown>[] | undefined) ?? [];
  for (const item of items) {
    const url = typeof item.url === "string" ? item.url : undefined;
    const b64 = typeof item.b64_json === "string" ? item.b64_json : undefined;
    const revisedPrompt = typeof item.revised_prompt === "string" ? item.revised_prompt : undefined;
    const saved = await localizeImage(ctx.deps.env.dataDir, { b64, url }, 30_000);
    if (saved) out.push({ file: saved.file, ...(revisedPrompt !== undefined ? { revisedPrompt } : {}) });
  }
  return out;
}

async function recordGeneration(
  ctx: AppContext,
  req: FastifyRequest,
  model: string,
  genReq: UnifiedGenRequest,
  status: "ok" | "error",
  latencyMs: number,
  errorMessage: string | null,
  images: { file: string; revisedPrompt?: string }[],
): Promise<void> {
  try {
    ctx.deps.repo.insertGeneration({
      createdAt: Date.now(),
      apiKeyId: req.callerApiKeyId ?? null,
      model,
      prompt: genReq.prompt,
      params: JSON.stringify({ n: genReq.n, size: genReq.size, quality: genReq.quality, responseFormat: genReq.responseFormat }),
      status,
      channelId: null,
      latencyMs,
      errorMessage,
      images: JSON.stringify(images),
    });
  } catch {
    // 历史落库失败不影响响应
  }
}
