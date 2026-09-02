import type { AppContext } from "../app.js";
import { requireBody } from "./admin.js";
import { assertValidOptimizePrompt, optimizePrompt } from "../core/promptOptimizer.js";

export function registerPromptOptimizer(ctx: AppContext): void {
  ctx.app.post("/v1/prompt/optimize", { preHandler: ctx.requireUser }, async (req) => {
    const body = requireBody(req);
    const prompt = assertValidOptimizePrompt(typeof body.prompt === "string" ? body.prompt : "");
    const optimized = await optimizePrompt({ config: ctx.deps.repo.getAppSettings().promptOptimizer, prompt });
    return { prompt: optimized };
  });
}
