import Fastify from "fastify";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { Executor } from "../src/core/executor.js";
import { KeyPool } from "../src/core/keyPool.js";
import { ModelRouter } from "../src/core/router.js";
import { OpenAICompatProvider } from "../src/providers/openai-compat.js";
import { openDb } from "../src/store/db.js";
import { Repo } from "../src/store/repo.js";
import { hashPassword } from "../src/core/password.js";
import type { ImageProvider } from "../src/core/types.js";

let upstream: ReturnType<typeof Fastify>;
let dir: string;
let repo: Repo;
let app: Awaited<ReturnType<typeof buildApp>>;
let H: { authorization: string };
let hordeTest: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  upstream = Fastify();
  upstream.get("/v1/models", async (_req, reply) => reply.send({ object: "list", data: [] }));
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ad-"));
  repo = new Repo(openDb(dir));
  repo.createUser({ email: "admin@local", passwordHash: hashPassword("admin-pass"), role: "admin", quotaTotal: null });
  await upstream.listen({ port: 0, host: "127.0.0.1" });
  const upstreamUrl = `http://127.0.0.1:${(upstream.server.address() as { port: number }).port}/v1`;
  void upstreamUrl;
  const provider = new OpenAICompatProvider();
  hordeTest = vi.fn().mockResolvedValue({ ok: true, message: "horde ok" });
  const horde: ImageProvider = {
    kind: "ai-horde",
    async generate() { throw new Error("not used"); },
    async edit() { throw new Error("not used"); },
    test: hordeTest,
  };
  const providers = new Map<string, ImageProvider>([["openai-compat", provider], ["ai-horde", horde]]);
  const router = new ModelRouter(repo);
  const keyPool = new KeyPool(repo);
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

