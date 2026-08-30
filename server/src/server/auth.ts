import type { FastifyReply, FastifyRequest } from "fastify";
import { verifyJwt } from "../core/jwt.js";
import type { Repo } from "../store/repo.js";

export interface AuthDeps {
  repo: Repo;
  adminToken: string | null;
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

export function makeRequireApiKey(deps: AuthDeps) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const token = bearerOf(req);
    if (deps.adminToken && token === deps.adminToken) {
      req.callerApiKeyId = null;
      req.callerUserId = null;
      req.callerRole = "admin";
      return;
    }
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

export function makeRequireAdmin(deps: AuthDeps) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const token = bearerOf(req);
    if (deps.adminToken && token === deps.adminToken) {
      req.callerUserId = null;
      req.callerRole = "admin";
      return;
    }
    const jwtUser = userFromJwt(deps, token);
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
    if (!deps.adminToken) {
      const ip = req.ip ?? "";
      const loopback = ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
      if (loopback) return;
      reply.code(401).send({
        error: { message: "ADMIN_TOKEN not configured; admin API restricted to localhost", type: "invalid_request_error", code: null },
      });
      return;
    }
    unauthorized(reply, "invalid admin token");
  };
}

// 登录用户自身可用的接口（me / 改密码）。ADMIN_TOKEN 身份 role=admin 但 uid=null。
export function makeRequireUser(deps: AuthDeps) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const token = bearerOf(req);
    if (deps.adminToken && token === deps.adminToken) {
      req.callerUserId = null;
      req.callerRole = "admin";
      return;
    }
    const jwtUser = userFromJwt(deps, token);
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
