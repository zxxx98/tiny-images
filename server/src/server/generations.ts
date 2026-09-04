import type { FastifyReply, FastifyRequest } from "fastify";
import { ValidationError } from "../core/errors.js";
import type { UnifiedEditRequest, UnifiedGenRequest, UnifiedImage, UnifiedImageResult, UnifiedVariationRequest } from "../core/types.js";
import { conformImages, localizeImage } from "../media/b64cache.js";
import type { AppContext } from "../app.js";
import type { ChannelRow } from "../store/repo.js";
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
      ...(common.horde ? { providerOptions: { horde: common.horde } } : {}),
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
  if (result.includeRawResponseFields !== false && result.raw && typeof result.raw === "object") {
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
  const abortIfOpen = () => {
    if (!reply.raw.writableEnded) ac.abort(new Error("client disconnected"));
  };
  req.raw.on("aborted", abortIfOpen);
  reply.raw.on("close", abortIfOpen);
  return ac.signal;
}

type UnifiedPayload = UnifiedGenRequest | UnifiedEditRequest | UnifiedVariationRequest;

export interface FinishedSync {
  body: Record<string, unknown>;
  channel: ChannelRow;
}

export function imageFetchOptions(ctx: AppContext, channel: ChannelRow) {
  return {
    allowPrivateNetwork: channel.allowPrivateImageFetch,
    maxBytes: ctx.deps.env.imageFetch?.maxBytes,
    maxPixels: ctx.deps.env.imageFetch?.maxPixels,
  };
}

export async function finishSync(
  ctx: AppContext,
  req: FastifyRequest,
  reply: FastifyReply,
  model: string,
  kind: "generate" | "edit" | "variation",
  payload: UnifiedPayload,
): Promise<FinishedSync> {
  const signal = requestSignal(req, reply);
  const routeOpts = {
    callerApiKeyId: req.callerApiKeyId ?? null,
    callerUserId: req.callerUserId ?? null,
    modelAccess: ctx.deps.repo.modelAccessPolicy(req.callerUserId ?? null),
    signal,
  };
  const r =
    kind === "generate"
      ? await ctx.deps.executor.generate(model, payload as UnifiedGenRequest, routeOpts)
      : kind === "edit"
        ? await ctx.deps.executor.edit(model, payload as UnifiedEditRequest, routeOpts)
        : await ctx.deps.executor.variation(model, payload as UnifiedVariationRequest, routeOpts);
  const images = await conformImages({
    images: r.result.images,
    wanted: payload.responseFormat,
    dataDir: ctx.deps.env.dataDir,
    fileBaseUrl: fileBaseUrlFor(ctx, req),
    fetchTimeoutMs: r.channel.timeoutMs,
    ...imageFetchOptions(ctx, r.channel),
    signal,
  });
  reply.header("x-tiny-channel", r.channel.name);
  reply.header("x-tiny-latency-ms", r.latencyMs);
  return { body: toImagesResponse(r.result, images), channel: r.channel };
}

export function registerGenerations(ctx: AppContext): void {
  ctx.app.post("/v1/images/generations", { preHandler: ctx.requireApiKey }, async (req, reply) => {
    const { model, req: genReq, stream } = validateGenBody(req.body);
    if (stream) {
      return streamImageFlow(ctx, req, reply, model, "generate", genReq, fileBaseUrlFor(ctx, req));
    }
    const started = Date.now();
    try {
      const finished = await finishSync(ctx, req, reply, model, "generate", genReq);
      await recordGeneration(ctx, req, model, genRecordMeta(genReq), "ok", Date.now() - started, null, await extractHistoryImages(ctx, finished.body, finished.channel));
      return finished.body;
    } catch (err) {
      await recordGeneration(ctx, req, model, genRecordMeta(genReq), "error", Date.now() - started, err instanceof Error ? err.message : String(err), []);
      throw err;
    }
  });
}

// 兼容端点同样进历史：从响应里提取图片并本地化落盘（失败忽略该张）
export async function extractHistoryImages(
  ctx: AppContext,
  body: Record<string, unknown>,
  channel: ChannelRow,
): Promise<{ file: string; width: number; height: number; revisedPrompt?: string }[]> {
  const out: { file: string; width: number; height: number; revisedPrompt?: string }[] = [];
  const items = ((body.data as unknown) as Record<string, unknown>[] | undefined) ?? [];
  for (const item of items) {
    const url = typeof item.url === "string" ? item.url : undefined;
    const b64 = typeof item.b64_json === "string" ? item.b64_json : undefined;
    const revisedPrompt = typeof item.revised_prompt === "string" ? item.revised_prompt : undefined;
    const saved = await localizeImage(ctx.deps.env.dataDir, { b64, url }, 30_000, imageFetchOptions(ctx, channel));
    if (saved) out.push({ ...saved, ...(revisedPrompt !== undefined ? { revisedPrompt } : {}) });
  }
  return out;
}

export async function recordGeneration(
  ctx: AppContext,
  req: FastifyRequest,
  model: string,
  meta: GenRecordMeta,
  status: "ok" | "error",
  latencyMs: number,
  errorMessage: string | null,
  images: { file: string; width: number; height: number; revisedPrompt?: string }[],
): Promise<void> {
  try {
    ctx.deps.repo.insertGeneration({
      createdAt: Date.now(),
      apiKeyId: req.callerApiKeyId ?? null,
      userId: req.callerUserId ?? null,
      model,
      prompt: meta.prompt,
      params: JSON.stringify(meta.params),
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

export interface GenRecordMeta {
  prompt: string;
  params: Record<string, unknown>;
}

export function genRecordMeta(genReq: UnifiedGenRequest): GenRecordMeta {
  return {
    prompt: genReq.prompt,
    params: {
      n: genReq.n,
      size: genReq.size,
      quality: genReq.quality,
      responseFormat: genReq.responseFormat,
    },
  };
}

export function editRecordMeta(editReq: UnifiedEditRequest): GenRecordMeta {
  return {
    prompt: editReq.prompt,
    params: {
      n: editReq.n,
      size: editReq.size,
      responseFormat: editReq.responseFormat,
    },
  };
}

export function variationRecordMeta(varReq: UnifiedVariationRequest): GenRecordMeta {
  return {
    prompt: "",
    params: {
      kind: "variation",
      n: varReq.n,
      size: varReq.size,
      responseFormat: varReq.responseFormat,
    },
  };
}
