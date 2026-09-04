import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { UpstreamError } from "../core/errors.js";
import type { UnifiedImage } from "../core/types.js";
import {
  DEFAULT_IMAGE_FETCH_MAX_BYTES,
  DEFAULT_IMAGE_FETCH_MAX_PIXELS,
  fetchValidatedImage,
  validateImageBuffer,
} from "./safeImageFetch.js";

function generatedDir(dataDir: string): string {
  const dir = path.join(dataDir, "generated");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sniffExt(buf: Buffer): string {
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return ".png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return ".jpg";
  if (buf.length >= 12 && buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") return ".webp";
  return ".png";
}

export function saveGeneratedImage(dataDir: string, b64: string): { fileName: string } {
  const buf = Buffer.from(b64, "base64");
  const fileName = `${randomBytes(16).toString("hex")}${sniffExt(buf)}`;
  fs.writeFileSync(path.join(generatedDir(dataDir), fileName), buf);
  return { fileName };
}

export interface LocalizedImage {
  file: string;
  width: number;
  height: number;
}

async function readImageDimensions(buffer: Buffer): Promise<{ width: number; height: number }> {
  const metadata = await sharp(buffer, { failOn: "error" }).metadata();
  const width = metadata.autoOrient?.width ?? metadata.width;
  const height = metadata.autoOrient?.height ?? metadata.height;
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new Error("generated image has no valid dimensions");
  }
  return { width, height };
}

export function sweepExpired(dataDir: string, ttlMs: number): number {
  const dir = path.join(dataDir, "generated");
  if (!fs.existsSync(dir)) return 0;
  const cutoff = Date.now() - ttlMs;
  let swept = 0;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    try {
      if (fs.statSync(full).mtimeMs < cutoff) {
        fs.unlinkSync(full);
        swept++;
      }
    } catch {
      // 文件可能已被并发删除
    }
  }
  return swept;
}

async function decodeValidatedB64(b64: string, maxBytes: number, maxPixels: number): Promise<Buffer> {
  if (b64.length > Math.ceil(maxBytes * 4 / 3) + 4) {
    throw new UpstreamError(502, "upstream_error", "generated image exceeds the configured size limit");
  }
  const buffer = Buffer.from(b64, "base64");
  await validateImageBuffer(buffer, maxBytes, maxPixels);
  return buffer;
}

export interface ConformOptions {
  images: UnifiedImage[];
  wanted: "url" | "b64_json" | "auto";
  dataDir: string;
  fileBaseUrl: string;
  fetchTimeoutMs: number;
  allowPrivateNetwork?: boolean;
  maxBytes?: number;
  maxPixels?: number;
  signal?: AbortSignal;
}

export async function conformImages(opts: ConformOptions): Promise<UnifiedImage[]> {
  if (opts.wanted === "auto") return opts.images;
  const maxBytes = opts.maxBytes ?? DEFAULT_IMAGE_FETCH_MAX_BYTES;
  const maxPixels = opts.maxPixels ?? DEFAULT_IMAGE_FETCH_MAX_PIXELS;
  const out: UnifiedImage[] = [];
  for (const img of opts.images) {
    if (opts.wanted === "b64_json") {
      if (img.b64 !== undefined) {
        await decodeValidatedB64(img.b64, maxBytes, maxPixels);
        out.push(img);
      } else if (img.url !== undefined) {
        const buffer = await fetchValidatedImage(img.url, {
          timeoutMs: opts.fetchTimeoutMs,
          maxBytes,
          maxPixels,
          allowPrivateNetwork: opts.allowPrivateNetwork,
          signal: opts.signal,
        });
        out.push({ ...img, b64: buffer.toString("base64"), url: undefined });
      } else {
        out.push(img);
      }
    } else {
      if (img.url !== undefined) {
        out.push(img);
      } else if (img.b64 !== undefined) {
        await decodeValidatedB64(img.b64, maxBytes, maxPixels);
        const { fileName } = saveGeneratedImage(opts.dataDir, img.b64);
        out.push({ ...img, url: `${opts.fileBaseUrl}/files/${fileName}`, b64: undefined });
      } else {
        out.push(img);
      }
    }
  }
  return out;
}

// 结果图片本地化供历史引用；下载失败不影响主流程，返回 null
export async function localizeImage(
  dataDir: string,
  img: UnifiedImage,
  fetchTimeoutMs: number,
  options: Pick<ConformOptions, "allowPrivateNetwork" | "maxBytes" | "maxPixels"> = {},
): Promise<LocalizedImage | null> {
  try {
    const maxBytes = options.maxBytes ?? DEFAULT_IMAGE_FETCH_MAX_BYTES;
    const maxPixels = options.maxPixels ?? DEFAULT_IMAGE_FETCH_MAX_PIXELS;
    const buffer = img.b64 !== undefined
      ? await decodeValidatedB64(img.b64, maxBytes, maxPixels)
      : img.url !== undefined
        ? await fetchValidatedImage(img.url, {
          timeoutMs: fetchTimeoutMs,
          maxBytes,
          maxPixels,
          allowPrivateNetwork: options.allowPrivateNetwork,
        })
        : undefined;
    if (buffer === undefined) return null;
    const dimensions = await readImageDimensions(buffer);
    return { file: saveGeneratedImage(dataDir, buffer.toString("base64")).fileName, ...dimensions };
  } catch {
    return null;
  }
}
