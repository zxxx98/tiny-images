import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { Executor } from "../src/core/executor.js";
import { KeyPool } from "../src/core/keyPool.js";
import { ModelRouter } from "../src/core/router.js";
import type { CloudflareImagesEnv } from "../src/env.js";
import { JobManager } from "../src/server/jobs.js";
import { openDb } from "../src/store/db.js";
import { Repo } from "../src/store/repo.js";

let dir: string;
let repo: Repo;
let app: Awaited<ReturnType<typeof buildApp>>;
let apiKeyId: number;
let apiKey: string;
const originalFetch = globalThis.fetch;

const cf: CloudflareImagesEnv = {
  enabled: true,
  baseUrl: "https://images.example.com",
  timeoutMs: 10_000,
  maxInputBytes: 1024 * 1024,
  maxInputPixels: 1_000_000,
  maxDimension: 8192,
  maxOutputBytes: 1024 * 1024,
  concurrency: 2,
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "vup-"));
  repo = new Repo(openDb(dir));
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  if (app) await app.close();
  repo.close();
  fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function start(cloudflareImages: CloudflareImagesEnv = cf): Promise<void> {
  const created = repo.createApiKey("k1");
  apiKeyId = created.id;
  apiKey = created.key;
  const router = new ModelRouter(repo);
  const keyPool = new KeyPool(repo);
  const providers = new Map();
  app = await buildApp({
    env: { port: 0, dataDir: dir, publicBaseUrl: "https://api.example.com", cloudflareImages },
    repo,
    router,
    keyPool,
    providers,
    executor: new Executor({ router, keyPool, providers, repo }),
    jobManager: new JobManager(),
    logger: false,
    webDist: null,
  });
}

const auth = () => ({ authorization: `Bearer ${apiKey}` });

async function source(width = 4, height = 3): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 1 } } }).png().toBuffer();
}

async function formRequest(files: Buffer[], fields: Record<string, string> = {}) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  for (const file of files) form.append("image", new Blob([file], { type: "image/png" }), "source.png");
  const request = new Request("http://local/", { method: "POST", body: form });
  return app.inject({
    method: "POST",
    url: "/v1/images/upscale-jobs",
    headers: { ...auth(), "content-type": request.headers.get("content-type")! },
    payload: Buffer.from(await request.arrayBuffer()),
  });
}

async function waitJob(jobId: string): Promise<Record<string, unknown>> {
  let poll = await app.inject({ url: `/v1/images/jobs/${jobId}`, headers: auth() });
  for (let i = 0; i < 100 && poll.json().status === "running"; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    poll = await app.inject({ url: `/v1/images/jobs/${jobId}`, headers: auth() });
  }
  return poll.json();
}

