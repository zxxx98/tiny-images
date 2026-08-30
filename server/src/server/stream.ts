import { ModelNotFoundError, toOpenAIError } from "../core/errors.js";
import type { UnifiedEditRequest, UnifiedGenRequest } from "../core/types.js";
import { conformImages, localizeImage } from "../media/b64cache.js";
import type { AppContext } from "../app.js";
import { toDataItem, toImagesResponse } from "./generations.js";
import { sseReply } from "./sse.js";

type UnifiedPayload = UnifiedGenRequest | UnifiedEditRequest;

export async function streamImageFlow(
  ctx: AppContext,
  req: { callerApiKeyId?: number | null },
  reply: Parameters<typeof sseReply>[0],
  model: string,
  kind: "generate" | "edit",
  payload: UnifiedPayload,
  fileBaseUrl: string,
): Promise<void> {
  // 路由错误发生在流开始前，仍以 JSON 错误返回
  const route = ctx.deps.router.resolve(model);
  if (!route) throw new ModelNotFoundError(model);

  reply.hijack();
  const writer = sseReply(reply);
  const stopHeartbeat = writer.startHeartbeat(() => writer.send({ type: "progress", message: "generating" }));
  writer.send({ type: "status", stage: "submitted" });
  const callerApiKeyId = req.callerApiKeyId ?? null;
  try {
    const r =
      kind === "generate"
        ? await ctx.deps.executor.generate(model, payload as UnifiedGenRequest, { callerApiKeyId })
        : await ctx.deps.executor.edit(model, payload as UnifiedEditRequest, { callerApiKeyId });
    const images = await conformImages({
      images: r.result.images,
      wanted: payload.responseFormat,
      dataDir: ctx.deps.env.dataDir,
      fileBaseUrl,
      fetchTimeoutMs: r.channel.timeoutMs,
    });
    images.forEach((img, index) => writer.send({ type: "image", index, ...toDataItem(img) }));
    writer.send({ type: "completed", ...toImagesResponse(r.result, images) });
    await recordStreamGeneration(ctx, callerApiKeyId, model, payload, "ok", r.channel.id, r.latencyMs, null, images);
    stopHeartbeat();
    writer.end();
  } catch (err) {
    stopHeartbeat();
    const { body } = toOpenAIError(err);
    writer.send({ type: "error", error: body.error });
    await recordStreamGeneration(ctx, callerApiKeyId, model, payload, "error", null, null, body.error?.message ?? "upstream error", []);
    writer.abort();
  }
}

// 流式请求同样进历史；图片本地化失败忽略该张，落库失败忽略
async function recordStreamGeneration(
  ctx: AppContext,
  callerApiKeyId: number | null,
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
      model,
      prompt: (payload as UnifiedGenRequest).prompt,
      params: JSON.stringify({ n: payload.n, size: payload.size, quality: payload.quality, responseFormat: payload.responseFormat }),
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
