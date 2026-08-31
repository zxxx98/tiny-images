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
import { EventEmitter } from "node:events";
import { requestSignal } from "../src/server/generations.js";
import type { FastifyReply, FastifyRequest } from "fastify";

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
let upstream: ReturnType<typeof Fastify>;
let dir: string;
let repo: Repo;
let app: Awaited<ReturnType<typeof buildApp>>;

let upstreamMode: "ok" | "rate-limited" = "ok";

beforeEach(async () => {
  upstream = Fastify();
  upstreamMode = "ok";
  upstream.post("/v1/images/generations", async (_req, reply) => {
    if (upstreamMode === "rate-limited") return reply.code(429).send({ error: { message: "slow down" } });
    return reply.send({ created: 42, data: [{ b64_json: PNG_B64 }, { b64_json: PNG_B64 }], usage: { total: 2 } });
  });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "vs-"));
  repo = new Repo(openDb(dir));
  await upstream.listen({ port: 0, host: "127.0.0.1" });
  const c = repo.createChannel({ name: "mock", baseUrl: `http://127.0.0.1:${(upstream.server.address() as { port: number }).port}/v1` });
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
});

afterEach(async () => {
  await app.close();
  await upstream.close();
  repo.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function parseEvents(body: string): { events: Record<string, unknown>[]; hasDone: boolean } {
  const frames = body.split("\n\n").filter((s) => s.startsWith("data: "));
  const hasDone = frames.some((f) => f === "data: [DONE]");
  const events = frames
    .filter((f) => f !== "data: [DONE]")
    .map((f) => JSON.parse(f.slice(6)) as Record<string, unknown>);
  return { events, hasDone };
}

describe("POST /v1/images/generations stream=true", () => {
  it("emits status, per-image, completed, [DONE]", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/images/generations",
      payload: { model: "img-1", prompt: "cat", stream: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    const { events, hasDone } = parseEvents(res.body);
    expect(events[0]).toEqual({ type: "status", stage: "submitted" });
    const imageEvents = events.filter((e) => e.type === "image");
    expect(imageEvents).toHaveLength(2);
    expect(imageEvents[0]).toMatchObject({ type: "image", index: 0, b64_json: PNG_B64 });
    const completed = events.find((e) => e.type === "completed") as { data: unknown[]; usage: unknown };
    expect(completed.data).toHaveLength(2);
    expect(completed.usage).toEqual({ total: 2 });
    expect(hasDone).toBe(true);
    expect(repo.recentLogs(1)[0].status).toBe("ok");
  });

  it("emits error event when upstream fails mid-stream", async () => {
    upstreamMode = "rate-limited";
    const res = await app.inject({
      method: "POST",
      url: "/v1/images/generations",
      payload: { model: "img-1", prompt: "cat", stream: true },
    });
    expect(res.statusCode).toBe(200);
    const { events, hasDone } = parseEvents(res.body);
    const error = events.find((e) => e.type === "error") as { error: { message: string } };
    expect(error.error.message).toContain("slow down");
    expect(hasDone).toBe(false);
    expect(repo.recentLogs(1)[0].status).toBe("error");
  });

  it("validation errors stay JSON before stream starts", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/images/generations",
      payload: { model: "img-1", stream: true },
    });
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.statusCode).toBe(400);
  });

  it("unmapped model stays JSON before stream starts", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/images/generations",
      payload: { model: "nope", prompt: "x", stream: true },
    });
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("model_not_found");
  });
});

describe("requestSignal", () => {
  it("aborts when the response socket closes before completion", () => {
    const requestRaw = new EventEmitter();
    const responseRaw = Object.assign(new EventEmitter(), { writableEnded: false });
    const signal = requestSignal(
      { raw: requestRaw } as unknown as FastifyRequest,
      { raw: responseRaw } as unknown as FastifyReply,
    );

    responseRaw.emit("close");

    expect(signal.aborted).toBe(true);
  });
});