async function createChannel(name = "c1"): Promise<number> {
  const res = await app.inject({
    method: "POST",
    url: "/admin/channels",
    headers: H,
    payload: { name, baseUrl: `http://127.0.0.1:${(upstream.server.address() as { port: number }).port}/v1` },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id;
}

describe("/admin/channels", () => {
  it("creates, updates, and validates channel type", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/admin/channels",
      headers: H,
      payload: { name: "typed-horde", type: "ai-horde", baseUrl: "https://aihorde.net/api/v2" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().type).toBe("ai-horde");
    expect(created.json().concurrency).toBe(2);

    const patched = await app.inject({
      method: "PATCH",
      url: `/admin/channels/${created.json().id}`,
      headers: H,
      payload: { type: "openai-compat", concurrency: 4 },
    });
    expect(patched.json().type).toBe("openai-compat");
    expect(patched.json().concurrency).toBe(4);

    const invalid = await app.inject({
      method: "POST",
      url: "/admin/channels",
      headers: H,
      payload: { name: "bad-type", type: "unknown", baseUrl: "https://example.test" },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.message).toContain("'type'");

    for (const concurrency of [0, 1.5, "2"]) {
      const badConcurrency = await app.inject({
        method: "PATCH",
        url: `/admin/channels/${created.json().id}`,
        headers: H,
        payload: { concurrency },
      });
      expect(badConcurrency.statusCode).toBe(400);
      expect(badConcurrency.json().error.message).toContain("'concurrency'");
    }
  });

  it("returns channel health summary", async () => {
    const id = await createChannel("health");
    const key = repo.createKey(id, "sk-health");
    const other = repo.createChannel({ name: "empty", baseUrl: "https://empty.test/v1" });
    repo.insertLog({ ts: 10, model: "img", channelId: id, apiKeyId: key.id, status: "ok", httpStatus: 200, latencyMs: 100, errorMessage: null });
    repo.insertLog({ ts: 20, model: "img", channelId: id, apiKeyId: key.id, status: "error", httpStatus: 500, latencyMs: 300, errorMessage: "upstream failed" });
    const res = await app.inject({ url: "/admin/channel-health", headers: H });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({ channelId: id, status: "error", keys: expect.objectContaining({ total: 1, enabled: 1, available: 1, coolingDown: 0 }), requests: expect.objectContaining({ sampleSize: 2, successful: 1, failed: 1, successRate: 0.5, averageLatencyMs: 200 }) }),
      expect.objectContaining({ channelId: other.id, status: "no-key" }),
    ]));
  });
  it("tests connectivity with the provider selected by channel type", async () => {
    const channel = repo.createChannel({ name: "horde", type: "ai-horde", baseUrl: "https://aihorde.net/api/v2" });
    repo.createKey(channel.id, "0000000000");

    const result = await app.inject({ method: "POST", url: `/admin/channels/${channel.id}/test`, headers: H });

    expect(result.json()).toMatchObject({ ok: true, message: "horde ok" });
    expect(hordeTest).toHaveBeenCalledOnce();
  });

  it("CRUD + conflict + test connectivity", async () => {
    const id = await createChannel();
    await app.inject({ method: "POST", url: `/admin/channels/${id}/keys`, headers: H, payload: { apiKey: "sk-up" } });

    const list = await app.inject({ url: "/admin/channels", headers: H });
    expect(list.statusCode).toBe(200);
    expect(list.json()[0].keys).toHaveLength(1);
    expect(list.json()[0].keys[0].apiKey).toBe("sk-up");

    const test = await app.inject({ method: "POST", url: `/admin/channels/${id}/test`, headers: H });
    expect(test.statusCode).toBe(200);
    expect(test.json().ok).toBe(true);

    const patched = await app.inject({ method: "PATCH", url: `/admin/channels/${id}`, headers: H, payload: { name: "c1-renamed" } });
    expect(patched.json().name).toBe("c1-renamed");

    const del = await app.inject({ method: "DELETE", url: `/admin/channels/${id}`, headers: H });
    expect(del.statusCode).toBe(204);
    expect((await app.inject({ url: `/admin/channels/${id}`, headers: H })).statusCode).toBe(404);
  });

  it("rejects duplicate channel name with 409", async () => {
    await createChannel("dup");
    const res = await app.inject({ method: "POST", url: "/admin/channels", headers: H, payload: { name: "dup", baseUrl: "https://y/v1" } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.type).toBe("conflict_error");
  });

  it("rejects bad baseUrl with 400", async () => {
    const res = await app.inject({ method: "POST", url: "/admin/channels", headers: H, payload: { name: "x", baseUrl: "notaurl" } });
    expect(res.statusCode).toBe(400);
  });

  it("test without key reports not ok", async () => {
    const id = await createChannel("nokey");
    const res = await app.inject({ method: "POST", url: `/admin/channels/${id}/test`, headers: H });
    expect(res.json().ok).toBe(false);
    expect(res.json().keyId).toBeNull();
  });
});

