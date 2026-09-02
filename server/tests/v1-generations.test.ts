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

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
let upstream: ReturnType<typeof Fastify>;
let dir: string;
let repo: Repo;
let app: Awaited<ReturnType<typeof buildApp>>;

beforeEach(async () => {
  upstream = Fastify();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "vg-"));
  repo = new Repo(openDb(dir));
});

afterEach(async () => {
  await app.close();
  await upstream.close();
  repo.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function start(generationMode: "images" | "chat" = "images"): Promise<void> {
  await upstream.listen({ port: 0, host: "127.0.0.1" });
  const c = repo.createChannel({ name: "mock", baseUrl: `http://127.0.0.1:${(upstream.server.address() as { port: number }).port}/v1`, generationMode });
  repo.createKey(c.id, "sk-upstream");
  repo.createModel({ publicName: "img-1", channelId: c.id, upstreamName: "gpt-image-1" });
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
}

describe("POST /v1/images/generations", () => {
  it("uses a chat-only upstream but returns the Images API shape", async () => {
    let body: Record<string, unknown> = {};
    upstream.post("/v1/chat/completions", async (req, reply) => {
      body = req.body as Record<string, unknown>;
      return reply.send({
        created: 42,
        choices: [{ message: { content: "done", images: [{ type: "image_url", image_url: { url: `data:image/png;base64,${PNG_B64}` } }] } }],
      });
    });
    await start("chat");

    const res = await app.inject({ method: "POST", url: "/v1/images/generations", payload: { model: "img-1", prompt: "cat" } });

    expect(body).toMatchObject({ model: "gpt-image-1", messages: [{ role: "user", content: "cat" }], modalities: ["text", "image"] });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ created: 42, data: [{ b64_json: PNG_B64 }] });
  });

  it("returns openai shape with b64 and logs ok", async () => {
    upstream.post("/v1/images/generations", async (_req, reply) =>
      reply.send({ created: 42, data: [{ b64_json: PNG_B64, revised_prompt: "rev" }], usage: { total: 1 } }),
    );
    await start();
    const res = await app.inject({ method: "POST", url: "/v1/images/generations", payload: { model: "img-1", prompt: "cat" } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.created).toBe(42);
    expect(body.data[0]).toEqual({ b64_json: PNG_B64, revised_prompt: "rev" });
    expect(body.usage).toEqual({ total: 1 });
    expect(res.headers["x-tiny-channel"]).toBe("mock");
    expect(Number(res.headers["x-tiny-latency-ms"])).toBeGreaterThanOrEqual(0);
    expect(repo.recentLogs(1)[0].status).toBe("ok");
  });

  it("passes through url when upstream returns url and client wants url", async () => {
    upstream.post("/v1/images/generations", async (_req, reply) => reply.send({ created: 1, data: [{ url: "http://example.test/x.png" }] }));
    await start();
    const res = await app.inject({
      method: "POST",
      url: "/v1/images/generations",
      payload: { model: "img-1", prompt: "cat", response_format: "url" },
    });
    expect(res.json().data[0].url).toBe("http://example.test/x.png");
  });

  it("rejects a private upstream image URL when client wants b64", async () => {
    upstream.get("/x.png", async (_req, reply) => reply.type("image/png").send(Buffer.from(PNG_B64, "base64")));
    upstream.post("/v1/images/generations", async (_req, reply) =>
      reply.send({ created: 1, data: [{ url: `http://127.0.0.1:${(upstream.server.address() as { port: number }).port}/x.png` }] }),
    );
    await start();
    const res = await app.inject({
      method: "POST",
      url: "/v1/images/generations",
      payload: { model: "img-1", prompt: "cat", response_format: "b64_json" },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.message).toContain("not publicly routable");
  });

  it("converts upstream b64 to file url when client wants url", async () => {
    upstream.post("/v1/images/generations", async (_req, reply) => reply.send({ created: 1, data: [{ b64_json: PNG_B64 }] }));
    await start();
    const res = await app.inject({
      method: "POST",
      url: "/v1/images/generations",
      payload: { model: "img-1", prompt: "cat", response_format: "url" },
    });
    expect(res.json().data[0].url).toMatch(/\/files\/[0-9a-f]{32}\.png$/);
    // 生成的文件可以被取回
    const file = await app.inject({ url: res.json().data[0].url.replace("http://localhost", "") });
    expect(file.statusCode).toBe(404); // files 路由在 Task 13 之前未注册，仅验证 url 形态
  });

  it("keeps safe usage while hiding global prompt echoes from responses and history", async () => {
    let upstreamPrompt = "";
    upstream.post("/v1/images/generations", async (req, reply) => {
      upstreamPrompt = (req.body as { prompt: string }).prompt;
      return reply.send({
        created: 1,
        prompt: upstreamPrompt,
        data: [{ b64_json: PNG_B64, revised_prompt: upstreamPrompt }],
        usage: { total_tokens: 12, note: upstreamPrompt },
      });
    });
    await start();
    repo.updateAppSettings({ globalPrompt: "secret policy", announcement: "" });

    const res = await app.inject({ method: "POST", url: "/v1/images/generations", payload: { model: "img-1", prompt: "cat" } });

    expect(upstreamPrompt).toBe("secret policy\ncat");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ data: [{ b64_json: PNG_B64 }], usage: { total_tokens: 12 } });
    expect(res.json().data[0].revised_prompt).toBeUndefined();
    expect(res.json().prompt).toBeUndefined();
    expect(res.json().usage.note).toBeUndefined();
    const history = repo.listGenerations({ admin: true, userId: null, apiKeyId: null }, null, 1)[0];
    expect(history.prompt).toBe("cat");
    expect(history.images).not.toContain("secret policy");
  });

  it("400 on invalid body", async () => {
    await start();
    expect((await app.inject({ method: "POST", url: "/v1/images/generations", payload: { model: "img-1" } })).statusCode).toBe(400);
    expect(
      (await app.inject({ method: "POST", url: "/v1/images/generations", payload: { model: "img-1", prompt: "x", n: 11 } })).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: "POST", url: "/v1/images/generations", payload: { model: "img-1", prompt: "x", size: "giant" } })).statusCode,
    ).toBe(400);
  });

  it("404 on unmapped model", async () => {
    await start();
    const res = await app.inject({ method: "POST", url: "/v1/images/generations", payload: { model: "nope", prompt: "x" } });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("model_not_found");
  });

  it("maps upstream failures to openai errors", async () => {
    upstream.post("/v1/images/generations", async (_req, reply) => reply.code(400).send({ error: { message: "bad prompt", code: "bad_prompt" } }));
    await start();
    const res = await app.inject({ method: "POST", url: "/v1/images/generations", payload: { model: "img-1", prompt: "cat" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain("bad prompt");
    expect(repo.recentLogs(1)[0].status).toBe("error");
  });
});

describe("GET /v1/models", () => {
  it("lists enabled mappings only", async () => {
    await start();
    repo.createModel({ publicName: "off", channelId: repo.listChannels()[0].id, enabled: false });
    const res = await app.inject({ url: "/v1/models" });
    expect(res.json()).toEqual({ object: "list", data: [{ id: "img-1", object: "model", owned_by: "tiny-images" }] });
  });
});
