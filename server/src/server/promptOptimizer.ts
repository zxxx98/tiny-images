import type { AppContext } from "../app.js";
import { httpError } from "../core/errors.js";
import { requireBody } from "./admin.js";
import { assertValidOptimizePrompt, optimizePrompt, translatePrompt, type PromptTranslateTarget } from "../core/promptOptimizer.js";

export function registerPromptOptimizer(ctx: AppContext): void {
  ctx.app.post("/v1/prompt/optimize", { preHandler: ctx.requireUser }, async (req) => {
    const body = requireBody(req);
    const prompt = assertValidOptimizePrompt(typeof body.prompt === "string" ? body.prompt : "");
    const optimized = await optimizePrompt({ config: ctx.deps.repo.getAppSettings().promptOptimizer, prompt });
    return { prompt: optimized };
  });

  ctx.app.post("/v1/prompt/translate", { preHandler: ctx.requireUser }, async (req) => {
    const body = requireBody(req);
    const prompt = assertValidOptimizePrompt(typeof body.prompt === "string" ? body.prompt : "");
    let target: PromptTranslateTarget | undefined;
    if (body.target !== undefined) {
      if (body.target !== "en" && body.target !== "zh") throw httpError(400, "'target' must be 'en' or 'zh'");
      target = body.target;
    }
    return translatePrompt({ config: ctx.deps.repo.getAppSettings().promptOptimizer, prompt, target });
  });
}
