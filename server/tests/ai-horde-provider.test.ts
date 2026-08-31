import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CallContext, UnifiedGenRequest } from "../src/core/types.js";

let upstream: ReturnType<typeof Fastify>;
let baseUrl = "";

beforeEach(() => {
  upstream = Fastify();
});

afterEach(async () => {
  await upstream.close();
});

async function start(): Promise<void> {
  await upstream.listen({ port: 0, host: "127.0.0.1" });
  baseUrl = `http://127.0.0.1:${(upstream.server.address() as { port: number }).port}/api/v2`;
}

function ctx(over: Partial<CallContext> = {}): CallContext {
  return {
    channel: {
      id: 1,
      name: "horde",
      type: "ai-horde",
      baseUrl,
      timeoutMs: 5000,
      editMode: "auto",
      extraHeaders: {},
      enabled: true,
    },
    upstreamModel: "stable_diffusion",
    apiKey: "horde-key",
    signal: new AbortController().signal,
    ...over,
  };
}

function gen(over: Partial<UnifiedGenRequest> = {}): UnifiedGenRequest {
  return { prompt: "a cat", n: 1, responseFormat: "url", passthrough: {}, ...over };
}

describe("AIHordeProvider", () => {
  it("is available as a native image provider", async () => {
    const module = await import("../src/providers/ai-horde.js").catch(() => ({}));
    expect(module).toHaveProperty("AIHordeProvider");
  });

  it("submits, polls, and maps Horde results with protected OpenAI precedence", async () => {
    let submitBody: Record<string, unknown> = {};
    let submitHeaders: Record<string, string | string[] | undefined> = {};
    let checkCalls = 0;
    let statusCalls = 0;
    upstream.post("/api/v2/generate/async", async (request) => {
      submitBody = request.body as Record<string, unknown>;
      submitHeaders = request.headers;
      return { id: "task-1" };
    });
    upstream.get("/api/v2/generate/check/task-1", async () => {
      checkCalls++;
      return checkCalls < 3 ? { done: false, is_possible: true } : { done: true, is_possible: true };
    });
    upstream.get("/api/v2/generate/status/task-1", async () => {
      statusCalls++;
      return {
        done: true,
        generations: [{ img: "https://img.example/result.webp", seed: "123", model: "stable_diffusion", censored: false }],
      };
    });
    await start();
    const { AIHordeProvider } = await import("../src/providers/ai-horde.js");
    const sleeps: number[] = [];
    const provider = new AIHordeProvider({ pollIntervalMs: 2000, sleep: async (ms) => { sleeps.push(ms); } });

    const result = await provider.generate(gen({
      n: 2,
      size: "1024x768",
      quality: "high",
      providerOptions: {
        horde: {
          nsfw: true,
          params: { n: 9, width: 512, height: 512, steps: 25, seed: "123" },
        },
      },
    }), ctx({
      channel: {
        ...ctx().channel,
        extraHeaders: { APIKEY: "override", "client-agent": "override", "content-type": "text/plain" },
      },
    }));

    expect(submitBody).toMatchObject({
      prompt: "a cat",
      models: ["stable_diffusion"],
      nsfw: true,
      r2: true,
      params: { n: 2, width: 1024, height: 768, steps: 25, seed: "123" },
    });
    expect(submitBody).not.toHaveProperty("quality");
    expect(submitHeaders.apikey).toBe("horde-key");
    expect(submitHeaders["client-agent"]).toBe("tiny-images:0.1.0:github.com/zxxx98/tiny-images");
    expect(checkCalls).toBe(3);
    expect(statusCalls).toBe(1);
    expect(sleeps).toEqual([2000, 2000]);
    expect(result.images).toEqual([{ url: "https://img.example/result.webp" }]);
    expect(result.raw).toMatchObject({ generations: [{ seed: "123", model: "stable_diffusion" }] });
    expect(result.includeRawResponseFields).toBe(false);
  });

  it("keeps explicit Horde dimensions when OpenAI size is auto", async () => {
    let submitBody: Record<string, unknown> = {};
    upstream.post("/api/v2/generate/async", async (request) => {
      submitBody = request.body as Record<string, unknown>;
      return { id: "task-auto" };
    });
    upstream.get("/api/v2/generate/check/task-auto", async () => ({ done: true, is_possible: true }));
    upstream.get("/api/v2/generate/status/task-auto", async () => ({ generations: [{ img: "https://img.example/auto.webp" }] }));
    await start();
    const { AIHordeProvider } = await import("../src/providers/ai-horde.js");

    await new AIHordeProvider().generate(gen({
      size: "auto",
      providerOptions: { horde: { params: { width: 640, height: 896 } } },
    }), ctx());

    expect(submitBody.params).toMatchObject({ n: 1, width: 640, height: 896 });
  });

  it.each([
    [400, 400, "invalid_request_error"],
    [401, 401, "invalid_request_error"],
    [403, 403, "invalid_request_error"],
    [429, 429, "rate_limit_error"],
    [503, 503, "service_unavailable"],
    [500, 502, "upstream_error"],
  ] as const)("maps submit HTTP %s before acceptance", async (upstreamStatus, expectedStatus, expectedType) => {
    upstream.post("/api/v2/generate/async", async (_request, reply) => reply.code(upstreamStatus).send({ message: "safe upstream detail" }));
    await start();
    const { AIHordeProvider } = await import("../src/providers/ai-horde.js");

    const error = await new AIHordeProvider().generate(gen(), ctx()).catch((value: unknown) => value);

    expect(error).toMatchObject({ httpStatus: expectedStatus, type: expectedType, keyRetrySafe: true });
    expect((error as Error).message).toContain("safe upstream detail");
  });

  it("maps impossible and faulted checks without allowing resubmission", async () => {
    let mode: "impossible" | "faulted" = "impossible";
    upstream.post("/api/v2/generate/async", async () => ({ id: "task-error" }));
    upstream.get("/api/v2/generate/check/task-error", async () => mode === "impossible"
      ? { done: false, is_possible: false }
      : { done: false, faulted: true, is_possible: true });
    await start();
    const { AIHordeProvider } = await import("../src/providers/ai-horde.js");
    const provider = new AIHordeProvider({ sleep: async () => undefined });

    await expect(provider.generate(gen(), ctx())).rejects.toMatchObject({ httpStatus: 503, type: "service_unavailable", keyRetrySafe: false });
    mode = "faulted";
    await expect(provider.generate(gen(), ctx())).rejects.toMatchObject({ httpStatus: 502, type: "upstream_error", keyRetrySafe: false });
  });

  it("rejects malformed task and empty final results", async () => {
    upstream.post("/api/v2/generate/async", async (request) => request.headers["x-empty"] ? { id: "task-empty" } : { unexpected: true });
    upstream.get("/api/v2/generate/check/task-empty", async () => ({ done: true, is_possible: true }));
    upstream.get("/api/v2/generate/status/task-empty", async () => ({ generations: [] }));
    await start();
    const { AIHordeProvider } = await import("../src/providers/ai-horde.js");
    const provider = new AIHordeProvider();

    await expect(provider.generate(gen(), ctx())).rejects.toMatchObject({ httpStatus: 502, keyRetrySafe: true });
    await expect(provider.generate(gen(), ctx({ channel: { ...ctx().channel, extraHeaders: { "x-empty": "1" } } })))
      .rejects.toMatchObject({ httpStatus: 502, keyRetrySafe: false });
  });

  it("applies one overall channel timeout to polling", async () => {
    upstream.post("/api/v2/generate/async", async () => ({ id: "task-slow" }));
    upstream.get("/api/v2/generate/check/task-slow", async () => ({ done: false, is_possible: true }));
    await start();
    const { AIHordeProvider } = await import("../src/providers/ai-horde.js");

    await expect(new AIHordeProvider().generate(gen(), ctx({ channel: { ...ctx().channel, timeoutMs: 20 } })))
      .rejects.toMatchObject({ httpStatus: 504, type: "timeout", keyRetrySafe: false });
  });

  it("tests heartbeat and registered or anonymous keys without generating", async () => {
    const seen: Array<{ path: string; apikey?: string; agent?: string }> = [];
    upstream.get("/api/v2/status/heartbeat", async (request) => {
      seen.push({ path: request.url, apikey: request.headers.apikey as string | undefined, agent: request.headers["client-agent"] as string | undefined });
      return { message: "horde alive" };
    });
    upstream.get("/api/v2/find_user", async (request) => {
      seen.push({ path: request.url, apikey: request.headers.apikey as string | undefined, agent: request.headers["client-agent"] as string | undefined });
      return { username: request.headers.apikey === "0000000000" ? "Anonymous" : "Registered" };
    });
    await start();
    const { AIHordeProvider } = await import("../src/providers/ai-horde.js");
    const provider = new AIHordeProvider();
    const channel = ctx().channel;

    expect(await provider.test(channel, null)).toMatchObject({ ok: true });
    expect(await provider.test(channel, "registered-key")).toMatchObject({ ok: true });
    expect(await provider.test(channel, "0000000000")).toMatchObject({ ok: true });
    expect(seen).toEqual([
      { path: "/api/v2/status/heartbeat", apikey: undefined, agent: "tiny-images:0.1.0:github.com/zxxx98/tiny-images" },
      { path: "/api/v2/find_user", apikey: "registered-key", agent: "tiny-images:0.1.0:github.com/zxxx98/tiny-images" },
      { path: "/api/v2/find_user", apikey: "0000000000", agent: "tiny-images:0.1.0:github.com/zxxx98/tiny-images" },
    ]);
  });
});
