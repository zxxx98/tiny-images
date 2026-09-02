import type { AppContext } from "../app.js";
import { httpError } from "../core/errors.js";
import { PROMPT_MAX_LENGTH } from "../core/promptOptimizer.js";
import { requireBody } from "./admin.js";

// 提示词收藏夹：仅 Web 登录用户可用，数据按用户隔离
export function registerPromptFavorites(ctx: AppContext): void {
  ctx.app.get("/v1/prompt-favorites", { preHandler: ctx.requireUser }, async (req) => {
    return ctx.deps.repo.listPromptFavorites(req.callerUserId!);
  });

  ctx.app.post("/v1/prompt-favorites", { preHandler: ctx.requireUser }, async (req, reply) => {
    const body = requireBody(req);
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    if (!prompt) throw httpError(400, "'prompt' is required");
    if (prompt.length > PROMPT_MAX_LENGTH) throw httpError(400, `'prompt' must be at most ${PROMPT_MAX_LENGTH} characters`);
    return await reply.code(201).send(ctx.deps.repo.insertPromptFavorite(req.callerUserId!, prompt));
  });

  ctx.app.delete("/v1/prompt-favorites/:id", { preHandler: ctx.requireUser }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) throw httpError(400, "'id' must be an integer");
    if (!ctx.deps.repo.deletePromptFavorite(id, req.callerUserId!)) throw httpError(404, "favorite not found");
    return await reply.code(204).send();
  });
}
