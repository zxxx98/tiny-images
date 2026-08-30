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
import { JobManager } from "../src/server/jobs.js";

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
let upstream: ReturnType<typeof Fastify>;
let dir: string;
let repo: Repo;
let app: Awaited<ReturnType<typeof buildApp>>;
let apiKeyId: number;
let apiKey: string;

beforeEach(async () => {
  upstream = Fastify();
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
    env: { port: 0, dataDir: dir, adminToken: null, publicBaseUrl: null },
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
    const rows = repo.listGenerations(apiKeyId, null, 10);
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
    expect(repo.listGenerations(apiKeyId, null, 10)[0].status).toBe("error");
  });
});

describe("GET /v1/history", () => {
  it("lists generations with file urls, key-filtered, cursor pagination", async () => {
    await start();
    repo.insertGeneration({ createdAt: 1, apiKeyId, model: "m", prompt: "p1", params: "{}", status: "ok", channelId: null, latencyMs: 1, errorMessage: null, images: JSON.stringify([{ file: "a.png" }]) });
    repo.insertGeneration({ createdAt: 2, apiKeyId: apiKeyId + 999, model: "m", prompt: "p2", params: "{}", status: "ok", channelId: null, latencyMs: 1, errorMessage: null, images: "[]" });
    const res = await app.inject({ method: "GET", url: "/v1/history?limit=1", headers: auth() });
    expect(res.statusCode).toBe(200);
    const page1 = res.json();
    expect(page1.items).toHaveLength(1);
    expect(page1.items[0].prompt).toBe("p1");
    expect(page1.items[0].images[0].url).toMatch(/\/files\/a\.png$/);
    const page2 = (await app.inject({ method: "GET", url: `/v1/history?limit=1&before=${page1.items[0].id}`, headers: auth() })).json();
    expect(page2.items).toHaveLength(0);
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
    const rows = repo.listGenerations(apiKeyId, null, 10);
    expect(rows[0].status).toBe("ok");
    const img = JSON.parse(rows[0].images)[0];
    expect(img.file).toMatch(/\.png$/);
    expect(fs.existsSync(path.join(dir, "generated", img.file))).toBe(true);
  });
});
