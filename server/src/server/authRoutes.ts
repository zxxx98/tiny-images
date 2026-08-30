import { signJwt } from "../core/jwt.js";
import { hashPassword, verifyPassword } from "../core/password.js";
import { httpError } from "../core/errors.js";
import type { AppContext } from "../app.js";
import { requireBody, requireStr } from "./admin.js";

export function registerAuthRoutes(ctx: AppContext, jwtSecret: string): void {
  const repo = ctx.deps.repo;

  ctx.app.post("/admin/auth/login", async (req) => {
    const b = requireBody(req);
    const email = requireStr(b, "email").trim().toLowerCase();
    const password = requireStr(b, "password");
    const user = repo.getUserByEmail(email);
    if (!user || !user.enabled || !verifyPassword(password, user.passwordHash)) {
      throw httpError(401, "invalid email or password");
    }
    const token = signJwt({ uid: user.id, role: user.role }, jwtSecret, 7 * 24 * 3600);
    return { token, role: user.role, email: user.email };
  });

  ctx.app.get("/admin/auth/me", { preHandler: ctx.requireUser }, async (req) => {
    if (req.callerRole === "admin" && !req.callerUserId) {
      return { role: "admin", email: "admin-token", quotaTotal: null, quotaUsed: 0, quotaRemaining: null };
    }
    const user = repo.getUser(req.callerUserId!);
    if (!user) throw httpError(401, "user not found");
    return {
      role: user.role,
      email: user.email,
      quotaTotal: user.quotaTotal,
      quotaUsed: user.quotaUsed,
      quotaRemaining: user.quotaTotal === null ? null : Math.max(0, user.quotaTotal - user.quotaUsed),
    };
  });

  ctx.app.put("/admin/auth/password", { preHandler: ctx.requireUser }, async (req, reply) => {
    if (!req.callerUserId) throw httpError(400, "admin-token identity has no password");
    const b = requireBody(req);
    const oldPassword = requireStr(b, "oldPassword");
    const newPassword = requireStr(b, "newPassword");
    if (newPassword.length < 6) throw httpError(400, "'newPassword' must be at least 6 characters");
    const user = repo.getUser(req.callerUserId)!;
    if (!verifyPassword(oldPassword, user.passwordHash)) throw httpError(400, "old password is incorrect");
    repo.updateUser(user.id, { passwordHash: hashPassword(newPassword) });
    return await reply.code(204).send();
  });
}
