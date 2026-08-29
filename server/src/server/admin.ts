import type { AppContext } from "../app.js";

export function registerAdmin(ctx: AppContext): void {
  ctx.app.get("/admin/whoami", { preHandler: ctx.requireAdmin }, async () => ({ ok: true }));
}
