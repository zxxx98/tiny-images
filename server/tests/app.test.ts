import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadEnv } from "../src/env.js";
import { Executor } from "../src/core/executor.js";
import { hashPassword } from "../src/core/password.js";
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

async function app() {
  const router = new ModelRouter(repo);
  const keyPool = new KeyPool(repo);
  return buildApp({
    env: { ...env },
    repo,
    router,
    keyPool,
    provider,
    executor: new Executor({ router, keyPool, provider, repo }),
    logger: false,
    webDist: null,
  });
}

// 创建 admin 用户并登录，返回 JWT 请求头
async function adminAuth(a: Awaited<ReturnType<typeof app>>): Promise<{ authorization: string }> {
  repo.createUser({ email: "admin@local", passwordHash: hashPassword("admin-pass"), role: "admin", quotaTotal: null });
  const res = await a.inject({ method: "POST", url: "/admin/auth/login", payload: { email: "admin@local", password: "admin-pass" } });
  return { authorization: `Bearer ${(res.json() as { token: string }).token}` };
}

async function userAuth(a: Awaited<ReturnType<typeof app>>): Promise<{ authorization: string }> {
  repo.createUser({ email: "u@x.com", passwordHash: hashPassword("user-pass"), role: "user", quotaTotal: 10 });
  const res = await a.inject({ method: "POST", url: "/admin/auth/login", payload: { email: "u@x.com", password: "user-pass" } });
  return { authorization: `Bearer ${(res.json() as { token: string }).token}` };
}

describe("health", () => {
  it("returns ok", async () => {
    const a = await app();
    expect((await a.inject({ url: "/health" })).json()).toEqual({ ok: true });
    await a.close();
  });
});

describe("requireApiKey", () => {
  it("open mode when no api keys", async () => {
    const a = await app();
    expect((await a.inject({ url: "/v1/models" })).statusCode).toBe(200);
    await a.close();
  });
  it("rejects bad bearer when keys exist", async () => {
    repo.createApiKey("k1");
    const a = await app();
    const res = await a.inject({ url: "/v1/models", headers: { authorization: "Bearer wrong" } });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.type).toBe("invalid_request_error");
    expect(res.json().error.code).toBe("invalid_api_key");
    await a.close();
  });
  it("accepts valid key and admin/user JWT", async () => {
    const k = repo.createApiKey("k1");
    const a = await app();
    expect((await a.inject({ url: "/v1/models", headers: { authorization: `Bearer ${k.key}` } })).statusCode).toBe(200);
    expect((await a.inject({ url: "/v1/models", headers: await adminAuth(a) })).statusCode).toBe(200);
    expect((await a.inject({ url: "/v1/models", headers: await userAuth(a) })).statusCode).toBe(200);
    await a.close();
  });
  it("rejects JWT of disabled user", async () => {
    repo.createUser({ email: "d@x.com", passwordHash: hashPassword("user-pass"), role: "user", quotaTotal: 1 });
    const a = await app();
    const res = await a.inject({ method: "POST", url: "/admin/auth/login", payload: { email: "d@x.com", password: "user-pass" } });
    const token = (res.json() as { token: string }).token;
    repo.updateUser(repo.getUserByEmail("d@x.com")!.id, { enabled: false });
    expect((await a.inject({ url: "/v1/models", headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(401);
    await a.close();
  });
});

describe("requireAdmin", () => {
  it("accepts only admin JWT", async () => {
    const a = await app();
    expect((await a.inject({ url: "/admin/whoami" })).statusCode).toBe(401);
    expect((await a.inject({ url: "/admin/whoami", headers: await adminAuth(a) })).statusCode).toBe(200);
    expect((await a.inject({ url: "/admin/whoami", headers: await userAuth(a) })).statusCode).toBe(403);
    expect((await a.inject({ url: "/admin/whoami", headers: { authorization: "Bearer nope" } })).statusCode).toBe(401);
    await a.close();
  });
});

describe("not found", () => {
  it("returns openai error body under api prefixes", async () => {
    const a = await app();
    const res = await a.inject({ url: "/v1/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.type).toBe("invalid_request_error");
    await a.close();
  });
});
