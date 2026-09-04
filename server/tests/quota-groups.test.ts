import Fastify from "fastify";
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

let upstream: ReturnType<typeof Fastify>;
let dir: string;
let repo: Repo;
let app: Awaited<ReturnType<typeof buildApp>>;
let H: { authorization: string };
let upstreamUrl = "";
let now: number;
let upstreamEntered: (() => void) | null = null;
let waitForUpstream: Promise<void> | null = null;

beforeEach(async () => {
  upstream = Fastify();
  upstream.post("/v1/images/generations", async (req) => {
    upstreamEntered?.();
    if (waitForUpstream) await waitForUpstream;
    const n = typeof (req.body as { n?: number } | null)?.n === "number" ? (req.body as { n: number }).n : 1;
    return {
      created: 1,
      data: Array.from({ length: Math.max(1, n) }, () => ({ b64_json: Buffer.from("fake-image").toString("base64") })),
    };
  });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "qg-"));
  now = Date.UTC(2026, 0, 1, 15, 59, 59);
  upstreamEntered = null;
  waitForUpstream = null;
  repo = new Repo(openDb(dir), () => now);
  repo.createUser({ email: "admin@local", passwordHash: hashPassword("admin-pass"), role: "admin", quotaTotal: null });
  await upstream.listen({ port: 0, host: "127.0.0.1" });
  upstreamUrl = `http://127.0.0.1:${(upstream.server.address() as { port: number }).port}/v1`;
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
  await upstream.close();
  repo.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

interface Setup {
  apiKey: string;
  channelId: number;
  userId: number;
}
async function setupUser(opts: { quotaTotal: number | null; groupName: string | null }): Promise<Setup> {
  const c = await app.inject({ method: "POST", url: "/admin/channels", headers: H, payload: { name: `c-${Math.random()}`, baseUrl: upstreamUrl } });
  const channelId = (c.json() as { id: number }).id;
  await app.inject({ method: "POST", url: `/admin/channels/${channelId}/keys`, headers: H, payload: { apiKey: "sk-up" } });
  await app.inject({ method: "POST", url: "/admin/models", headers: H, payload: { publicName: "mdl", channelId } });
  const u = await app.inject({
    method: "POST",
    url: "/admin/users",
    headers: H,
    payload: { email: `u${Math.random()}@x.com`, password: "secret1", quotaTotal: opts.quotaTotal ?? 2 },
  });
  const userId = (u.json() as { id: number }).id;
  if (opts.groupName) {
    const g = await app.inject({ method: "POST", url: "/admin/groups", headers: H, payload: { name: opts.groupName } });
    await app.inject({ method: "PUT", url: `/admin/groups/${(g.json() as { id: number }).id}/channels`, headers: H, payload: { channelIds: [channelId] } });
    await app.inject({ method: "PATCH", url: `/admin/users/${userId}`, headers: H, payload: { groupIds: [(g.json() as { id: number }).id] } });
  }
  const k = await app.inject({ method: "POST", url: "/admin/api-keys", headers: H, payload: { name: "k", userId } });
  return { apiKey: (k.json() as { key: string }).key, channelId, userId };
}

