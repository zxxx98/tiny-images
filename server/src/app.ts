import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import fs from "node:fs";
import path from "node:path";
import type { Env } from "./env.js";
import type { Executor } from "./core/executor.js";
import type { KeyPool } from "./core/keyPool.js";
import type { ImageProvider } from "./core/types.js";
import type { ModelRouter } from "./core/router.js";
import { toOpenAIError } from "./core/errors.js";
import type { Repo } from "./store/repo.js";
import { makeRequireAdmin, makeRequireApiKey, makeRequireUser } from "./server/auth.js";
import { registerAuthRoutes } from "./server/authRoutes.js";
import { resolveJwtSecret } from "./env.js";
import { registerV1 } from "./server/v1.js";
import { registerAdmin } from "./server/admin.js";
import { registerFiles } from "./server/files.js";
import type { JobManager } from "./server/jobs.js";
import { registerSettings } from "./server/settings.js";

export interface AppDeps {
  env: Env;
  repo: Repo;
  router: ModelRouter;
  keyPool: KeyPool;
  provider: ImageProvider;
  executor: Executor;
  jobManager: JobManager;
  logger?: boolean;
  webDist?: string | null;
}

export interface AppContext {
  app: FastifyInstance;
  deps: AppDeps;
  requireApiKey: ReturnType<typeof makeRequireApiKey>;
  requireAdmin: ReturnType<typeof makeRequireAdmin>;
  requireUser: ReturnType<typeof makeRequireUser>;
}

const API_PREFIXES = ["/v1", "/admin", "/files"];

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: deps.logger ?? false,
    bodyLimit: 16 * 1024 * 1024,
  });

  await app.register(multipart, {
    limits: { fileSize: 50 * 1024 * 1024, files: 6 },
  });

  // 带 content-type: application/json 但无 body 的请求按 {} 解析，
  // 避免 Fastify 默认的 "Body cannot be empty when content-type is set" 报错
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_req, body: string, done) => {
      if (body === undefined || body.trim() === "") return done(null, {});
      try {
        done(null, JSON.parse(body));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  const jwtSecret = resolveJwtSecret(deps.env.dataDir, deps.env.jwtSecret ?? null);
  const authDeps = { repo: deps.repo, jwtSecret };
  const requireApiKey = makeRequireApiKey(authDeps);
  const requireAdmin = makeRequireAdmin(authDeps);
  const requireUser = makeRequireUser(authDeps);
  const ctx: AppContext = { app, deps, requireApiKey, requireAdmin, requireUser };

  app.get("/health", async () => ({ ok: true }));

  // 路由注册：
  registerAuthRoutes(ctx, jwtSecret);
  registerV1(ctx);
  registerAdmin(ctx);
  registerSettings(ctx);
  registerFiles(ctx);

  app.setErrorHandler((err, _req, reply) => {
    const { status, body } = toOpenAIError(err);
    reply.code(status).send(body);
  });

  const webDist = deps.webDist ?? path.resolve(deps.env.dataDir, "..", "web", "dist");
  const hasWeb = webDist && fs.existsSync(path.join(webDist, "index.html"));
  if (hasWeb) {
    await app.register(fastifyStatic, { root: webDist });
  }

  app.setNotFoundHandler((req, reply) => {
    const url = req.raw.url ?? "/";
    // /admin 是前端 SPA 路由，浏览器直达/刷新时回落到 index.html；其余 API 前缀保持 JSON 404
    if (req.method === "GET" && (url === "/admin" || url === "/admin/") && hasWeb) {
      reply.type("text/html").sendFile("index.html");
      return;
    }
    if (API_PREFIXES.some((p) => url === p || url.startsWith(`${p}/`) || url.startsWith(`${p}?`))) {
      reply.code(404).send({ error: { message: `not found: ${req.method} ${url}`, type: "invalid_request_error", code: null } });
      return;
    }
    if (hasWeb) {
      reply.type("text/html").sendFile("index.html");
      return;
    }
    reply.code(404).send({ error: { message: `not found: ${req.method} ${url}`, type: "invalid_request_error", code: null } });
  });

  return app;
}
