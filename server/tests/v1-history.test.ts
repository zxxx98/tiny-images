import Fastify from "fastify";
import multipart from "@fastify/multipart";
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
import { JobManager } from "../src/server/jobs.js";

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG_BUF = Buffer.from(PNG_B64, "base64");
let upstream: ReturnType<typeof Fastify>;
let dir: string;
let repo: Repo;
let app: Awaited<ReturnType<typeof buildApp>>;
let apiKeyId: number;
let apiKey: string;

beforeEach(async () => {
  upstream = Fastify();
  await upstream.register(multipart);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "vh-"));
  repo = new Repo(openDb(dir));
});

afterEach(async () => {
  await app.close();
  await upstream.close();
  repo.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function start(): Promise<void> {
  await upstream.listen({ port: 0, host: "127.0.0.1" });
  const port = (upstream.server.address() as { port: number }).port;
  const c = repo.createChannel({ name: "mock", baseUrl: `http://127.0.0.1:${port}/v1` });
  repo.createKey(c.id, "sk-upstream");
  repo.createModel({ publicName: "img-1", channelId: c.id, upstreamName: "gpt-image-1" });
  const created = repo.createApiKey("k1");
  apiKeyId = created.id;
  apiKey = created.key;
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
    jobManager: new JobManager(),
    logger: false,
    webDist: null,
  });
}

const auth = () => ({ authorization: `Bearer ${apiKey}` });

async function waitJob(jobId: string): Promise<Record<string, unknown>> {
  let poll = await app.inject({ method: "GET", url: `/v1/images/jobs/${jobId}`, headers: auth() });
  for (let i = 0; i < 100 && poll.json().status === "running"; i++) {
    await new Promise((r) => setTimeout(r, 50));
    poll = await app.inject({ method: "GET", url: `/v1/images/jobs/${jobId}`, headers: auth() });
  }
  return poll.json();
}

function makeEditForm(): FormData {
  const form = new FormData();
  form.append("model", "img-1");
  form.append("prompt", "add an airship");
  form.append("n", "1");
  form.append("response_format", "url");
  form.append("image", new Blob([PNG_BUF], { type: "image/png" }), "source.png");
  return form;
}

async function injectEditForm(form: FormData) {
  const request = new Request("http://local/", { method: "POST", body: form });
  return app.inject({
    method: "POST",
    url: "/v1/images/edit-jobs",
    payload: Buffer.from(await request.arrayBuffer()),
    headers: { ...auth(), "content-type": request.headers.get("content-type")! },
  });
}

