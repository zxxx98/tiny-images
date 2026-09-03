import { signJwt } from "../core/jwt.js";
import { hashPassword, verifyPassword } from "../core/password.js";
import { httpError } from "../core/errors.js";
import { TurnstileUnavailableError, verifyTurnstileToken } from "../core/turnstile.js";
import type { Env } from "../env.js";
import { ConflictError } from "../store/repo.js";
import type { AppContext } from "../app.js";
import { requireBody, requireStr } from "./admin.js";

// Turnstile 开启时校验 body.turnstileToken（一次性 token，密码校验之前先验，避免绕过验证探测凭据）
async function requireTurnstile(env: Env, b: Record<string, unknown>): Promise<void> {
  const ts = env.turnstile;
  if (!ts?.enabled || !ts.secretKey) return;
  const token = typeof b.turnstileToken === "string" ? b.turnstileToken.trim() : "";
  if (!token) throw httpError(403, "human verification failed");
  try {
    const result = await verifyTurnstileToken({ secretKey: ts.secretKey, token, timeoutMs: ts.timeoutMs });
    if (!result.success) throw httpError(403, "human verification failed");
  } catch (err) {
    if (err instanceof TurnstileUnavailableError) throw httpError(503, err.message);
    throw err;
  }
}

export function registerAuthRoutes(ctx: AppContext, jwtSecret: string): void {
  const repo = ctx.deps.repo;

  // ---- 首次设置（users 表为空时可用，无需登录）----

  ctx.app.get("/admin/auth/setup", async () => ({ needed: repo.listUsers().length === 0 }));

  ctx.app.post("/admin/auth/setup", async (req, reply) => {
    if (repo.listUsers().length > 0) throw httpError(409, "admin account already exists");
    const b = requireBody(req);
    const email = requireStr(b, "email").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw httpError(400, "'email' must be a valid email address");
    const password = requireStr(b, "password");
    if (password.length < 6) throw httpError(400, "'password' must be at least 6 characters");
    const user = repo.createUser({ email, passwordHash: hashPassword(password), role: "admin", quotaTotal: null });
    const token = signJwt({ uid: user.id, role: user.role }, jwtSecret, 7 * 24 * 3600);
    return await reply.code(201).send({ token, role: user.role, email: user.email });
  });

  ctx.app.get("/admin/auth/turnstile", async () => {
    const ts = ctx.deps.env.turnstile;
    return { enabled: !!ts?.enabled, siteKey: ts?.enabled ? ts.siteKey ?? null : null };
  });

  ctx.app.post("/admin/auth/login", async (req) => {
    const b = requireBody(req);
    await requireTurnstile(ctx.deps.env, b);
    const email = requireStr(b, "email").trim().toLowerCase();
    const password = requireStr(b, "password");
    const user = repo.getUserByEmail(email);
    if (!user || !user.enabled || !verifyPassword(password, user.passwordHash)) {
      throw httpError(401, "invalid email or password");
    }
    const token = signJwt({ uid: user.id, role: user.role }, jwtSecret, 7 * 24 * 3600);
    return { token, role: user.role, email: user.email };
  });

  // ---- 用户自助注册（设置页开启后可用，无需登录）----

  ctx.app.get("/admin/auth/register", async () => ({ enabled: repo.getAppSettings().registration.enabled }));

  ctx.app.post("/admin/auth/register", async (req, reply) => {
    const b = requireBody(req);
    await requireTurnstile(ctx.deps.env, b);
    const settings = repo.getAppSettings();
    if (!settings.registration.enabled) throw httpError(403, "user registration is disabled");
    const email = requireStr(b, "email").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw httpError(400, "'email' must be a valid email address");
    const password = requireStr(b, "password");
    if (password.length < 6) throw httpError(400, "'password' must be at least 6 characters");
    let user;
    try {
      user = repo.createUser({
        email,
        passwordHash: hashPassword(password),
        role: "user",
        quotaTotal: settings.registration.dailyQuota,
      });
    } catch (err) {
      if (err instanceof ConflictError) throw httpError(409, `user '${email}' already exists`);
      throw err;
    }
    const token = signJwt({ uid: user.id, role: user.role }, jwtSecret, 7 * 24 * 3600);
    return await reply.code(201).send({ token, role: user.role, email: user.email });
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
