import type { AppContext } from "../app.js";
import { registerGenerations } from "./generations.js";
import { registerEdits } from "./edits.js";

export function registerV1(ctx: AppContext): void {
  ctx.app.get("/v1/models", { preHandler: ctx.requireApiKey }, async () => {
    const models = ctx.deps.repo.listEnabledModels();
    return {
      object: "list",
      data: models.map((m) => ({ id: m.publicName, object: "model", owned_by: "tiny-images" })),
    };
  });
  registerGenerations(ctx);
  registerEdits(ctx);
  // 流式（Task 12）在后续接入
}
