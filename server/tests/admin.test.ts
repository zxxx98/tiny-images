import Fastify from "fastify";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { Executor } from "../src/core/executor.js";
import { KeyPool } from "../src/core/keyPool.js";
import { ModelRouter } from "../src/core/router.js";
import { OpenAICompatProvider } from "../src/providers/openai-compat.js";
import { openDb } from "../src/store/db.js";
import { Repo } from "../src/store/repo.js";
import { hashPassword } from "../src/core/password.js";

let upstream: ReturnType<typeof Fastify>;
let dir: string;
let repo: Repo;
let app: Awaited<ReturnType<typeof buildApp>>;
let H: { authorization: string };

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
  const router = new ModelRouter(repo);
  const keyPool = new KeyPool(repo);
  app = await buildApp({
    env: { port: 0, dataDir: dir, publicBaseUrl: null },
    repo,
    router,
    keyPool,
    provider,
    executor: new Executor({ router, keyPool, provider, repo }),
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
      payload: { publicName: "img-1", channelId, upstreamName: "gpt-image-1" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().channelId).toBe(channelId);

    const dup = await app.inject({
      method: "POST",
      url: "/admin/models",
      headers: H,
      payload: { publicName: "img-1", channelId },
    });
    expect(dup.statusCode).toBe(409);

    const list = await app.inject({ url: "/admin/models", headers: H });
    expect(list.json()[0].channelName).toBe("c1");

    const patched = await app.inject({ method: "PATCH", url: `/admin/models/${created.json().id}`, headers: H, payload: { enabled: false } });
    expect(patched.json().enabled).toBe(false);

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

describe("auth", () => {
  it("401 without token", async () => {
    expect((await app.inject({ url: "/admin/channels" })).statusCode).toBe(401);
  });
});
