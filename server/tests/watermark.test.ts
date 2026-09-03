import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { Executor } from "../src/core/executor.js";
import { KeyPool } from "../src/core/keyPool.js";
import { ModelRouter } from "../src/core/router.js";
import { OpenAICompatProvider } from "../src/providers/openai-compat.js";
import { openDb } from "../src/store/db.js";
import { Repo } from "../src/store/repo.js";
import { hashPassword } from "../src/core/password.js";
import { applyWatermark, composeWatermarkText } from "../src/media/watermark.js";
import { DEFAULT_WATERMARK_STYLE } from "../src/store/repo.js";

let dir: string;
let repo: Repo;
let app: Awaited<ReturnType<typeof buildApp>>;
let H: { authorization: string };
let H2: { authorization: string };
const FILE_NAME = `${"ab".repeat(16)}.png`;

async function login(email: string, password: string): Promise<{ authorization: string }> {
  const res = await app.inject({ method: "POST", url: "/admin/auth/login", payload: { email, password } });
  return { authorization: `Bearer ${(res.json() as { token: string }).token}` };
}

async function writeFixtureImage(): Promise<Buffer> {
  const generatedDir = path.join(dir, "generated");
  fs.mkdirSync(generatedDir, { recursive: true });
  const buf = await sharp({ create: { width: 96, height: 48, channels: 3, background: { r: 40, g: 40, b: 40 } } }).png().toBuffer();
  fs.writeFileSync(path.join(generatedDir, FILE_NAME), buf);
  return buf;
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "wm-"));
  repo = new Repo(openDb(dir));
  repo.createUser({ email: "admin@local", passwordHash: hashPassword("admin-pass"), role: "admin", quotaTotal: null });
  repo.createUser({ email: "user@local", passwordHash: hashPassword("user-pass"), role: "user", quotaTotal: 100 });
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
  H = await login("admin@local", "admin-pass");
  H2 = await login("user@local", "user-pass");
});

