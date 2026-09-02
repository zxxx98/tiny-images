import type { AppContext } from "../app.js";
import { httpError } from "../core/errors.js";
import { requireBody } from "./admin.js";
import { assertValidReverseStyle, reverseImagePrompt } from "../core/promptReverse.js";

const IMAGE_MAX_CHARS = 32 * 1024 * 1024; // 约 24 MiB 的 base64 数据
// data URL 走 JSON body，需放宽 Fastify 默认 1MiB 的限制
const BODY_LIMIT = 40 * 1024 * 1024;

export function registerPromptReverse(ctx: AppContext): void {
  ctx.app.post("/v1/prompt/reverse", { preHandler: ctx.requireUser, bodyLimit: BODY_LIMIT }, async (req) => {
    const body = requireBody(req);
    const image = typeof body.image === "string" ? body.image : "";
    if (image.length === 0) throw httpError(400, "'image' is required");
    if (image.length > IMAGE_MAX_CHARS) throw httpError(400, "'image' must be at most 20 MiB");
    const style = assertValidReverseStyle(body.style ?? "detailed");
    const prompt = await reverseImagePrompt({
      settings: ctx.deps.repo.getAppSettings(),
      image,
      style,
    });
    return { prompt };
  });
}
