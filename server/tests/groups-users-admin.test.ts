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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gua-"));
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

async function makeUser(overrides: Record<string, unknown> = {}): Promise<number> {
  const res = await app.inject({
    method: "POST",
    url: "/admin/users",
    headers: H,
    payload: { email: "u1@x.com", password: "secret1", quotaTotal: 100, ...overrides },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { id: number }).id;
}

describe("/admin/groups", () => {
  it("CRUD + channel binding", async () => {
    const c = await app.inject({ method: "POST", url: "/admin/channels", headers: H, payload: { name: "c1", baseUrl: "http://x" } });
    const channelId = (c.json() as { id: number }).id;

    const created = await app.inject({ method: "POST", url: "/admin/groups", headers: H, payload: { name: "vip" } });
    expect(created.statusCode).toBe(201);
    const gid = (created.json() as { id: number }).id;

    const bind = await app.inject({ method: "PUT", url: `/admin/groups/${gid}/channels`, headers: H, payload: { channelIds: [channelId] } });
    expect(bind.statusCode).toBe(200);
    expect((bind.json() as { channelIds: number[] }).channelIds).toEqual([channelId]);

    const list = await app.inject({ url: "/admin/groups", headers: H });
    expect(list.json()).toHaveLength(1);
    expect(list.json()[0]).toMatchObject({ name: "vip", channelIds: [channelId] });

    const renamed = await app.inject({ method: "PATCH", url: `/admin/groups/${gid}`, headers: H, payload: { name: "svip" } });
    expect((renamed.json() as { name: string }).name).toBe("svip");

    expect((await app.inject({ method: "DELETE", url: `/admin/groups/${gid}`, headers: H })).statusCode).toBe(204);
    expect((await app.inject({ method: "DELETE", url: `/admin/groups/${gid}`, headers: H })).statusCode).toBe(404);
  });
  it("validation errors", async () => {
    expect((await app.inject({ method: "POST", url: "/admin/groups", headers: H, payload: {} })).statusCode).toBe(400);
    const g = (await app.inject({ method: "POST", url: "/admin/groups", headers: H, payload: { name: "g" } })).json() as { id: number };
    expect((await app.inject({ method: "PUT", url: `/admin/groups/${g.id}/channels`, headers: H, payload: { channelIds: [999] } })).statusCode).toBe(400);
  });
});

describe("/admin/users", () => {
  it("create/list/patch/delete", async () => {
    const g = (await app.inject({ method: "POST", url: "/admin/groups", headers: H, payload: { name: "g" } })).json() as { id: number };
    const uid = await makeUser({ groupIds: [g.id] });

    const list = await app.inject({ url: "/admin/users", headers: H });
    const u = (list.json() as { id: number }[]).find((x) => x.id === uid)!;
    expect(u).toMatchObject({ email: "u1@x.com", role: "user", enabled: true, quotaTotal: 100, quotaUsed: 0, quotaRemaining: 100, groupIds: [g.id] });
    expect(u.passwordHash).toBeUndefined();

    const patched = await app.inject({ method: "PATCH", url: `/admin/users/${uid}`, headers: H, payload: { quotaTotal: 5, groupIds: [], enabled: false, password: "newpass1" } });
    expect(patched.json()).toMatchObject({ quotaTotal: 5, groupIds: [], enabled: false, quotaRemaining: 5 });

    expect((await app.inject({ method: "DELETE", url: `/admin/users/${uid}`, headers: H })).statusCode).toBe(204);
    expect((await app.inject({ method: "DELETE", url: `/admin/users/${uid}`, headers: H })).statusCode).toBe(404);
  });
  it("cannot delete/disable admins, cannot delete self, role immutable", async () => {
    const adminId = repo.getUserByEmail("admin@local")!.id;
    expect((await app.inject({ method: "DELETE", url: `/admin/users/${adminId}`, headers: H })).statusCode).toBe(400);
    expect((await app.inject({ method: "PATCH", url: `/admin/users/${adminId}`, headers: H, payload: { enabled: false } })).statusCode).toBe(400);
    // "self" = ADMIN_TOKEN 身份 uid 为 null，用 admin JWT 测
    const login = await app.inject({ method: "POST", url: "/admin/auth/login", payload: { email: "admin@local", password: "admin-pass" } });
    const jwth = { authorization: `Bearer ${(login.json() as { token: string }).token}` };
    expect((await app.inject({ method: "DELETE", url: `/admin/users/${adminId}`, headers: jwth })).statusCode).toBe(400);
    const u = await makeUser();
    expect((await app.inject({ method: "PATCH", url: `/admin/users/${u}`, headers: H, payload: { role: "admin" } })).statusCode).toBe(400);
  });
  it("validation: email/password/quota", async () => {
    expect((await app.inject({ method: "POST", url: "/admin/users", headers: H, payload: { email: "not-an-email", password: "secret1", quotaTotal: 1 } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/admin/users", headers: H, payload: { email: "a@x.com", password: "123", quotaTotal: 1 } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/admin/users", headers: H, payload: { email: "a@x.com", password: "secret1" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/admin/users", headers: H, payload: { email: "a@x.com", password: "secret1", quotaTotal: 0 } })).statusCode).toBe(400);
    await makeUser();
    expect((await app.inject({ method: "POST", url: "/admin/users", headers: H, payload: { email: "u1@x.com", password: "secret1", quotaTotal: 1 } })).statusCode).toBe(409);
  });
});

describe("api key user binding", () => {
  it("create with userId, list shows userEmail", async () => {
    const uid = await makeUser({ email: "bound@x.com" });
    const k = await app.inject({ method: "POST", url: "/admin/api-keys", headers: H, payload: { name: "k", userId: uid } });
    expect(k.statusCode).toBe(201);
    expect((k.json() as { userId: number }).userId).toBe(uid);
    const list = await app.inject({ url: "/admin/api-keys", headers: H });
    expect(list.json()[0]).toMatchObject({ userId: uid, userEmail: "bound@x.com" });
    expect((await app.inject({ method: "POST", url: "/admin/api-keys", headers: H, payload: { name: "k2", userId: 999 } })).statusCode).toBe(400);
  });
});