describe("POST /v1/images/jobs", () => {
  it("runs detached, records generation, poll returns ok with local file", async () => {
    upstream.post("/v1/images/generations", async (_req, reply) =>
      reply.send({ created: 42, data: [{ b64_json: PNG_B64, revised_prompt: "rev" }] }),
    );
    await start();
    const created = await app.inject({ method: "POST", url: "/v1/images/jobs", headers: auth(), payload: { model: "img-1", prompt: "cat" } });
    expect(created.statusCode).toBe(200);
    const { jobId } = created.json();
    const body = await waitJob(jobId);
    expect(body.status).toBe("ok");
    expect(body.channel).toBe("mock");
    const images = body.images as { file: string; url: string; revisedPrompt?: string }[];
    expect(images[0].url).toMatch(/\/files\/[0-9a-f]{32}\.png$/);
    expect(images[0].revisedPrompt).toBe("rev");
    expect(fs.existsSync(path.join(dir, "generated", images[0].file))).toBe(true);
    const rows = repo.listGenerations({ admin: false, userId: null, apiKeyId }, null, 10);
    expect(rows[0].status).toBe("ok");
    expect(rows[0].prompt).toBe("cat");
    expect(JSON.parse(rows[0].images)[0].file).toBe(images[0].file);
  });

  it("poll 404 for other key and unknown id", async () => {
    upstream.post("/v1/images/generations", async (_req, reply) => reply.send({ created: 1, data: [{ b64_json: PNG_B64 }] }));
    await start();
    const other = repo.createApiKey("k2");
    const { jobId } = (await app.inject({ method: "POST", url: "/v1/images/jobs", headers: auth(), payload: { model: "img-1", prompt: "cat" } })).json();
    expect((await app.inject({ method: "GET", url: `/v1/images/jobs/${jobId}`, headers: { authorization: `Bearer ${other.key}` } })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/v1/images/jobs/nonexistent", headers: auth() })).statusCode).toBe(404);
    await waitJob(jobId);
  });

  it("error job records error generation", async () => {
    upstream.post("/v1/images/generations", async (_req, reply) => reply.code(500).send({ error: { message: "boom" } }));
    await start();
    const { jobId } = (await app.inject({ method: "POST", url: "/v1/images/jobs", headers: auth(), payload: { model: "img-1", prompt: "cat" } })).json();
    const body = await waitJob(jobId);
    expect(body.status).toBe("error");
    expect(body.error).toContain("boom");
    expect(repo.listGenerations({ admin: false, userId: null, apiKeyId }, null, 10)[0].status).toBe("error");
  });
});

describe("POST /v1/images/edit-jobs", () => {
  it("publishes a localized edit through job polling and history", async () => {
    upstream.post("/v1/images/edits", async (req, reply) => {
      for await (const _part of req.parts()) {
        // consume the multipart upload
      }
      return reply.send({ created: 42, data: [{ b64_json: PNG_B64, revised_prompt: "airship added" }] });
    });
    await start();

    const created = await injectEditForm(makeEditForm());

    expect(created.statusCode).toBe(200);
    expect(created.json().jobId).toEqual(expect.any(String));
    const body = await waitJob(created.json().jobId);
    expect(body.status).toBe("ok");
    expect(body.channel).toBe("mock");
    const images = body.images as { file: string; url: string; revisedPrompt?: string }[];
    expect(images[0].url).toMatch(/\/files\/[0-9a-f]{32}\.png$/);
    expect(images[0].revisedPrompt).toBe("airship added");
    const row = repo.listGenerations({ admin: false, userId: null, apiKeyId }, null, 10)[0];
    expect(row.status).toBe("ok");
    expect(row.prompt).toBe("add an airship");
    expect(JSON.parse(row.images)[0].file).toBe(images[0].file);
  });

  it("rejects a missing image before creating history or a job", async () => {
    await start();
    const form = new FormData();
    form.append("model", "img-1");
    form.append("prompt", "add an airship");

    const res = await injectEditForm(form);

    expect(res.statusCode).toBe(400);
    expect(repo.listGenerations({ admin: false, userId: null, apiKeyId }, null, 10)).toHaveLength(0);
  });

  it("records background edit failures in both the job and history", async () => {
    upstream.post("/v1/images/edits", async (_req, reply) => reply.code(500).send({ error: { message: "boom" } }));
    await start();

    const created = await injectEditForm(makeEditForm());
    const body = await waitJob(created.json().jobId);

    expect(body.status).toBe("error");
    expect(body.error).toContain("boom");
    const row = repo.listGenerations({ admin: false, userId: null, apiKeyId }, null, 10)[0];
    expect(row.status).toBe("error");
    expect(row.errorMessage).toContain("boom");
  });
});

describe("GET /v1/history", () => {
  it("lists generations with file urls, key-filtered, cursor pagination", async () => {
    await start();
    repo.insertGeneration({ createdAt: 1, apiKeyId, userId: null, model: "m", prompt: "p1", params: "{}", status: "ok", channelId: null, latencyMs: 1, errorMessage: null, images: JSON.stringify([{ file: "a.png" }]) });
    repo.insertGeneration({ createdAt: 2, apiKeyId: apiKeyId + 999, userId: null, model: "m", prompt: "p2", params: "{}", status: "ok", channelId: null, latencyMs: 1, errorMessage: null, images: "[]" });
    const res = await app.inject({ method: "GET", url: "/v1/history?limit=1", headers: auth() });
    expect(res.statusCode).toBe(200);
    const page1 = res.json();
    expect(page1.items).toHaveLength(1);
    expect(page1.items[0].prompt).toBe("p1");
    expect(page1.items[0].images[0].url).toMatch(/\/files\/a\.png$/);
    const page2 = (await app.inject({ method: "GET", url: `/v1/history?limit=1&before=${page1.items[0].id}`, headers: auth() })).json();
    expect(page2.items).toHaveLength(0);
  });

  it("user identity sees own keys' records + own web calls, not others; admin sees all", async () => {
    await start();
    const hash = (await import("../src/core/password.js")).hashPassword;
    const u1 = repo.createUser({ email: "u1@x.com", passwordHash: hash("pw-123456"), role: "user", quotaTotal: 100 });
    const u2 = repo.createUser({ email: "u2@x.com", passwordHash: hash("pw-123456"), role: "user", quotaTotal: 100 });
    // u1 名下的 key 与网页调用、别人的记录
    const u1key = repo.createApiKey("u1-k", u1.id);
    repo.insertGeneration({ createdAt: 1, apiKeyId: u1key.id, userId: null, model: "m", prompt: "u1-key", params: "{}", status: "ok", channelId: null, latencyMs: 1, errorMessage: null, images: "[]" });
    repo.insertGeneration({ createdAt: 2, apiKeyId: null, userId: u1.id, model: "m", prompt: "u1-web", params: "{}", status: "ok", channelId: null, latencyMs: 1, errorMessage: null, images: "[]" });
    repo.insertGeneration({ createdAt: 3, apiKeyId: null, userId: u2.id, model: "m", prompt: "u2-web", params: "{}", status: "ok", channelId: null, latencyMs: 1, errorMessage: null, images: "[]" });
    repo.insertGeneration({ createdAt: 4, apiKeyId: apiKeyId, userId: null, model: "m", prompt: "unbound", params: "{}", status: "ok", channelId: null, latencyMs: 1, errorMessage: null, images: "[]" });

    const login = await app.inject({ method: "POST", url: "/admin/auth/login", payload: { email: "u1@x.com", password: "pw-123456" } });
    const u1h = { authorization: `Bearer ${(login.json() as { token: string }).token}` };
    const prompts = (await app.inject({ url: "/v1/history", headers: u1h })).json().items.map((r: { prompt: string }) => r.prompt).sort();
    expect(prompts).toEqual(["u1-key", "u1-web"]);

    // admin JWT 看到全部（含无主记录）
    repo.createUser({ email: "admin@local", passwordHash: hash("pw-123456"), role: "admin", quotaTotal: null });
    const alogin = await app.inject({ method: "POST", url: "/admin/auth/login", payload: { email: "admin@local", password: "pw-123456" } });
    const ah = { authorization: `Bearer ${(alogin.json() as { token: string }).token}` };
    const all = (await app.inject({ url: "/v1/history", headers: ah })).json().items.map((r: { prompt: string }) => r.prompt).sort();
    expect(all).toEqual(["u1-key", "u1-web", "u2-web", "unbound"]);

    // 绑定 key 的调用也按用户身份过滤（该用户名下所有 key）
    const bound = (await app.inject({ url: "/v1/history", headers: { authorization: `Bearer ${u1key.key}` } })).json().items.map((r: { prompt: string }) => r.prompt).sort();
    expect(bound).toEqual(["u1-key", "u1-web"]);

    // 无主 key 只看无主记录
    const unboundRows = (await app.inject({ url: "/v1/history", headers: auth() })).json().items.map((r: { prompt: string }) => r.prompt);
    expect(unboundRows).toEqual(["unbound"]);
  });
});

describe("POST /v1/images/generations records history", () => {
  it("sync ok path writes generation row with localized url image", async () => {
    upstream.get("/x.png", async (_req, reply) => reply.type("image/png").send(Buffer.from(PNG_B64, "base64")));
    upstream.post("/v1/images/generations", async (_req, reply) => {
      const port = (upstream.server.address() as { port: number }).port;
      return reply.send({ created: 1, data: [{ url: `http://127.0.0.1:${port}/x.png` }] });
    });
    await start();
    const res = await app.inject({ method: "POST", url: "/v1/images/generations", headers: auth(), payload: { model: "img-1", prompt: "cat", response_format: "url" } });
    expect(res.statusCode).toBe(200);
    const rows = repo.listGenerations({ admin: false, userId: null, apiKeyId }, null, 10);
    expect(rows[0].status).toBe("ok");
    const img = JSON.parse(rows[0].images)[0];
    expect(img.file).toMatch(/\.png$/);
    expect(fs.existsSync(path.join(dir, "generated", img.file))).toBe(true);
  });
});