afterEach(async () => {
  await app.close();
  repo.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("watermark text composition", () => {
  it("joins prefix and user text, dropping empty parts", () => {
    expect(composeWatermarkText("tiny-images", "张三")).toBe("tiny-images · 张三");
    expect(composeWatermarkText("", "张三")).toBe("张三");
    expect(composeWatermarkText("tiny-images", "  ")).toBe("tiny-images");
    expect(composeWatermarkText(" ", "")).toBe("");
  });

  it("applyWatermark keeps dimensions and changes bytes", async () => {
    const buf = await sharp({ create: { width: 96, height: 48, channels: 3, background: { r: 0, g: 0, b: 0 } } }).png().toBuffer();
    const out = await applyWatermark(buf, DEFAULT_WATERMARK_STYLE, "张三");
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(96);
    expect(meta.height).toBe(48);
    expect(Buffer.compare(buf, out)).not.toBe(0);
  });

  it("applyWatermark returns the original buffer for empty text", async () => {
    const buf = await sharp({ create: { width: 32, height: 32, channels: 3, background: { r: 0, g: 0, b: 0 } } }).png().toBuffer();
    expect(Buffer.compare(await applyWatermark(buf, DEFAULT_WATERMARK_STYLE, ""), buf)).toBe(0);
    expect(Buffer.compare(await applyWatermark(buf, { ...DEFAULT_WATERMARK_STYLE, prefix: "" }, "  "), buf)).toBe(0);
  });
});

describe("user watermark config endpoints", () => {
  it("requires authentication", async () => {
    expect((await app.inject({ url: "/v1/watermark" })).statusCode).toBe(401);
    expect((await app.inject({ method: "PUT", url: "/v1/watermark", payload: { enabled: true, text: "x" } })).statusCode).toBe(401);
    expect((await app.inject({ url: `/v1/download/${FILE_NAME}` })).statusCode).toBe(401);
  });

  it("saves and reads the per-user watermark", async () => {
    const saved = await app.inject({ method: "PUT", url: "/v1/watermark", headers: H2, payload: { enabled: true, text: "  张三  " } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({ enabled: true, text: "张三" });
    expect((await app.inject({ url: "/v1/watermark", headers: H2 })).json()).toEqual({ enabled: true, text: "张三" });
  });

  it("isolates watermark config per user", async () => {
    await app.inject({ method: "PUT", url: "/v1/watermark", headers: H2, payload: { enabled: true, text: "user" } });
    expect((await app.inject({ url: "/v1/watermark", headers: H })).json()).toEqual({ enabled: false, text: "" });
  });

  it("rejects invalid payloads", async () => {
    expect((await app.inject({ method: "PUT", url: "/v1/watermark", headers: H2, payload: { text: "x" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PUT", url: "/v1/watermark", headers: H2, payload: { enabled: "yes" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PUT", url: "/v1/watermark", headers: H2, payload: { enabled: true, text: "x".repeat(61) } })).statusCode).toBe(400);
  });
});

describe("download endpoint", () => {
  it("serves the original bytes when watermark is disabled", async () => {
    const original = await writeFixtureImage();
    const res = await app.inject({ url: `/v1/download/${FILE_NAME}`, headers: H2 });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-disposition"]).toContain("attachment");
    expect(Buffer.compare(res.rawPayload, original)).toBe(0);
  });

  it("applies the watermark once enabled without changing dimensions", async () => {
    const original = await writeFixtureImage();
    await app.inject({ method: "PUT", url: "/v1/watermark", headers: H2, payload: { enabled: true, text: "张三" } });
    const res = await app.inject({ url: `/v1/download/${FILE_NAME}`, headers: H2 });
    expect(res.statusCode).toBe(200);
    expect(Buffer.compare(res.rawPayload, original)).not.toBe(0);
    const meta = await sharp(res.rawPayload).metadata();
    expect(meta.width).toBe(96);
    expect(meta.height).toBe(48);

    // 未启用的用户拿到仍是原图字节
    const plain = await app.inject({ url: `/v1/download/${FILE_NAME}`, headers: H });
    expect(Buffer.compare(plain.rawPayload, original)).toBe(0);
  });

  it("404 on unknown or invalid file names", async () => {
    expect((await app.inject({ url: "/v1/download/does-not-exist.png", headers: H2 })).statusCode).toBe(404);
    expect((await app.inject({ url: "/v1/download/../escape.png", headers: H2 })).statusCode).toBe(404);
    const missing = `${"cd".repeat(16)}.png`;
    expect((await app.inject({ url: `/v1/download/${missing}`, headers: H2 })).statusCode).toBe(404);
  });
});

describe("admin watermark style settings", () => {
  const STYLE = { position: "tl", fontSize: 32, opacity: 0.8, color: "#ffcc00", prefix: "站名" };

  it("saves and returns the central watermark style", async () => {
    const saved = await app.inject({
      method: "PUT",
      url: "/admin/settings",
      headers: H,
      payload: { globalPrompt: "", announcement: "", watermarkStyle: STYLE },
    });
    expect(saved.statusCode).toBe(200);
    expect((saved.json() as { watermarkStyle: unknown }).watermarkStyle).toEqual(STYLE);
    expect((await app.inject({ url: "/admin/settings", headers: H })).json()).toMatchObject({ watermarkStyle: STYLE });
  });

  it("rejects invalid style values", async () => {
    const cases = [
      { ...STYLE, position: "middle" },
      { ...STYLE, fontSize: 8 },
      { ...STYLE, opacity: 0 },
      { ...STYLE, color: "white" },
      { ...STYLE, prefix: "x".repeat(41) },
    ];
    for (const watermarkStyle of cases) {
      const res = await app.inject({
        method: "PUT",
        url: "/admin/settings",
        headers: H,
        payload: { globalPrompt: "", announcement: "", watermarkStyle },
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it("rejects non-admin callers", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/admin/settings",
      headers: H2,
      payload: { globalPrompt: "", announcement: "", watermarkStyle: STYLE },
    });
    expect(res.statusCode).toBe(403);
  });
});
