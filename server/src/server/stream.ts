import { ModelNotFoundError, toOpenAIError } from "../core/errors.js";
import type { UnifiedEditRequest, UnifiedGenRequest } from "../core/types.js";
import { conformImages } from "../media/b64cache.js";
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
    stopHeartbeat();
    writer.end();
  } catch (err) {
    stopHeartbeat();
    const { body } = toOpenAIError(err);
    writer.send({ type: "error", error: body.error });
    writer.abort();
  }
}