describe("quota", () => {
  it("402 when remaining < n, no upstream call", async () => {
    const s = await setupUser({ quotaTotal: 2, groupName: null });
    const auth = { authorization: `Bearer ${s.apiKey}` };
    const r1 = await app.inject({ method: "POST", url: "/v1/images/generations", headers: auth, payload: { model: "mdl", prompt: "p", n: 2 } });
    expect(r1.statusCode).toBe(200);
    expect(repo.getUser(s.userId)?.quotaUsed).toBe(2);
    const r2 = await app.inject({ method: "POST", url: "/v1/images/generations", headers: auth, payload: { model: "mdl", prompt: "p" } });
    expect(r2.statusCode).toBe(402);
    expect((r2.json() as { error: { type: string } }).error.type).toBe("insufficient_quota");
  });
  it("charges per image count, disabled user key rejected", async () => {
    const s = await setupUser({ quotaTotal: 5, groupName: null });
    const auth = { authorization: `Bearer ${s.apiKey}` };
    const r = await app.inject({ method: "POST", url: "/v1/images/generations", headers: auth, payload: { model: "mdl", prompt: "p" } });
    expect(r.statusCode).toBe(200);
    expect(repo.getUser(s.userId)?.quotaUsed).toBe(1);
    repo.updateUser(s.userId, { enabled: false });
    const r2 = await app.inject({ method: "POST", url: "/v1/images/generations", headers: auth, payload: { model: "mdl", prompt: "p" } });
    expect(r2.statusCode).toBe(401);
  });

  it("rejects a concurrent request when the first request reserves the final quota", async () => {
    const s = await setupUser({ quotaTotal: 1, groupName: null });
    const auth = { authorization: `Bearer ${s.apiKey}` };
    let release!: () => void;
    waitForUpstream = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { upstreamEntered = resolve; });

    const first = app.inject({ method: "POST", url: "/v1/images/generations", headers: auth, payload: { model: "mdl", prompt: "p" } });
    await entered;
    const second = await app.inject({ method: "POST", url: "/v1/images/generations", headers: auth, payload: { model: "mdl", prompt: "p" } });

    expect(second.statusCode).toBe(402);
    release();
    expect((await first).statusCode).toBe(200);
    expect(repo.getUser(s.userId)?.quotaUsed).toBe(1);
  });
  it("unbound key and admin token bypass quota", async () => {
    // 建渠道/模型但不建用户，创建无主 key
    const c = await app.inject({ method: "POST", url: "/admin/channels", headers: H, payload: { name: "c", baseUrl: upstreamUrl } });
    const channelId = (c.json() as { id: number }).id;
    await app.inject({ method: "POST", url: `/admin/channels/${channelId}/keys`, headers: H, payload: { apiKey: "sk-up" } });
    await app.inject({ method: "POST", url: "/admin/models", headers: H, payload: { publicName: "mdl", channelId } });
    const k = await app.inject({ method: "POST", url: "/admin/api-keys", headers: H, payload: { name: "free" } });
    const r = await app.inject({
      method: "POST",
      url: "/v1/images/generations",
      headers: { authorization: `Bearer ${(k.json() as { key: string }).key}` },
      payload: { model: "mdl", prompt: "p" },
    });
    expect(r.statusCode).toBe(200);
    const r2 = await app.inject({ method: "POST", url: "/v1/images/generations", headers: H, payload: { model: "mdl", prompt: "p" } });
    expect(r2.statusCode).toBe(200);
  });

  it("restores an exhausted quota after Beijing midnight", async () => {
    const s = await setupUser({ quotaTotal: 2, groupName: null });
    const auth = { authorization: `Bearer ${s.apiKey}` };

    const exhausted = await app.inject({
      method: "POST",
      url: "/v1/images/generations",
      headers: auth,
      payload: { model: "mdl", prompt: "p", n: 2 },
    });
    expect(exhausted.statusCode).toBe(200);
    expect(repo.getUser(s.userId)?.quotaUsed).toBe(2);
    expect((await app.inject({
      method: "POST",
      url: "/v1/images/generations",
      headers: auth,
      payload: { model: "mdl", prompt: "p" },
    })).statusCode).toBe(402);

    now = Date.UTC(2026, 0, 1, 16, 0, 0);
    const restored = await app.inject({
      method: "POST",
      url: "/v1/images/generations",
      headers: auth,
      payload: { model: "mdl", prompt: "p" },
    });
    expect(restored.statusCode).toBe(200);
    expect(repo.getUser(s.userId)).toMatchObject({ quotaUsed: 1, quotaDay: "2026-01-02" });
  });
});

describe("channel group filtering", () => {
  it("/v1/models and generations restricted to user's groups", async () => {
    const cA = await app.inject({ method: "POST", url: "/admin/channels", headers: H, payload: { name: "A", baseUrl: upstreamUrl } });
    const cB = await app.inject({ method: "POST", url: "/admin/channels", headers: H, payload: { name: "B", baseUrl: upstreamUrl } });
    await app.inject({ method: "POST", url: `/admin/channels/${(cA.json() as { id: number }).id}/keys`, headers: H, payload: { apiKey: "sk-up" } });
    await app.inject({ method: "POST", url: `/admin/channels/${(cB.json() as { id: number }).id}/keys`, headers: H, payload: { apiKey: "sk-up" } });
    await app.inject({ method: "POST", url: "/admin/models", headers: H, payload: { publicName: "in-group", channelId: (cA.json() as { id: number }).id } });
    await app.inject({ method: "POST", url: "/admin/models", headers: H, payload: { publicName: "out-group", channelId: (cB.json() as { id: number }).id } });
    const u = await app.inject({ method: "POST", url: "/admin/users", headers: H, payload: { email: "g@x.com", password: "secret1", quotaTotal: 10 } });
    const g = await app.inject({ method: "POST", url: "/admin/groups", headers: H, payload: { name: "onlyA" } });
    await app.inject({ method: "PUT", url: `/admin/groups/${(g.json() as { id: number }).id}/channels`, headers: H, payload: { channelIds: [(cA.json() as { id: number }).id] } });
    await app.inject({ method: "PATCH", url: `/admin/users/${(u.json() as { id: number }).id}`, headers: H, payload: { groupIds: [(g.json() as { id: number }).id] } });
    const k = await app.inject({ method: "POST", url: "/admin/api-keys", headers: H, payload: { name: "k", userId: (u.json() as { id: number }).id } });
    const auth = { authorization: `Bearer ${(k.json() as { key: string }).key}` };

    const models = await app.inject({ url: "/v1/models", headers: auth });
    const ids = (models.json() as { data: { id: string }[] }).data.map((m) => m.id);
    expect(ids).toContain("in-group");
    expect(ids).not.toContain("out-group");

    const ok = await app.inject({ method: "POST", url: "/v1/images/generations", headers: auth, payload: { model: "in-group", prompt: "p" } });
    expect(ok.statusCode).toBe(200);
    const blocked = await app.inject({ method: "POST", url: "/v1/images/generations", headers: auth, payload: { model: "out-group", prompt: "p" } });
    expect(blocked.statusCode).toBe(404);

    // admin token 不受限
    const adminModels = await app.inject({ url: "/v1/models", headers: H });
    expect((adminModels.json() as { data: unknown[] }).data).toHaveLength(2);
  });
});
