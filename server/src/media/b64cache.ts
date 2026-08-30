import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { UpstreamError } from "../core/errors.js";
import type { UnifiedImage } from "../core/types.js";

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

async function fetchAsB64(url: string, timeoutMs: number, signal: AbortSignal | undefined, channelName: string): Promise<string> {
  const timeout = AbortSignal.timeout(timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  } catch (err) {
    throw new UpstreamError(502, "upstream_error", `failed to fetch generated image: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) {
    throw new UpstreamError(502, "upstream_error", `failed to fetch generated image: HTTP ${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.toString("base64");
}

export interface ConformOptions {
  images: UnifiedImage[];
  wanted: "url" | "b64_json" | "auto";
  dataDir: string;
  fileBaseUrl: string;
  fetchTimeoutMs: number;
  signal?: AbortSignal;
}

export async function conformImages(opts: ConformOptions): Promise<UnifiedImage[]> {
  if (opts.wanted === "auto") return opts.images;
  const out: UnifiedImage[] = [];
  for (const img of opts.images) {
    if (opts.wanted === "b64_json") {
      if (img.b64 !== undefined) {
        out.push(img);
      } else if (img.url !== undefined) {
        out.push({ ...img, b64: await fetchAsB64(img.url, opts.fetchTimeoutMs, opts.signal, "upstream"), url: undefined });
      } else {
        out.push(img);
      }
    } else {
      if (img.url !== undefined) {
        out.push(img);
      } else if (img.b64 !== undefined) {
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
export async function localizeImage(dataDir: string, img: UnifiedImage, fetchTimeoutMs: number): Promise<{ file: string } | null> {
  try {
    if (img.b64 !== undefined) return { file: saveGeneratedImage(dataDir, img.b64).fileName };
    if (img.url !== undefined) {
      const b64 = await fetchAsB64(img.url, fetchTimeoutMs, undefined, "history");
      return { file: saveGeneratedImage(dataDir, b64).fileName };
    }
  } catch {
    return null;
  }
  return null;
}
