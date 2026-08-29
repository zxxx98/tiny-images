import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UpstreamError } from "../src/core/errors.js";
import type { CallContext, UnifiedGenRequest } from "../src/core/types.js";
import { OpenAICompatProvider } from "../src/providers/openai-compat.js";

let upstream: ReturnType<typeof Fastify>;
let baseUrl: string;

beforeEach(() => {
  upstream = Fastify();
});
afterEach(async () => {
  await upstream.close();
});

async function start(): Promise<string> {
  await upstream.listen({ port: 0, host: "127.0.0.1" });
  baseUrl = `http://127.0.0.1:${(upstream.server.address() as { port: number }).port}/v1`;
  return baseUrl;
}

const channel = (over: Partial<CallContext["channel"]> = {}): CallContext["channel"] => ({
  id: 1,
  name: "mock",
  type: "openai-compat",
  baseUrl,
  timeoutMs: 5000,
  editMode: "auto",
  extraHeaders: {},
  enabled: true,
  ...over,
});
const ctx = (over: Partial<CallContext> = {}): CallContext => ({
  channel: channel(),
  upstreamModel: "gpt-image-1",
  apiKey: "sk-upstream",
  signal: new AbortController().signal,
  ...over,
});
const gen = (over: Partial<UnifiedGenRequest> = {}): UnifiedGenRequest => ({
  prompt: "a cat",
  n: 1,
  responseFormat: "b64_json",
  passthrough: {},
  ...over,
});

describe("OpenAICompatProvider.generate", () => {
  it("posts correct payload and parses b64 images", async () => {
    let seen: unknown = null;
    let seenAuth = "";
    let seenPath = "";
    upstream.post("/v1/images/generations", async (req, reply) => {
      seen = req.body;
      seenAuth = req.headers.authorization ?? "";
      seenPath = req.url;
      return reply.send({ created: 123, data: [{ b64_json: "QUJD", revised_prompt: "a big cat" }] });
    });
    await start();
    const r = await new OpenAICompatProvider().generate(gen({ n: 2, size: "1024x1024", quality: "high" }), ctx());
    expect(seenPath).toBe("/v1/images/generations");
    expect(seen).toEqual({ model: "gpt-image-1", prompt: "a cat", n: 2, size: "1024x1024", quality: "high" });
    expect(seenAuth).toBe("Bearer sk-upstream");
    expect(r.created).toBe(123);
    expect(r.images).toEqual([{ b64: "QUJD", revisedPrompt: "a big cat" }]);
  });

  it("parses url responses and preserves extra top-level fields in raw", async () => {
    upstream.post("/v1/images/generations", async (_req, reply) =>
      reply.send({ created: 1, data: [{ url: "http://x/y.png" }], usage: { total: 1 } }),
    );
    await start();
    const r = await new OpenAICompatProvider().generate(gen({ responseFormat: "url" }), ctx());
    expect(r.images).toEqual([{ url: "http://x/y.png" }]);
    expect((r.raw as { usage: unknown }).usage).toEqual({ total: 1 });
  });

  it("merges extraHeaders", async () => {
    let seenExtra = "";
    upstream.post("/v1/images/generations", async (req, reply) => {
      seenExtra = String(req.headers["x-extra"] ?? "");
      return reply.send({ created: 1, data: [] });
    });
    await start();
    await new OpenAICompatProvider().generate(gen(), ctx({ channel: channel({ extraHeaders: { "x-extra": "1" } }) }));
    expect(seenExtra).toBe("1");
  });

  it("maps upstream errors and network failures", async () => {
    upstream.post("/v1/images/generations", async (_req, reply) => reply.code(401).send({ error: { message: "nope" } }));
    await start();
    await expect(new OpenAICompatProvider().generate(gen(), ctx())).rejects.toMatchObject({ httpStatus: 401, code: "invalid_api_key" });

    const bad = ctx({ channel: channel({ baseUrl: "http://127.0.0.1:1/v1" }) });
    await expect(new OpenAICompatProvider().generate(gen(), bad)).rejects.toBeInstanceOf(UpstreamError);
  });

  it("rejects malformed responses", async () => {
    upstream.post("/v1/images/generations", async (_req, reply) => reply.send({ unexpected: true }));
    await start();
    await expect(new OpenAICompatProvider().generate(gen(), ctx())).rejects.toMatchObject({ type: "upstream_error" });
  });
});

describe("OpenAICompatProvider.test", () => {
  it("reports ok on 200 and failure otherwise", async () => {
    let seenAuth = "";
    upstream.get("/v1/models", async (req, reply) => {
      seenAuth = String(req.headers.authorization ?? "<none>");
      return reply.send({ object: "list", data: [] });
    });
    await start();
    const p = new OpenAICompatProvider();
    expect((await p.test(channel(), "sk-x")).ok).toBe(true);
    expect(seenAuth).toBe("Bearer sk-x");
    expect((await p.test(channel(), null)).ok).toBe(true);
    expect(seenAuth).toBe("<none>");
    upstream.get("/v1/models", async (_req, reply) => reply.code(500).send({}));
    expect((await p.test(channel(), "sk-x")).ok).toBe(false);
  });
});
