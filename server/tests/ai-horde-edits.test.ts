import Fastify from "fastify";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CallContext, IncomingImage, UnifiedEditRequest } from "../src/core/types.js";
import { AIHordeProvider } from "../src/providers/ai-horde.js";

let upstream: ReturnType<typeof Fastify>;
let baseUrl = "";
let submitBodies: Record<string, unknown>[];

beforeEach(() => {
  upstream = Fastify();
  submitBodies = [];
  let id = 0;
  upstream.post("/api/v2/generate/async", async (request) => {
    submitBodies.push(request.body as Record<string, unknown>);
    id++;
    return { id: `edit-${id}` };
  });
  upstream.get("/api/v2/generate/check/:id", async () => ({ done: true, is_possible: true }));
  upstream.get("/api/v2/generate/status/:id", async (request) => ({ generations: [{ img: `https://img.example/${(request.params as { id: string }).id}.webp` }] }));
});

afterEach(async () => {
  await upstream.close();
});

async function start(): Promise<void> {
  await upstream.listen({ port: 0, host: "127.0.0.1" });
  baseUrl = `http://127.0.0.1:${(upstream.server.address() as { port: number }).port}/api/v2`;
}

function context(signal = new AbortController().signal): CallContext {
  return {
    channel: { id: 1, name: "horde", type: "ai-horde", baseUrl, timeoutMs: 5000, editMode: "auto", extraHeaders: {}, enabled: true },
    upstreamModel: "stable_diffusion",
    apiKey: "horde-key",
    signal,
  };
}

function edit(images: IncomingImage[], mask?: IncomingImage): UnifiedEditRequest {
  return { prompt: "paint it blue", n: 1, responseFormat: "url", images, mask, passthrough: {} };
}

async function image(format: "png" | "jpeg" | "webp", width = 2, height = 2, filename = `source.${format}`): Promise<IncomingImage> {
  const pipeline = sharp({ create: { width, height, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.5 } } });
  const data = await pipeline[format]().toBuffer();
  return { filename, data, mimeType: `image/${format}` };
}

describe("AIHordeProvider.edit", () => {
  it("converts PNG, JPEG, and WebP sources into base64 WebP img2img requests", async () => {
    await start();
    const provider = new AIHordeProvider();

    for (const format of ["png", "jpeg", "webp"] as const) {
      await provider.edit(edit([await image(format)]), context());
    }

    expect(submitBodies).toHaveLength(3);
    for (const body of submitBodies) {
      expect(body.source_processing).toBe("img2img");
      expect(body).not.toHaveProperty("source_mask");
      const metadata = await sharp(Buffer.from(body.source_image as string, "base64")).metadata();
      expect(metadata.format).toBe("webp");
    }
  });

  it("converts a matching mask and selects inpainting", async () => {
    await start();
    const provider = new AIHordeProvider();

    await provider.edit(edit([await image("png")], await image("png", 2, 2, "mask.png")), context());

    expect(submitBodies[0]).toMatchObject({ source_processing: "inpainting" });
    const mask = await sharp(Buffer.from(submitBodies[0].source_mask as string, "base64")).metadata();
    expect(mask.format).toBe("webp");
  });

  it("rejects multiple, broken, and mismatched edit inputs before submission", async () => {
    await start();
    const provider = new AIHordeProvider();
    const source = await image("png");

    await expect(provider.edit(edit([source, source]), context())).rejects.toThrow("exactly one image");
    await expect(provider.edit(edit([{ filename: "broken.png", data: Buffer.from("broken"), mimeType: "image/png" }]), context()))
      .rejects.toMatchObject({ name: "ValidationError" });
    await expect(provider.edit(edit([source], await image("png", 3, 2, "mask.png")), context())).rejects.toThrow("mask dimensions");
    expect(submitBodies).toHaveLength(0);
  });

  it("exposes a guard for inputs above forty million pixels", async () => {
    const module = await import("../src/providers/ai-horde-images.js").catch(() => ({}));
    expect(module).toHaveProperty("assertPixelLimit");
    expect(() => (module as { assertPixelLimit: (width: number, height: number) => void }).assertPixelLimit(10_000, 4_001))
      .toThrow("40000000 pixels");
  });
});
