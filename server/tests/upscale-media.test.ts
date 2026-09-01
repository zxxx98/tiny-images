import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { ValidationError } from "../src/core/errors.js";
import {
  buildCloudflareUpscaleUrl,
  ConcurrencyLimiter,
  fetchCloudflareUpscale,
  saveUpscaleOutput,
  stageUpscaleInput,
  sweepExpiredUpscaleInputs,
  UpscaleError,
  validateUpscaleInput,
} from "../src/media/upscale.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const limits = { maxInputBytes: 1024 * 1024, maxInputPixels: 1_000_000, maxDimension: 8192, maxOutputBytes: 1024 * 1024 };

async function image(format: "png" | "jpeg" | "webp", width = 4, height = 3): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 0.5 } } })
    .toFormat(format)
    .toBuffer();
}

describe("upscale media validation", () => {
  it.each(["png", "jpeg", "webp"] as const)("accepts one %s and calculates target dimensions", async (format) => {
    const result = await validateUpscaleInput(await image(format), 4, limits);
    expect(result).toMatchObject({ format, sourceWidth: 4, sourceHeight: 3, targetWidth: 16, targetHeight: 12, scale: 4 });
  });

  it("uses EXIF-oriented dimensions", async () => {
    const jpeg = await sharp({ create: { width: 4, height: 3, channels: 3, background: "red" } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const result = await validateUpscaleInput(jpeg, 2, limits);
    expect(result).toMatchObject({ sourceWidth: 3, sourceHeight: 4, targetWidth: 6, targetHeight: 8 });
  });

  it("rejects bad magic, decoded pixel limits, animation, and target dimensions", async () => {
    await expect(validateUpscaleInput(Buffer.from("not an image"), 2, limits)).rejects.toBeInstanceOf(ValidationError);
    await expect(validateUpscaleInput(await image("png", 100, 100), 2, { ...limits, maxInputPixels: 99 })).rejects.toThrow(/pixel/);
    await expect(validateUpscaleInput(await image("png", 5, 2), 2, { ...limits, maxDimension: 9 })).rejects.toThrow(/dimensions/);
  });
});

describe("upscale staging and Cloudflare response", () => {
  it("stages random files, constructs the fixed same-zone URL, and cleans expired files", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "up-media-"));
    dirs.push(dir);
    const input = await validateUpscaleInput(await image("png"), 2, limits);
    const staged = stageUpscaleInput(dir, input);
    expect(staged.fileName).toMatch(/^[0-9a-f]{32}\.png$/);
    expect(buildCloudflareUpscaleUrl("https://images.example.com", staged.fileName, 8, 6)).toBe(
      `https://images.example.com/cdn-cgi/image/width=8,height=6,fit=contain,upscale=generate,format=auto/upscale-inputs/${staged.fileName}`,
    );
    fs.utimesSync(staged.fullPath, new Date(0), new Date(0));
    expect(sweepExpiredUpscaleInputs(dir, 1000, 2000)).toBe(1);
  });

  it("accepts a strict image response and saves it atomically", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "up-media-"));
    dirs.push(dir);
    const output = await image("webp", 8, 6);
    const result = await fetchCloudflareUpscale({
      url: "https://images.example.com/transform",
      timeoutMs: 10_000,
      maxOutputBytes: 1024 * 1024,
      targetWidth: 8,
      targetHeight: 6,
      fetchImpl: async (_url, init) => {
        expect(init?.headers).toEqual({ accept: "image/png,image/jpeg,image/webp" });
        expect(init).not.toHaveProperty("headers.authorization");
        return new Response(output, { headers: { "content-type": "image/webp" } });
      },
    });
    const file = saveUpscaleOutput(dir, result);
    expect(file).toMatch(/^[0-9a-f]{32}\.webp$/);
    expect(fs.readFileSync(path.join(dir, "generated", file))).toEqual(output);
    expect(fs.readdirSync(path.join(dir, "generated")).some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  it("rejects HTTP failures, non-images, body overflow, bad magic, and wrong dimensions", async () => {
    const base = { url: "https://images.example.com/x", timeoutMs: 10_000, maxOutputBytes: 1000, targetWidth: 8, targetHeight: 6 };
    await expect(fetchCloudflareUpscale({ ...base, fetchImpl: async () => new Response("limited", { status: 429 }) })).rejects.toThrow(/quota/);
    await expect(fetchCloudflareUpscale({ ...base, fetchImpl: async () => new Response("html", { headers: { "content-type": "text/html" } }) })).rejects.toBeInstanceOf(UpscaleError);
    await expect(fetchCloudflareUpscale({ ...base, maxOutputBytes: 3, fetchImpl: async () => new Response(await image("png", 8, 6), { headers: { "content-type": "image/png" } }) })).rejects.toThrow(/failed/);
    await expect(fetchCloudflareUpscale({ ...base, fetchImpl: async () => new Response("notpng", { headers: { "content-type": "image/png" } }) })).rejects.toThrow(/failed/);
    await expect(fetchCloudflareUpscale({ ...base, fetchImpl: async () => new Response(await image("png", 7, 6), { headers: { "content-type": "image/png" } }) })).rejects.toThrow(/failed/);
  });
});

describe("ConcurrencyLimiter", () => {
  it("queues above the configured concurrency", async () => {
    const limiter = new ConcurrencyLimiter(1);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let queued = false;
    const first = limiter.run(() => {}, async () => { await gate; return 1; });
    const second = limiter.run(() => { queued = true; }, async () => 2);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(queued).toBe(true);
    release();
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
  });
});
