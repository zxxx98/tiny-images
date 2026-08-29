import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadEnv } from "../src/env.js";
import { Executor } from "../src/core/executor.js";
import { KeyPool } from "../src/core/keyPool.js";
import { ModelRouter } from "../src/core/router.js";
import type { ImageProvider } from "../src/core/types.js";
import { openDb } from "../src/store/db.js";
import { Repo } from "../src/store/repo.js";

const provider: ImageProvider = {
  kind: "fake",
  async generate() {
    throw new Error("not used");
  },
  async edit() {
    throw new Error("not used");
  },
  async test() {
    return { ok: true, message: "" };
  },
};

let repo: Repo;
let env: ReturnType<typeof loadEnv>;
let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-"));
  env = { ...loadEnv({}), dataDir: dir };
  repo = new Repo(openDb(dir));
});

async function app(adminToken: string | null) {
  const router = new ModelRouter(repo);
  const keyPool = new KeyPool(repo);
  return buildApp({
    env: { ...env, adminToken },
    repo,
    router,
    keyPool,
    provider,
    executor: new Executor({ router, keyPool, provider, repo }),
    logger: false,
    webDist: null,
  });
}

describe("health", () => {
  it("returns ok", async () => {
    const a = await app(null);
    expect((await a.inject({ url: "/health" })).json()).toEqual({ ok: true });
    await a.close();
  });
});

describe("requireApiKey", () => {
  it("open mode when no api keys", async () => {
    const a = await app(null);
    expect((await a.inject({ url: "/v1/models" })).statusCode).toBe(200);
    await a.close();
  });
  it("rejects bad bearer when keys exist", async () => {
    repo.createApiKey("k1");
    const a = await app(null);
    const res = await a.inject({ url: "/v1/models", headers: { authorization: "Bearer wrong" } });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.type).toBe("invalid_request_error");
    expect(res.json().error.code).toBe("invalid_api_key");
    await a.close();
  });
  it("accepts valid key and admin token", async () => {
    const k = repo.createApiKey("k1");
    const a = await app("admin-secret");
    expect((await a.inject({ url: "/v1/models", headers: { authorization: `Bearer ${k.key}` } })).statusCode).toBe(200);
    expect((await a.inject({ url: "/v1/models", headers: { authorization: "Bearer admin-secret" } })).statusCode).toBe(200);
    await a.close();
  });
});

describe("requireAdmin", () => {
  it("with token requires matching bearer", async () => {
    const a = await app("secret");
    expect((await a.inject({ url: "/admin/whoami" })).statusCode).toBe(401);
    expect((await a.inject({ url: "/admin/whoami", headers: { authorization: "Bearer secret" } })).statusCode).toBe(200);
    expect((await a.inject({ url: "/admin/whoami", headers: { authorization: "Bearer nope" } })).statusCode).toBe(401);
    await a.close();
  });
  it("without token allows loopback only", async () => {
    const b = await app(null);
    // fastify.inject 默认 remoteAddress 为 127.0.0.1 → loopback 放行
    expect((await b.inject({ url: "/admin/whoami" })).statusCode).toBe(200);
    await b.close();
  });
});

describe("not found", () => {
  it("returns openai error body under api prefixes", async () => {
    const a = await app(null);
    const res = await a.inject({ url: "/v1/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.type).toBe("invalid_request_error");
    await a.close();
  });
});
