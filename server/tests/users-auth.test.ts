import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { Executor } from "../src/core/executor.js";
import { hashPassword } from "../src/core/password.js";
import { KeyPool } from "../src/core/keyPool.js";
import { ModelRouter } from "../src/core/router.js";
import { OpenAICompatProvider } from "../src/providers/openai-compat.js";
import { openDb } from "../src/store/db.js";
import { Repo } from "../src/store/repo.js";

let dir: string;
let repo: Repo;
let app: Awaited<ReturnType<typeof buildApp>>;
let H: { authorization: string };

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "au-"));
  repo = new Repo(openDb(dir));
  repo.createUser({ email: "admin@local", passwordHash: hashPassword("admin-pass"), role: "admin", quotaTotal: null });
  repo.createUser({ email: "u@x.com", passwordHash: hashPassword("user-pass"), role: "user", quotaTotal: 10 });
  const provider = new OpenAICompatProvider();
  const router = new ModelRouter(repo);
  const keyPool = new KeyPool(repo);
  const providers = new Map([["openai-compat", provider]]);
  app = await buildApp({
    env: { port: 0, dataDir: dir, publicBaseUrl: null },
    repo,
    router,
    keyPool,
    providers,
    executor: new Executor({ router, keyPool, providers, repo }),
    logger: false,
    webDist: null,
  });
  const login = await app.inject({ method: "POST", url: "/admin/auth/login", payload: { email: "admin@local", password: "admin-pass" } });
  H = { authorization: `Bearer ${(login.json() as { token: string }).token}` };
});
afterEach(async () => {
  await app.close();
  repo.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function login(email: string, password: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await app.inject({ method: "POST", url: "/admin/auth/login", payload: { email, password } });
  return { status: res.statusCode, json: res.json() as Record<string, unknown> };
}

describe("POST /admin/auth/login", () => {
  it("ok → token", async () => {
    const r = await login("u@x.com", "user-pass");
    expect(r.status).toBe(200);
    expect(r.json.role).toBe("user");
    expect(typeof r.json.token).toBe("string");
  });
  it("wrong password / unknown email / disabled user → 401", async () => {
    expect((await login("u@x.com", "nope")).status).toBe(401);
    expect((await login("nobody@x.com", "user-pass")).status).toBe(401);
    const u = repo.getUserByEmail("u@x.com")!;
    repo.updateUser(u.id, { enabled: false });
    expect((await login("u@x.com", "user-pass")).status).toBe(401);
    repo.updateUser(u.id, { enabled: true });
  });
  it("bad body → 400", async () => {
    const res = await app.inject({ method: "POST", url: "/admin/auth/login", payload: { email: "u@x.com" } });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /admin/auth/me", () => {
  it("user token → quota info", async () => {
    const { json } = await login("u@x.com", "user-pass");
    const res = await app.inject({ url: "/admin/auth/me", headers: { authorization: `Bearer ${json.token}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ role: "user", email: "u@x.com", quotaTotal: 10, quotaUsed: 0, quotaRemaining: 10 });
  });
  it("admin JWT me → account info", async () => {
    const res = await app.inject({ url: "/admin/auth/me", headers: H });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ role: "admin", email: "admin@local", quotaRemaining: null });
  });
  it("no token → 401", async () => {
    expect((await app.inject({ url: "/admin/auth/me" })).statusCode).toBe(401);
  });
});

describe("first-run setup", () => {
  it("needed=true when no users, create admin, then needed=false", async () => {
    // 本测试文件 beforeEach 已建了两个用户 → 走新建库验证
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "su-"));
    const repo2 = new Repo(openDb(dir2));
    const provider = new OpenAICompatProvider();
    const router = new ModelRouter(repo2);
    const keyPool = new KeyPool(repo2);
    const providers = new Map([["openai-compat", provider]]);
    const app2 = await buildApp({
      env: { port: 0, dataDir: dir2, publicBaseUrl: null },
      repo: repo2, router, keyPool, providers,
      executor: new Executor({ router, keyPool, providers, repo: repo2 }),
      logger: false, webDist: null,
    });
    try {
      const s1 = await app2.inject({ url: "/admin/auth/setup" });
      expect(s1.json().needed).toBe(true);
      const created = await app2.inject({ method: "POST", url: "/admin/auth/setup", payload: { email: "first@x.com", password: "secret1" } });
      expect(created.statusCode).toBe(201);
      const body = created.json();
      expect(body.role).toBe("admin");
      // 创建后：needed=false、重复创建 409、返回的 token 直接可用
      expect((await app2.inject({ url: "/admin/auth/setup" })).json().needed).toBe(false);
      expect((await app2.inject({ method: "POST", url: "/admin/auth/setup", payload: { email: "x@x.com", password: "secret1" } })).statusCode).toBe(409);
      expect((await app2.inject({ url: "/admin/auth/me", headers: { authorization: `Bearer ${body.token}` } })).statusCode).toBe(200);
      expect((await app2.inject({ method: "POST", url: "/admin/auth/setup", payload: { email: "bad", password: "secret1" } })).statusCode).toBe(409);
    } finally {
      await app2.close();
      repo2.close();
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  });
});

describe("role guard", () => {
  it("user JWT cannot call admin API", async () => {
    const { json } = await login("u@x.com", "user-pass");
    const res = await app.inject({ url: "/admin/channels", headers: { authorization: `Bearer ${json.token}` } });
    expect(res.statusCode).toBe(403);
  });
  it("admin JWT can call admin API", async () => {
    const { json } = await login("admin@local", "admin-pass");
    const res = await app.inject({ url: "/admin/whoami", headers: { authorization: `Bearer ${json.token}` } });
    expect(res.statusCode).toBe(200);
  });
});

describe("PUT /admin/auth/password", () => {
  it("change password then re-login", async () => {
    const { json } = await login("u@x.com", "user-pass");
    const auth = { authorization: `Bearer ${json.token}` };
    const bad = await app.inject({ method: "PUT", url: "/admin/auth/password", headers: auth, payload: { oldPassword: "wrong", newPassword: "new-pass-1" } });
    expect(bad.statusCode).toBe(400);
    const ok = await app.inject({ method: "PUT", url: "/admin/auth/password", headers: auth, payload: { oldPassword: "user-pass", newPassword: "new-pass-1" } });
    expect(ok.statusCode).toBe(204);
    expect((await login("u@x.com", "new-pass-1")).status).toBe(200);
    expect((await login("u@x.com", "user-pass")).status).toBe(401);
  });
});
