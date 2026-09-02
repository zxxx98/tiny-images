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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "reg-"));
  repo = new Repo(openDb(dir));
  repo.createUser({ email: "admin@local", passwordHash: hashPassword("admin-pass"), role: "admin", quotaTotal: null });
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

async function enableRegistration(dailyQuota = 30): Promise<void> {
  const res = await app.inject({ method: "PUT", url: "/admin/settings", headers: H, payload: { globalPrompt: "", announcement: "", registration: { enabled: true, dailyQuota } } });
  expect(res.statusCode).toBe(200);
}

describe("GET /admin/auth/register", () => {
  it("reports disabled by default and follows the settings toggle", async () => {
    expect((await app.inject({ url: "/admin/auth/register" })).json()).toEqual({ enabled: false });
    await enableRegistration();
    expect((await app.inject({ url: "/admin/auth/register" })).json()).toEqual({ enabled: true });
  });
});

describe("POST /admin/auth/register", () => {
  it("403 while registration is disabled", async () => {
    const res = await app.inject({ method: "POST", url: "/admin/auth/register", payload: { email: "new@x.com", password: "secret1" } });
    expect(res.statusCode).toBe(403);
    expect(repo.getUserByEmail("new@x.com")).toBeNull();
  });

  it("creates a user with the default daily quota of 30 and returns a working token", async () => {
    await enableRegistration();
    const res = await app.inject({ method: "POST", url: "/admin/auth/register", payload: { email: "New@X.com", password: "secret1" } });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { token: string; role: string; email: string };
    expect(body.role).toBe("user");
    expect(body.email).toBe("new@x.com");
    const me = await app.inject({ url: "/admin/auth/me", headers: { authorization: `Bearer ${body.token}` } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ role: "user", email: "new@x.com", quotaTotal: 30, quotaUsed: 0, quotaRemaining: 30 });
  });

  it("uses the configured daily quota", async () => {
    await enableRegistration(7);
    const res = await app.inject({ method: "POST", url: "/admin/auth/register", payload: { email: "q@x.com", password: "secret1" } });
    expect(res.statusCode).toBe(201);
    expect(repo.getUserByEmail("q@x.com")!.quotaTotal).toBe(7);
  });

  it("409 on duplicate email", async () => {
    await enableRegistration();
    expect((await app.inject({ method: "POST", url: "/admin/auth/register", payload: { email: "dup@x.com", password: "secret1" } })).statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: "/admin/auth/register", payload: { email: "dup@x.com", password: "secret1" } })).statusCode).toBe(409);
  });

  it("400 on bad email or short password", async () => {
    await enableRegistration();
    expect((await app.inject({ method: "POST", url: "/admin/auth/register", payload: { email: "not-an-email", password: "secret1" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/admin/auth/register", payload: { email: "ok@x.com", password: "12345" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/admin/auth/register", payload: { email: "ok@x.com" } })).statusCode).toBe(400);
  });

  it("registered user can change own password and re-login", async () => {
    await enableRegistration();
    const { token } = (await app.inject({ method: "POST", url: "/admin/auth/register", payload: { email: "pw@x.com", password: "secret1" } })).json() as { token: string };
    const auth = { authorization: `Bearer ${token}` };
    expect((await app.inject({ method: "PUT", url: "/admin/auth/password", headers: auth, payload: { oldPassword: "wrong", newPassword: "new-pass-1" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PUT", url: "/admin/auth/password", headers: auth, payload: { oldPassword: "secret1", newPassword: "new-pass-1" } })).statusCode).toBe(204);
    expect((await app.inject({ method: "POST", url: "/admin/auth/login", payload: { email: "pw@x.com", password: "new-pass-1" } })).statusCode).toBe(200);
  });

  it("registered user is role=user and cannot call admin API", async () => {
    await enableRegistration();
    const { token } = (await app.inject({ method: "POST", url: "/admin/auth/register", payload: { email: "ru@x.com", password: "secret1" } })).json() as { token: string };
    expect((await app.inject({ url: "/admin/channels", headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(403);
  });

  it("registration settings survive a PUT without the registration field", async () => {
    await enableRegistration(42);
    await app.inject({ method: "PUT", url: "/admin/settings", headers: H, payload: { globalPrompt: "gp", announcement: "an" } });
    const settings = await app.inject({ url: "/admin/settings", headers: H });
    expect(settings.json()).toMatchObject({ registration: { enabled: true, dailyQuota: 42 } });
  });

  it("rejects a malformed registration payload", async () => {
    const bad = await app.inject({ method: "PUT", url: "/admin/settings", headers: H, payload: { globalPrompt: "", announcement: "", registration: { enabled: "yes", dailyQuota: 30 } } });
    expect(bad.statusCode).toBe(400);
    const badQuota = await app.inject({ method: "PUT", url: "/admin/settings", headers: H, payload: { globalPrompt: "", announcement: "", registration: { enabled: true, dailyQuota: 0 } } });
    expect(badQuota.statusCode).toBe(400);
  });
});
