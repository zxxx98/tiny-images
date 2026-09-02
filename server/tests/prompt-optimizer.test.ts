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
import { extractOptimizedContent, OPTIMIZE_SYSTEM_PROMPT } from "../src/core/promptOptimizer.js";
import { openDb } from "../src/store/db.js";
import { Repo } from "../src/store/repo.js";
import { hashPassword } from "../src/core/password.js";

let upstream: ReturnType<typeof Fastify>;
let chatHandler: (req: { body: unknown }, reply: { code: (n: number) => { send: (body: unknown) => void } }) => Promise<void> | void;
let dir: string;
let repo: Repo;
let app: Awaited<ReturnType<typeof buildApp>>;
let H: { authorization: string };

beforeEach(async () => {
  upstream = Fastify();
  chatHandler = async (_req, reply) => {
    reply.code(200).send({ choices: [{ message: { content: "optimized" } }] });
  };
  upstream.post("/v1/chat/completions", async (req, reply) => chatHandler(req as never, reply));
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "po-"));
  repo = new Repo(openDb(dir));
  repo.createUser({ email: "admin@local", passwordHash: hashPassword("admin-pass"), role: "admin", quotaTotal: null });
  await upstream.listen({ port: 0, host: "127.0.0.1" });
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

async function configureOptimizer(): Promise<void> {
  const res = await app.inject({
    method: "PUT",
    url: "/admin/settings",
    headers: H,
    payload: {
      globalPrompt: "",
      announcement: "",
      promptOptimizer: { baseUrl: `http://127.0.0.1:${(upstream.server.address() as { port: number }).port}/v1`, apiKey: "sk-test", model: "gpt-4o-mini" },
    },
  });
  expect(res.statusCode).toBe(200);
}