describe("/admin/models", () => {
  it("CRUD + duplicate conflict", async () => {
    const channelId = await createChannel();
    const created = await app.inject({
      method: "POST",
      url: "/admin/models",
      headers: H,
      payload: { publicName: "img-1", channelId, upstreamName: "gpt-image-1", supportsNsfw: true },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().channelId).toBe(channelId);
    expect(created.json().supportsNsfw).toBe(true);

    // 同名映射允许重复（故障转移），可带 priority
    const dup = await app.inject({
      method: "POST",
      url: "/admin/models",
      headers: H,
      payload: { publicName: "img-1", channelId, priority: 5 },
    });
    expect(dup.statusCode).toBe(201);
    expect(dup.json().priority).toBe(5);

    const list = await app.inject({ url: "/admin/models", headers: H });
    expect(list.json()[0].channelName).toBe("c1");

    const patched = await app.inject({ method: "PATCH", url: `/admin/models/${created.json().id}`, headers: H, payload: { enabled: false, supportsNsfw: false } });
    expect(patched.json()).toMatchObject({ enabled: false, supportsNsfw: false });
    expect((await app.inject({ method: "PATCH", url: `/admin/models/${created.json().id}`, headers: H, payload: { supportsNsfw: "yes" } })).statusCode).toBe(400);

    const del = await app.inject({ method: "DELETE", url: `/admin/models/${created.json().id}`, headers: H });
    expect(del.statusCode).toBe(204);
  });
});

describe("/admin/api-keys", () => {
  it("creates sk-tiny- key, patches, deletes", async () => {
    const created = await app.inject({ method: "POST", url: "/admin/api-keys", headers: H, payload: { name: "k1" } });
    expect(created.statusCode).toBe(201);
    expect(created.json().key.startsWith("sk-tiny-")).toBe(true);

    const patched = await app.inject({ method: "PATCH", url: `/admin/api-keys/${created.json().id}`, headers: H, payload: { enabled: false } });
    expect(patched.json().enabled).toBe(false);

    const del = await app.inject({ method: "DELETE", url: `/admin/api-keys/${created.json().id}`, headers: H });
    expect(del.statusCode).toBe(204);
  });
});

describe("/admin/logs", () => {
  it("returns recent logs", async () => {
    repo.insertLog({ ts: Date.now(), model: "img-1", channelId: 1, apiKeyId: null, status: "ok", httpStatus: 200, latencyMs: 5, errorMessage: null });
    const res = await app.inject({ url: "/admin/logs?limit=10", headers: H });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(1);
    expect(res.json()[0].model).toBe("img-1");
  });
});

describe("settings", () => {
  it("reads defaults and updates settings as admin", async () => {
    const initial = await app.inject({ url: "/admin/settings", headers: H });
    expect(initial.json()).toEqual({ globalPrompt: "", announcement: "", announcementVersion: 0 });

    const updated = await app.inject({
      method: "PUT",
      url: "/admin/settings",
      headers: H,
      payload: { globalPrompt: "house style", announcement: "Maintenance tonight" },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toEqual({ globalPrompt: "house style", announcement: "Maintenance tonight", announcementVersion: 1 });

    const repeated = await app.inject({
      method: "PUT",
      url: "/admin/settings",
      headers: H,
      payload: { globalPrompt: "new style", announcement: "Maintenance tonight" },
    });
    expect(repeated.json().announcementVersion).toBe(1);
  });

  it("protects admin settings while exposing only the announcement to users", async () => {
    repo.updateAppSettings({ globalPrompt: "secret prefix", announcement: "Maintenance tonight" });
    repo.createUser({ email: "user@local", passwordHash: hashPassword("user-pass"), role: "user", quotaTotal: null });
    const login = await app.inject({ method: "POST", url: "/admin/auth/login", payload: { email: "user@local", password: "user-pass" } });
    const userHeaders = { authorization: `Bearer ${(login.json() as { token: string }).token}` };

    expect((await app.inject({ url: "/admin/settings" })).statusCode).toBe(401);
    expect((await app.inject({ url: "/admin/settings", headers: userHeaders })).statusCode).toBe(403);
    expect((await app.inject({ url: "/v1/announcement" })).statusCode).toBe(401);

    const announcement = await app.inject({ url: "/v1/announcement", headers: userHeaders });
    expect(announcement.statusCode).toBe(200);
    expect(announcement.json()).toEqual({ announcement: "Maintenance tonight", version: 1 });
    expect(announcement.json()).not.toHaveProperty("globalPrompt");
  });

  it("rejects non-string setting values", async () => {
    const bad = await app.inject({
      method: "PUT",
      url: "/admin/settings",
      headers: H,
      payload: { globalPrompt: 42, announcement: "text" },
    });
    expect(bad.statusCode).toBe(400);
  });
});

describe("auth", () => {
  it("401 without token", async () => {
    expect((await app.inject({ url: "/admin/channels" })).statusCode).toBe(401);
  });
});
