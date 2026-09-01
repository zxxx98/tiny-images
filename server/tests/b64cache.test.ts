import Fastify from "fastify";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { conformImages, localizeImage, saveGeneratedImage, sweepExpired } from "../src/media/b64cache.js";

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
let upstream: ReturnType<typeof Fastify>;
let base: string;
let dir: string;
beforeEach(() => {
  upstream = Fastify();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "bc-"));
});
afterEach(async () => {
  await upstream.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
async function start(): Promise<string> {
  await upstream.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(upstream.server.address() as { port: number }).port}`;
  return base;
}

describe("conformImages", () => {
  it("keeps b64 when wanted, fetches url to b64 when needed", async () => {
    upstream.get("/img.png", async (_req, reply) => reply.type("image/png").send(Buffer.from(PNG_B64, "base64")));
    const base = await start();
    const out = await conformImages({
      images: [{ b64: PNG_B64 }, { url: `${base}/img.png` }],
      wanted: "b64_json",
      dataDir: dir,
      fileBaseUrl: base,
      fetchTimeoutMs: 5000,
    });
    expect(out[0].b64).toBe(PNG_B64);
    expect(out[1].b64).toBe(PNG_B64);
  });
  it("keeps url when wanted, saves b64 to file when needed", async () => {
    const base = await start();
    const out = await conformImages({
      images: [{ b64: PNG_B64 }],
      wanted: "url",
      dataDir: dir,
      fileBaseUrl: base,
      fetchTimeoutMs: 5000,
    });
    expect(out[0].url).toMatch(new RegExp(`^${base}/files/[0-9a-f]{32}\\.png$`));
    expect(fs.readdirSync(path.join(dir, "generated"))).toHaveLength(1);
  });
  it("propagates fetch failure", async () => {
    const base = await start();
    await expect(
      conformImages({
        images: [{ url: `${base}/missing.png` }],
        wanted: "b64_json",
        dataDir: dir,
        fileBaseUrl: base,
        fetchTimeoutMs: 1000,
      }),
    ).rejects.toMatchObject({ type: "upstream_error" });
  });
});

describe("saveGeneratedImage + sweepExpired", () => {
  it("sniffs png extension and sweeps old files", () => {
    const f = saveGeneratedImage(dir, PNG_B64);
    expect(f.fileName).toMatch(/\.png$/);
    expect(fs.readFileSync(path.join(dir, "generated", f.fileName))).toEqual(Buffer.from(PNG_B64, "base64"));
    const swept = sweepExpired(dir, -1); // ttl < 0 → 全部过期
    expect(swept).toBe(1);
    expect(sweepExpired(dir, 24 * 3600_000)).toBe(0);
  });
});

describe("localizeImage", () => {
  it("saves b64, downloads url, returns null on missing/failed content", async () => {
    const source = await sharp({
      create: { width: 2, height: 3, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 1 } },
    }).png().toBuffer();
    const sourceB64 = source.toString("base64");
    const fromB64 = await localizeImage(dir, { b64: sourceB64 }, 1000);
    expect(fromB64?.file).toMatch(/\.png$/);
    expect(fromB64).toMatchObject({ width: 2, height: 3 });
    expect(fs.existsSync(path.join(dir, "generated", fromB64!.file))).toBe(true);

    upstream.get("/img.png", async (_req, reply) => reply.type("image/png").send(source));
    const b = await start();
    const fromUrl = await localizeImage(dir, { url: `${b}/img.png` }, 5000);
    expect(fromUrl?.file).toMatch(/\.png$/);
    expect(fromUrl).toMatchObject({ width: 2, height: 3 });

    expect(await localizeImage(dir, {}, 1000)).toBeNull();
    expect(await localizeImage(dir, { url: "http://127.0.0.1:1/img.png" }, 1000)).toBeNull();
  });
});
