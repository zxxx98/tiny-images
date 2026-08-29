import Fastify from "fastify";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { conformImages, saveGeneratedImage, sweepExpired } from "../src/media/b64cache.js";

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
let upstream: ReturnType<typeof Fastify>;
let base: string;
let dir: string;
beforeEach(async () => {
  upstream = Fastify();
  await upstream.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(upstream.server.address() as { port: number }).port}`;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "bc-"));
});
afterEach(async () => {
  await upstream.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("conformImages", () => {
  it("keeps b64 when wanted, fetches url to b64 when needed", async () => {
    upstream.get("/img.png", async (_req, reply) => reply.type("image/png").send(Buffer.from(PNG_B64, "base64")));
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
