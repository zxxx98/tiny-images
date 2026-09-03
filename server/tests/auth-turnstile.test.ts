import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { Executor } from "../src/core/executor.js";
import { hashPassword } from "../src/core/password.js";
import { KeyPool } from "../src/core/keyPool.js";
import { ModelRouter } from "../src/core/router.js";
import { SITEVERIFY_URL } from "../src/core/turnstile.js";
import type { TurnstileEnv } from "../src/env.js";
import { OpenAICompatProvider } from "../src/providers/openai-compat.js";
import { openDb } from "../src/store/db.js";
import { Repo } from "../src/store/repo.js";

let dir: string;
let repo: Repo;
let app: Awaited<ReturnType<typeof buildApp>>;
const originalFetch = globalThis.fetch;

const enabled: TurnstileEnv = { enabled: true, siteKey: "site-key", secretKey: "secret-key", timeoutMs: 1_000 };

// 拦截 siteverify 调用；其他 URL 一律 599，避免测试里意外打到外网
function mockSiteverify(result: { success?: boolean; status?: number; networkError?: boolean } = {}): void {
  const siteverify = vi.fn(async (url: unknown, init?: { body?: unknown }) => {
    if (String(url) !== SITEVERIFY_URL) return new Response("unexpected upstream", { status: 599 });
    if (result.networkError) throw new Error("connection refused");
    if (result.status) return new Response("boom", { status: result.status });
    const body = String(init?.body ?? "");
    expect(body).toContain("secret=secret-key");
    expect(body).toContain("response=good-token");
    const success = result.success ?? true;
    return new Response(JSON.stringify({ success, "error-codes": success ? [] : ["invalid-input-response"] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  globalThis.fetch = siteverify as unknown as typeof fetch;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tsv-"));
  repo = new Repo(openDb(dir));
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await app.close();
  repo.close();
  fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function start(turnstile?: TurnstileEnv): Promise<void> {
  repo.createUser({ email: "admin@local", passwordHash: hashPassword("admin-pass"), role: "admin", quotaTotal: null });
  const provider = new OpenAICompatProvider();
  const router = new ModelRouter(repo);
  const keyPool = new KeyPool(repo);
  const providers = new Map([["openai-compat", provider]]);
  app = await buildApp({
    env: { port: 0, dataDir: dir, publicBaseUrl: null, ...(turnstile ? { turnstile } : {}) },
    repo,
    router,
    keyPool,
    providers,
    executor: new Executor({ router, keyPool, providers, repo }),
    logger: false,
    webDist: null,
  });
}

describe("when Turnstile is not configured", () => {
  it("config endpoint reports disabled and login works without a token", async () => {
    await start();
    const cfg = await app.inject({ url: "/admin/auth/turnstile" });
    expect(cfg.json()).toEqual({ enabled: false, siteKey: null });
    const login = await app.inject({ method: "POST", url: "/admin/auth/login", payload: { email: "admin@local", password: "admin-pass" } });
    expect(login.statusCode).toBe(200);
  });
});

describe("when Turnstile is enabled", () => {
  beforeEach(() => {
    mockSiteverify({ success: true });
  });

  it("config endpoint exposes the site key only", async () => {
    await start(enabled);
    const cfg = await app.inject({ url: "/admin/auth/turnstile" });
    expect(cfg.json()).toEqual({ enabled: true, siteKey: "site-key" });
  });

  it("login without a token → 403 without calling siteverify", async () => {
    await start(enabled);
    const res = await app.inject({ method: "POST", url: "/admin/auth/login", payload: { email: "admin@local", password: "admin-pass" } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toBe("human verification failed");
  });

  it("login with a verified token → JWT issued", async () => {
    await start(enabled);
    const res = await app.inject({
      method: "POST",
      url: "/admin/auth/login",
      payload: { email: "admin@local", password: "admin-pass", turnstileToken: "good-token" },
    });
    expect(res.statusCode).toBe(200);
    expect(typeof res.json().token).toBe("string");
  });

  it("login with a rejected token → 403", async () => {
    mockSiteverify({ success: false });
    await start(enabled);
    const res = await app.inject({
      method: "POST",
      url: "/admin/auth/login",
      payload: { email: "admin@local", password: "admin-pass", turnstileToken: "good-token" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toBe("human verification failed");
  });

  it("siteverify unreachable → 503 (fail closed)", async () => {
    mockSiteverify({ networkError: true });
    await start(enabled);
    const res = await app.inject({
      method: "POST",
      url: "/admin/auth/login",
      payload: { email: "admin@local", password: "admin-pass", turnstileToken: "good-token" },
    });
    expect(res.statusCode).toBe(503);
  });

  it("siteverify non-200 → 503 (fail closed)", async () => {
    mockSiteverify({ status: 500 });
    await start(enabled);
    const res = await app.inject({
      method: "POST",
      url: "/admin/auth/login",
      payload: { email: "admin@local", password: "admin-pass", turnstileToken: "good-token" },
    });
    expect(res.statusCode).toBe(503);
  });

  it("captcha passes but wrong password → still 401", async () => {
    await start(enabled);
    const res = await app.inject({
      method: "POST",
      url: "/admin/auth/login",
      payload: { email: "admin@local", password: "nope", turnstileToken: "good-token" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("register requires a token and succeeds with one", async () => {
    await start(enabled);
    const adminLogin = await app.inject({
      method: "POST",
      url: "/admin/auth/login",
      payload: { email: "admin@local", password: "admin-pass", turnstileToken: "good-token" },
    });
    const H = { authorization: `Bearer ${adminLogin.json().token}` };
    const put = await app.inject({
      method: "PUT",
      url: "/admin/settings",
      headers: H,
      payload: { globalPrompt: "", announcement: "", registration: { enabled: true, dailyQuota: 5 } },
    });
    expect(put.statusCode).toBe(200);
    const blocked = await app.inject({ method: "POST", url: "/admin/auth/register", payload: { email: "u1@x.com", password: "secret1" } });
    expect(blocked.statusCode).toBe(403);
    const ok = await app.inject({
      method: "POST",
      url: "/admin/auth/register",
      payload: { email: "u1@x.com", password: "secret1", turnstileToken: "good-token" },
    });
    expect(ok.statusCode).toBe(201);
  });
});
