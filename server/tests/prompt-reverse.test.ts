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
import {
  decodeReverseImage,
  isReverseConfigured,
  REVERSE_INSTRUCTIONS,
  resolveReverseUpstream,
  type ReverseStyle,
} from "../src/core/promptReverse.js";
import { openDb } from "../src/store/db.js";
import { Repo } from "../src/store/repo.js";
import { hashPassword } from "../src/core/password.js";
import sharp from "sharp";

let upstream: ReturnType<typeof Fastify>;
let chatHandler: (req: { body: unknown }, reply: { code: (n: number) => { send: (body: unknown) => void } }) => Promise<void> | void;
let dir: string;
let repo: Repo;
let app: Awaited<ReturnType<typeof buildApp>>;
let H: { authorization: string };

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

beforeEach(async () => {
  upstream = Fastify();
  chatHandler = async (_req, reply) => {
    reply.code(200).send({ choices: [{ message: { content: "a prompt" } }] });
  };
  upstream.post("/v1/chat/completions", async (req, reply) => chatHandler(req as never, reply));
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pr-"));
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

async function configureReverse(style?: { promptReverse?: { baseUrl: string; apiKey: string; model: string } }): Promise<void> {
  const port = (upstream.server.address() as { port: number }).port;
  const res = await app.inject({
    method: "PUT",
    url: "/admin/settings",
    headers: H,
    payload: {
      globalPrompt: "",
      announcement: "",
      promptOptimizer: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "sk-opt", model: "gpt-4o-mini" },
      promptReverse: style?.promptReverse ?? { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "sk-rev", model: "qwen-vl" },
    },
  });
  expect(res.statusCode).toBe(200);
}

describe("prompt reverse settings", () => {
  it("saves and returns the reverse configuration", async () => {
    await configureReverse();
    const res = await app.inject({ url: "/admin/settings", headers: H });
    expect(res.json().promptReverse).toMatchObject({ apiKey: "sk-rev", model: "qwen-vl" });
  });

  it("keeps previous reverse config when omitted", async () => {
    await configureReverse();
    await app.inject({ method: "PUT", url: "/admin/settings", headers: H, payload: { globalPrompt: "", announcement: "" } });
    const res = await app.inject({ url: "/admin/settings", headers: H });
    expect(res.json().promptReverse.model).toBe("qwen-vl");
  });

  it("rejects a malformed promptReverse payload", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/admin/settings",
      headers: H,
      payload: { globalPrompt: "", announcement: "", promptReverse: { baseUrl: 1, apiKey: "", model: "" } },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("reverse upstream resolution", () => {
  it("prefers the dedicated reverse upstream and falls back to the optimizer one", () => {
    const optimizer = { baseUrl: "http://opt", apiKey: "a", model: "opt-model" };
    const reverse = { baseUrl: "http://rev", apiKey: "b", model: "rev-model" };
    expect(resolveReverseUpstream({ promptReverse: reverse, promptOptimizer: optimizer })).toEqual(reverse);
    expect(resolveReverseUpstream({ promptReverse: { baseUrl: "", apiKey: "", model: "" }, promptOptimizer: optimizer })).toEqual(optimizer);
    expect(isReverseConfigured({ promptReverse: { baseUrl: "", apiKey: "", model: "" }, promptOptimizer: { ...optimizer, model: "" } })).toBe(false);
  });
});

describe("decodeReverseImage", () => {
  it("accepts data URLs and raw base64", () => {
    expect(decodeReverseImage(`data:image/png;base64,${TINY_PNG_BASE64}`).mimeType).toBe("image/png");
    expect(decodeReverseImage(TINY_PNG_BASE64).buffer.length).toBeGreaterThan(0);
  });

  it("rejects empty, invalid or unsupported payloads", () => {
    expect(() => decodeReverseImage("   ")).toThrow();
    expect(() => decodeReverseImage("!!!not-base64!!!")).toThrow();
    expect(() => decodeReverseImage("data:image/svg+xml;base64,AAAA")).toThrow();
    expect(() => decodeReverseImage(`data:image/svg+xml;base64,${Buffer.from("<svg/>").toString("base64")}`)).toThrow();
  });
});

describe("POST /v1/prompt/reverse", () => {
  it("requires authentication", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/prompt/reverse", payload: { image: `data:image/png;base64,${TINY_PNG_BASE64}` } });
    expect(res.statusCode).toBe(401);
  });

  it("fails with a hint when not configured", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/prompt/reverse",
      headers: H,
      payload: { image: `data:image/png;base64,${TINY_PNG_BASE64}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain("图片反推未配置");
  });

  it("validates image and style fields", async () => {
    await configureReverse();
    const missing = await app.inject({ method: "POST", url: "/v1/prompt/reverse", headers: H, payload: { style: "concise" } });
    expect(missing.statusCode).toBe(400);
    const badStyle = await app.inject({
      method: "POST",
      url: "/v1/prompt/reverse",
      headers: H,
      payload: { image: `data:image/png;base64,${TINY_PNG_BASE64}`, style: "hentai" },
    });
    expect(badStyle.statusCode).toBe(400);
    expect(badStyle.json().error.message).toContain("concise");
    const badImage = await app.inject({ method: "POST", url: "/v1/prompt/reverse", headers: H, payload: { image: "not base64 %%%" } });
    expect(badImage.statusCode).toBe(400);
  });

  it.each(["concise", "detailed", "cinematic"] as ReverseStyle[])("sends the %s system instruction and a vision message upstream", async (style) => {
    await configureReverse();
    let received: unknown;
    chatHandler = async (req, reply) => {
      received = req.body;
      reply.code(200).send({ choices: [{ message: { content: "a red apple on a wooden table" } }] });
    };
    const res = await app.inject({
      method: "POST",
      url: "/v1/prompt/reverse",
      headers: H,
      payload: { image: `data:image/png;base64,${TINY_PNG_BASE64}`, style },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ prompt: "a red apple on a wooden table" });
    const body = received as {
      model: string;
      messages: { role: string; content: unknown }[];
    };
    expect(body.model).toBe("qwen-vl");
    expect(body.messages[0]).toEqual({ role: "system", content: REVERSE_INSTRUCTIONS[style] });
    const userContent = body.messages[1].content as { type: string; image_url?: { url: string } }[];
    expect(userContent[0].type).toBe("image_url");
    expect(userContent[0].image_url?.url).toMatch(/^data:image\/jpeg;base64,/);
    // 1x1 png 会被 sharp 转码后内联，url 不再是原始 png
    expect(userContent[0].image_url?.url).not.toContain(TINY_PNG_BASE64);
  });

  it("falls back to the optimizer upstream when no dedicated reverse config exists", async () => {
    const port = (upstream.server.address() as { port: number }).port;
    await app.inject({
      method: "PUT",
      url: "/admin/settings",
      headers: H,
      payload: {
        globalPrompt: "",
        announcement: "",
        promptOptimizer: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "sk-opt", model: "gpt-4o-mini" },
      },
    });
    let received: unknown;
    chatHandler = async (req, reply) => {
      received = req.body;
      reply.code(200).send({ choices: [{ message: { content: "fallback prompt" } }] });
    };
    const res = await app.inject({
      method: "POST",
      url: "/v1/prompt/reverse",
      headers: H,
      payload: { image: `data:image/png;base64,${TINY_PNG_BASE64}` },
    });
    expect(res.statusCode).toBe(200);
    expect((received as { model: string }).model).toBe("gpt-4o-mini");
  });

  it("downscales large images before sending upstream", async () => {
    await configureReverse();
    const big = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: "red" } }).png().toBuffer();
    let received: unknown;
    chatHandler = async (req, reply) => {
      received = req.body;
      reply.code(200).send({ choices: [{ message: { content: "ok" } }] });
    };
    const res = await app.inject({
      method: "POST",
      url: "/v1/prompt/reverse",
      headers: H,
      payload: { image: `data:image/png;base64,${big.toString("base64")}` },
    });
    expect(res.statusCode).toBe(200);
    const content = (received as { messages: { content: { type: string; image_url?: { url: string } }[] }[] }).messages[1].content;
    const url = content.find((part) => part.type === "image_url")!.image_url!.url;
    const decoded = Buffer.from(url.replace(/^data:image\/jpeg;base64,/, ""), "base64");
    const meta = await sharp(decoded).metadata();
    expect(meta.width).toBe(1536);
    expect(meta.height).toBeLessThanOrEqual(1536);
  });

  it("retries after a 429 and succeeds", async () => {
    await configureReverse();
    let calls = 0;
    chatHandler = async (_req, reply) => {
      calls += 1;
      if (calls === 1) {
        reply.code(429).send({ error: { message: "rate limited" } });
        return;
      }
      reply.code(200).send({ choices: [{ message: { content: "recovered" } }] });
    };
    const res = await app.inject({
      method: "POST",
      url: "/v1/prompt/reverse",
      headers: H,
      payload: { image: `data:image/png;base64,${TINY_PNG_BASE64}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ prompt: "recovered" });
    expect(calls).toBe(2);
  });

  it("does not retry on non-retryable 4xx errors", async () => {
    await configureReverse();
    let calls = 0;
    chatHandler = async (_req, reply) => {
      calls += 1;
      reply.code(401).send({ error: { message: "bad key" } });
    };
    const res = await app.inject({
      method: "POST",
      url: "/v1/prompt/reverse",
      headers: H,
      payload: { image: `data:image/png;base64,${TINY_PNG_BASE64}` },
    });
    expect(res.statusCode).toBe(401);
    expect(calls).toBe(1);
  });

  it("reports upstream errors when the chat response has no content", async () => {
    await configureReverse();
    chatHandler = async (_req, reply) => {
      reply.code(200).send({ choices: [] });
    };
    const res = await app.inject({
      method: "POST",
      url: "/v1/prompt/reverse",
      headers: H,
      payload: { image: `data:image/png;base64,${TINY_PNG_BASE64}` },
    });
    expect(res.statusCode).toBe(502);
  });

  it("exposes promptReverse availability through /v1/features", async () => {
    expect((await app.inject({ url: "/v1/features" })).json()).toEqual({ upscale: false, promptOptimizer: false, promptReverse: false });
    await configureReverse();
    expect((await app.inject({ url: "/v1/features" })).json()).toEqual({ upscale: false, promptOptimizer: true, promptReverse: true });
  });
});

describe("retry pacing", () => {
  it("does not actually sleep long between retries", async () => {
    await configureReverse();
    const sleep = vi.fn(async () => undefined);
    chatHandler = async (_req, reply) => {
      reply.code(429).send({ error: { message: "rate limited" } });
    };
    // 直接走 core 函数注入 sleep，避免端到端真等
    const { reverseImagePrompt } = await import("../src/core/promptReverse.js");
    await expect(
      reverseImagePrompt({
        settings: repo.getAppSettings(),
        image: `data:image/png;base64,${TINY_PNG_BASE64}`,
        style: "concise",
        sleep,
      }),
    ).rejects.toThrow("rate limited");
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});