describe("prompt optimizer settings", () => {
  it("saves and returns the AI configuration", async () => {
    await configureOptimizer();
    const res = await app.inject({ url: "/admin/settings", headers: H });
    expect(res.json()).toMatchObject({ promptOptimizer: { apiKey: "sk-test", model: "gpt-4o-mini" } });
    expect(res.json().promptOptimizer.baseUrl).toContain("/v1");
  });

  it("keeps previous AI config when promptOptimizer is omitted", async () => {
    await configureOptimizer();
    await app.inject({ method: "PUT", url: "/admin/settings", headers: H, payload: { globalPrompt: "gp", announcement: "an" } });
    const res = await app.inject({ url: "/admin/settings", headers: H });
    expect(res.json().promptOptimizer.model).toBe("gpt-4o-mini");
    expect(res.json().globalPrompt).toBe("gp");
  });

  it("rejects a malformed promptOptimizer payload", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/admin/settings",
      headers: H,
      payload: { globalPrompt: "", announcement: "", promptOptimizer: { baseUrl: 1, apiKey: "", model: "" } },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("POST /v1/prompt/optimize", () => {
  it("requires authentication", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/prompt/optimize", payload: { prompt: "a cat" } });
    expect(res.statusCode).toBe(401);
  });

  it("fails with a hint when not configured", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/prompt/optimize", headers: H, payload: { prompt: "a cat" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain("提示词优化未配置");
  });

  it("validates the prompt field", async () => {
    await configureOptimizer();
    const empty = await app.inject({ method: "POST", url: "/v1/prompt/optimize", headers: H, payload: { prompt: "   " } });
    expect(empty.statusCode).toBe(400);
    const missing = await app.inject({ method: "POST", url: "/v1/prompt/optimize", headers: H, payload: {} });
    expect(missing.statusCode).toBe(400);
  });

  it("optimizes the prompt via the configured chat upstream", async () => {
    await configureOptimizer();
    let received: unknown;
    chatHandler = async (req, reply) => {
      received = req.body;
      reply.code(200).send({ choices: [{ message: { content: "一只橘猫在窗台晒太阳，电影感光线" } }] });
    };
    const res = await app.inject({ method: "POST", url: "/v1/prompt/optimize", headers: H, payload: { prompt: "橘猫 晒太阳" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ prompt: "一只橘猫在窗台晒太阳，电影感光线" });
    const body = received as { model: string; messages: { role: string; content: string }[] };
    expect(body.model).toBe("gpt-4o-mini");
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[0].content).toBe(OPTIMIZE_SYSTEM_PROMPT);
    expect(body.messages[1]).toEqual({ role: "user", content: "橘猫 晒太阳" });
  });

  it("retries after a 429 and succeeds", async () => {
    await configureOptimizer();
    let calls = 0;
    chatHandler = async (_req, reply) => {
      calls += 1;
      if (calls === 1) {
        reply.code(429).send({ error: { message: "rate limited" } });
        return;
      }
      reply.code(200).send({ choices: [{ message: { content: "recovered" } }] });
    };
    const res = await app.inject({ method: "POST", url: "/v1/prompt/optimize", headers: H, payload: { prompt: "a cat" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ prompt: "recovered" });
    expect(calls).toBe(2);
  });

  it("retries on 5xx and succeeds honoring a fast retry-after", async () => {
    await configureOptimizer();
    let calls = 0;
    chatHandler = async (_req, reply) => {
      calls += 1;
      if (calls < 3) {
        reply.code(500).send({ error: { message: "boom" } });
        return;
      }
      reply.code(200).send({ choices: [{ message: { content: "finally" } }] });
    };
    const res = await app.inject({ method: "POST", url: "/v1/prompt/optimize", headers: H, payload: { prompt: "a cat" } });
    expect(res.statusCode).toBe(200);
    expect(calls).toBe(3);
  });

  it("gives up after exhausting retries on persistent 429", async () => {
    await configureOptimizer();
    const handler = vi.fn(async (_req: unknown, reply: { code: (n: number) => { send: (b: unknown) => void } }) => {
      reply.code(429).send({ error: { message: "rate limited" } });
    });
    chatHandler = handler;
    const res = await app.inject({ method: "POST", url: "/v1/prompt/optimize", headers: H, payload: { prompt: "a cat" } });
    expect(res.statusCode).toBe(429);
    expect(res.json().error.message).toContain("rate limited");
    expect(handler).toHaveBeenCalledTimes(3);
  }, 10_000);

  it("does not retry on non-retryable 4xx errors", async () => {
    await configureOptimizer();
    let calls = 0;
    chatHandler = async (_req, reply) => {
      calls += 1;
      reply.code(401).send({ error: { message: "bad key" } });
    };
    const res = await app.inject({ method: "POST", url: "/v1/prompt/optimize", headers: H, payload: { prompt: "a cat" } });
    expect(res.statusCode).toBe(401);
    expect(calls).toBe(1);
  });

  it("reports upstream errors when the chat response has no content", async () => {
    await configureOptimizer();
    chatHandler = async (_req, reply) => {
      reply.code(200).send({ choices: [] });
    };
    const res = await app.inject({ method: "POST", url: "/v1/prompt/optimize", headers: H, payload: { prompt: "a cat" } });
    expect(res.statusCode).toBe(502);
  });

  it("exposes promptOptimizer availability through /v1/features", async () => {
    expect((await app.inject({ url: "/v1/features" })).json()).toEqual({ upscale: false, promptOptimizer: false });
    await configureOptimizer();
    expect((await app.inject({ url: "/v1/features" })).json()).toEqual({ upscale: false, promptOptimizer: true });
  });
});

describe("extractOptimizedContent", () => {
  it("unwraps markdown fences and surrounding quotes", () => {
    expect(extractOptimizedContent({ choices: [{ message: { content: "```text\ntext\n```" } }] })).toBe("text");
    expect(extractOptimizedContent({ choices: [{ message: { content: '  "a cat, cinematic"  ' } }] })).toBe("a cat, cinematic");
    expect(extractOptimizedContent({ choices: [{ message: { content: "「一只猫」" } }] })).toBe("一只猫");
  });

  it("rejects empty content", () => {
    expect(() => extractOptimizedContent({ choices: [{ message: { content: "   " } }] })).toThrow();
    expect(() => extractOptimizedContent(null)).toThrow();
    expect(() => extractOptimizedContent({ choices: [{ message: { content: 42 } }] })).toThrow();
  });
});