describe("Cloudflare upscale API", () => {
  it("exposes the feature flag and returns the configured disabled error", async () => {
    await start({ ...cf, enabled: false, baseUrl: null });
    expect((await app.inject({ url: "/v1/features" })).json()).toEqual({ upscale: false, promptOptimizer: false });
    const res = await formRequest([await source()]);
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toEqual({
      message: "图片超分未在当前部署中启用",
      type: "service_unavailable",
      code: "upscale_not_configured",
    });
    expect(repo.listGenerations({ admin: true, userId: null, apiKeyId: null }, null, 10)).toHaveLength(0);
  });

  it("validates all multipart data before staging history or jobs", async () => {
    await start();
    expect((await formRequest([], {})).statusCode).toBe(400);
    expect((await formRequest([await source(), await source()])).statusCode).toBe(400);
    expect((await formRequest([Buffer.from("bad")])).statusCode).toBe(400);
    expect((await formRequest([await source()], { scale: "3" })).statusCode).toBe(400);
    expect((await formRequest([await source()], { response_format: "b64_json" })).statusCode).toBe(400);
    const rows = repo.listGenerations({ admin: false, userId: null, apiKeyId }, null, 20);
    expect(rows).toHaveLength(0);
    expect(fs.existsSync(path.join(dir, "upscale-inputs"))).toBe(false);
  });

  it("enforces the configured upload byte limit while reading multipart", async () => {
    await start({ ...cf, maxInputBytes: 32 });
    const res = await formRequest([await source()]);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain("32-byte input limit");
    expect(repo.listGenerations({ admin: false, userId: null, apiKeyId }, null, 10)).toHaveLength(0);
    expect(fs.existsSync(path.join(dir, "upscale-inputs"))).toBe(false);
  });

  it("completes a job, writes history, serves final output, and removes staging", async () => {
    await start();
    const output = await sharp(await source()).resize(8, 6).webp().toBuffer();
    globalThis.fetch = vi.fn(async (url, init) => {
      expect(String(url)).toMatch(/^https:\/\/images\.example\.com\/cdn-cgi\/image\/width=8,height=6,fit=contain,upscale=generate,format=auto\/upscale-inputs\/[0-9a-f]{32}\.png$/);
      expect(init?.headers).toEqual({ accept: "image/png,image/jpeg,image/webp" });
      return new Response(output, { headers: { "content-type": "image/webp" } });
    }) as typeof fetch;

    const created = await formRequest([await source()], { scale: "2" });
    expect(created.statusCode).toBe(200);
    const body = await waitJob(created.json().jobId);
    expect(body).toMatchObject({ kind: "upscale", status: "ok", progress: "超分完成", channel: null, error: null });
    const images = body.images as { file: string; url: string; width?: number; height?: number }[];
    expect(images[0]).toMatchObject({ width: 8, height: 6 });
    expect(images[0].url).toBe(`https://api.example.com/files/${images[0].file}`);
    expect(fs.existsSync(path.join(dir, "generated", images[0].file))).toBe(true);
    expect(fs.readdirSync(path.join(dir, "upscale-inputs"))).toHaveLength(0);
    const served = await app.inject({ url: `/files/${images[0].file}` });
    expect(served.statusCode).toBe(200);
    expect(served.headers["content-type"]).toBe("image/webp");

    const row = repo.listGenerations({ admin: false, userId: null, apiKeyId }, null, 1)[0];
    expect(row).toMatchObject({ model: "cloudflare-images-upscale", prompt: "图片超分", status: "ok", channelId: null });
    expect(JSON.parse(row.params)).toEqual({
      operation: "upscale",
      scale: 2,
      sourceWidth: 4,
      sourceHeight: 3,
      targetWidth: 8,
      targetHeight: 6,
      engine: "cloudflare-images-esrgan",
    });
    expect(JSON.parse(row.images)).toEqual([{ file: images[0].file, width: 8, height: 6 }]);
  });

  it("leaves staging for TTL and records sanitized failure without final output", async () => {
    await start();
    globalThis.fetch = vi.fn(async () => new Response("upstream secret details", { status: 500 })) as typeof fetch;
    const created = await formRequest([await source()]);
    const body = await waitJob(created.json().jobId);
    expect(body).toMatchObject({ kind: "upscale", status: "error", progress: "超分失败，可重试", error: "upscale failed", images: [] });
    expect(fs.readdirSync(path.join(dir, "upscale-inputs"))).toHaveLength(1);
    expect(fs.existsSync(path.join(dir, "generated"))).toBe(false);
    const row = repo.listGenerations({ admin: false, userId: null, apiKeyId }, null, 1)[0];
    expect(row.status).toBe("error");
    expect(row.errorMessage).toBe("upscale failed");
    expect(row.errorMessage).not.toContain("secret");
  });

  it("serves only strict random staging paths", async () => {
    await start();
    const stageDir = path.join(dir, "upscale-inputs");
    fs.mkdirSync(stageDir);
    const name = `${"a".repeat(32)}.png`;
    fs.writeFileSync(path.join(stageDir, name), await source());
    expect((await app.inject({ url: `/upscale-inputs/${name}` })).statusCode).toBe(200);
    expect((await app.inject({ url: "/upscale-inputs/not-random.png" })).statusCode).toBe(404);
    expect((await app.inject({ url: `/upscale-inputs/${"a".repeat(32)}.jpeg` })).statusCode).toBe(404);
  });
});
