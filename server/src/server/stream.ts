import { ModelNotFoundError, toOpenAIError } from "../core/errors.js";
import type { FastifyRequest } from "fastify";
import type { UnifiedEditRequest, UnifiedGenRequest } from "../core/types.js";
import { conformImages, localizeImage } from "../media/b64cache.js";
import type { AppContext } from "../app.js";
import { requestSignal, toDataItem, toImagesResponse } from "./generations.js";
import { sseReply } from "./sse.js";

type UnifiedPayload = UnifiedGenRequest | UnifiedEditRequest;

export async function streamImageFlow(
  ctx: AppContext,
  req: FastifyRequest,
  reply: Parameters<typeof sseReply>[0],
  model: string,
  kind: "generate" | "edit",
  payload: UnifiedPayload,
  fileBaseUrl: string,
): Promise<void> {
  // 路由错误发生在流开始前，仍以 JSON 错误返回
  const allowedChannelIds = ctx.deps.repo.allowedChannelIds(req.callerUserId ?? null);
  const route = ctx.deps.router.resolve(model, allowedChannelIds);
  if (!route) throw new ModelNotFoundError(model);
  const signal = requestSignal(req, reply);

  reply.hijack();
  const writer = sseReply(reply);
  const stopHeartbeat = writer.startHeartbeat(() => writer.send({ type: "progress", message: "generating" }));
  writer.send({ type: "status", stage: "submitted" });
  const routeOpts = {
    callerApiKeyId: req.callerApiKeyId ?? null,
    callerUserId: req.callerUserId ?? null,
    allowedChannelIds,
    signal,
  };
  const callerApiKeyId = req.callerApiKeyId ?? null;
  const callerUserId = req.callerUserId ?? null;
  try {
    const r =
      kind === "generate"
        ? await ctx.deps.executor.generate(model, payload as UnifiedGenRequest, routeOpts)
        : await ctx.deps.executor.edit(model, payload as UnifiedEditRequest, routeOpts);
    const images = await conformImages({
      images: r.result.images,
      wanted: payload.responseFormat,
      dataDir: ctx.deps.env.dataDir,
      fileBaseUrl,
      fetchTimeoutMs: r.channel.timeoutMs,
      signal,
    });
    images.forEach((img, index) => writer.send({ type: "image", index, ...toDataItem(img) }));
    writer.send({ type: "completed", ...toImagesResponse(r.result, images) });
    await recordStreamGeneration(ctx, callerApiKeyId, callerUserId, model, payload, "ok", r.channel.id, r.latencyMs, null, images);
    stopHeartbeat();
    writer.end();
  } catch (err) {
    stopHeartbeat();
    const { body } = toOpenAIError(err);
    writer.send({ type: "error", error: body.error });
    await recordStreamGeneration(ctx, callerApiKeyId, callerUserId, model, payload, "error", null, null, body.error?.message ?? "upstream error", []);
    writer.abort();
  }
}

// 流式请求同样进历史；图片本地化失败忽略该张，落库失败忽略
async function recordStreamGeneration(
  ctx: AppContext,
  callerApiKeyId: number | null,
  callerUserId: number | null,
  model: string,
  payload: UnifiedPayload,
  status: "ok" | "error",
  channelId: number | null,
  latencyMs: number | null,
  errorMessage: string | null,
  images: { b64?: string; url?: string; revisedPrompt?: string }[],
): Promise<void> {
  try {
    const historyImages: { file: string; revisedPrompt?: string }[] = [];
    if (status === "ok") {
      const timeoutMs = 30_000;
      for (const img of images) {
        const saved = await localizeImage(ctx.deps.env.dataDir, img, timeoutMs);
        if (saved) historyImages.push({ file: saved.file, ...(img.revisedPrompt !== undefined ? { revisedPrompt: img.revisedPrompt } : {}) });
      }
    }
    ctx.deps.repo.insertGeneration({
      createdAt: Date.now(),
      apiKeyId: callerApiKeyId,
      userId: callerUserId,
      model,
      prompt: (payload as UnifiedGenRequest).prompt,
      params: JSON.stringify({ n: payload.n, size: payload.size, quality: (payload as UnifiedGenRequest).quality, responseFormat: payload.responseFormat }),
      status,
      channelId,
      latencyMs,
      errorMessage,
      images: JSON.stringify(historyImages),
    });
  } catch {
    // 忽略
  }
}
