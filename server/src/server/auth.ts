import type { FastifyReply, FastifyRequest } from "fastify";
import { verifyJwt } from "../core/jwt.js";
import type { Repo } from "../store/repo.js";

export interface AuthDeps {
  repo: Repo;
  jwtSecret?: string | null;
}

export function bearerOf(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice(7).trim();
  return token || null;
}

declare module "fastify" {
  interface FastifyRequest {
    callerApiKeyId?: number | null;
    callerUserId?: number | null;
    callerRole?: "admin" | "user" | null;
  }
}

function unauthorized(reply: FastifyReply, message: string): void {
  reply.code(401).send({ error: { message, type: "invalid_request_error", code: "invalid_api_key" } });
}

function forbidden(reply: FastifyReply, message: string): void {
  reply.code(403).send({ error: { message, type: "invalid_request_error", code: null } });
}

function userFromJwt(deps: AuthDeps, token: string | null): { uid: number; role: "admin" | "user" } | null {
  if (!deps.jwtSecret || !token) return null;
  const payload = verifyJwt(token, deps.jwtSecret);
  return payload ? { uid: payload.uid, role: payload.role } : null;
}

// /v1 与 /files 的鉴权：JWT 或无主 api_key 均视为不挂靠用户（不限渠道、不计额度）
export function makeRequireApiKey(deps: AuthDeps) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const token = bearerOf(req);
    const jwtUser = userFromJwt(deps, token);
    if (jwtUser) {
      const user = deps.repo.getUser(jwtUser.uid);
      if (!user || !user.enabled) {
        unauthorized(reply, "user is disabled or deleted");
        return;
      }
      req.callerApiKeyId = null;
      req.callerUserId = user.id;
      req.callerRole = user.role;
      return;
    }
    const keys = deps.repo.listApiKeys();
    if (keys.length === 0) {
      req.callerApiKeyId = null;
      req.callerUserId = null;
      return;
    }
    const found = token ? deps.repo.findApiKeyByKey(token) : null;
    if (!found || !found.enabled) {
      unauthorized(reply, "invalid api key");
      return;
    }
    req.callerApiKeyId = found.id;
    if (found.userId !== null) {
      const user = deps.repo.getUser(found.userId);
      if (!user || !user.enabled) {
        unauthorized(reply, "user is disabled or deleted");
        return;
      }
      req.callerUserId = user.id;
      req.callerRole = user.role;
    } else {
      req.callerUserId = null;
    }
  };
}

// 管理接口仅接受 role=admin 的用户 JWT
export function makeRequireAdmin(deps: AuthDeps) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const jwtUser = userFromJwt(deps, bearerOf(req));
    if (jwtUser && jwtUser.role === "admin") {
      const user = deps.repo.getUser(jwtUser.uid);
      if (user && user.enabled) {
        req.callerUserId = user.id;
        req.callerRole = "admin";
        return;
      }
    }
    if (jwtUser) {
      const user = deps.repo.getUser(jwtUser.uid);
      if (user && user.enabled) forbidden(reply, "admin privileges required");
      else unauthorized(reply, "user is disabled or deleted");
      return;
    }
    unauthorized(reply, "admin authentication required");
  };
}

// 登录用户自身可用的接口（me / 改密码）
export function makeRequireUser(deps: AuthDeps) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const jwtUser = userFromJwt(deps, bearerOf(req));
    if (jwtUser) {
      const user = deps.repo.getUser(jwtUser.uid);
      if (user && user.enabled) {
        req.callerUserId = user.id;
        req.callerRole = user.role;
        return;
      }
    }
    unauthorized(reply, "authentication required");
  };
}
