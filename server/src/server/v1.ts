import type { AppContext } from "../app.js";
import { registerGenerations } from "./generations.js";
import { registerEdits } from "./edits.js";
import { registerVariations } from "./variations.js";
import { registerHistory } from "./history.js";
import { registerPlaza } from "./plaza.js";
import { buildModelHealth } from "./modelHealth.js";
import { registerUpscale } from "./upscale.js";
import { modelAllowedByPolicy } from "../core/router.js";

export function registerV1(ctx: AppContext): void {
  ctx.app.get("/v1/models", { preHandler: ctx.requireApiKey }, async (req) => {
    const policy = ctx.deps.repo.modelAccessPolicy(req.callerUserId ?? null);
    const seen = new Set<string>();
    const models = ctx.deps.repo
      .listEnabledModels()
      .filter((m) => modelAllowedByPolicy(m, policy))
      .filter((m) => ctx.deps.repo.getChannel(m.channelId)?.enabled === true)
      .filter((m) => (seen.has(m.publicName) ? false : (seen.add(m.publicName), true)));
    return {
      object: "list",
      data: models.map((m) => ({
        id: m.publicName,
        object: "model",
        owned_by: "tiny-images",
        ...(m.supportsImageToImage ? { supportsImageToImage: true } : {}),
      })),
    };
  });
  ctx.app.get("/v1/model-health", { preHandler: ctx.requireUser }, async (req) => {
    const policy = ctx.deps.repo.modelAccessPolicy(req.callerUserId ?? null);
    return buildModelHealth(ctx.deps.repo, ctx.deps.router, policy);
  });
  registerGenerations(ctx);
  registerEdits(ctx);
  registerVariations(ctx);
  registerHistory(ctx);
  registerPlaza(ctx);
  registerUpscale(ctx);
  // 流式（Task 12）在后续接入
}
