import type { FastifyReply, FastifyRequest } from "fastify";
import type { Repo } from "../store/repo.js";

export interface AuthDeps {
  repo: Repo;
  adminToken: string | null;
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
  }
}

function unauthorized(reply: FastifyReply, message: string): void {
  reply.code(401).send({ error: { message, type: "invalid_request_error", code: "invalid_api_key" } });
}

export function makeRequireApiKey(deps: AuthDeps) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const token = bearerOf(req);
    if (deps.adminToken && token === deps.adminToken) {
      req.callerApiKeyId = null;
      return;
    }
    const keys = deps.repo.listApiKeys();
    if (keys.length === 0) {
      req.callerApiKeyId = null;
      return;
    }
    const found = token ? deps.repo.findApiKeyByKey(token) : null;
    if (!found || !found.enabled) {
      unauthorized(reply, "invalid api key");
      return;
    }
    req.callerApiKeyId = found.id;
  };
}

export function makeRequireAdmin(deps: AuthDeps) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!deps.adminToken) {
      const ip = req.ip ?? "";
      const loopback = ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
      if (loopback) return;
      reply.code(401).send({
        error: { message: "ADMIN_TOKEN not configured; admin API restricted to localhost", type: "invalid_request_error", code: null },
      });
      return;
    }
    if (bearerOf(req) !== deps.adminToken) {
      reply.code(401).send({ error: { message: "invalid admin token", type: "invalid_request_error", code: null } });
    }
  };
}
