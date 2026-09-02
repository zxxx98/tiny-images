import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { lookup } from "node:dns/promises";
import ipaddr from "ipaddr.js";
import sharp from "sharp";
import { Agent } from "undici";
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

function isPublicIp(address: string): boolean {
  try {
    const parsed = ipaddr.process(address);
    if (parsed.kind() === "ipv6") {
      const ipv6 = parsed as ipaddr.IPv6;
      if (ipv6.isIPv4MappedAddress()) return isPublicIp(ipv6.toIPv4Address().toString());
    }
    return parsed.range() === "unicast";
  } catch {
    return false;
  }
}

async function assertSafeImageUrl(value: string, allowPrivateNetwork: boolean): Promise<URL> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UpstreamError(502, "upstream_error", "generated image URL is invalid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:" || url.username || url.password) {
    throw new UpstreamError(502, "upstream_error", "generated image URL is not allowed");
  }
  if (allowPrivateNetwork) return url;
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => !isPublicIp(address))) {
    throw new UpstreamError(502, "upstream_error", "generated image URL is not publicly routable");
  }
  return url;
}

async function fetchAsB64(
  value: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  allowPrivateNetwork = false,
): Promise<string> {
  const timeout = AbortSignal.timeout(timeoutMs);
  let url = await assertSafeImageUrl(value, allowPrivateNetwork);
  try {
    for (let redirects = 0; redirects <= 5; redirects++) {
      const dispatcher = allowPrivateNetwork ? null : new Agent({
        connect: {
          lookup(hostname, _options, callback) {
            lookup(hostname, { all: true, verbatim: true })
              .then((addresses) => {
                const address = addresses.find((item) => isPublicIp(item.address));
                if (!address || addresses.some((item) => !isPublicIp(item.address))) {
                  callback(new Error("image host is not publicly routable"), "", 0);
                  return;
                }
                callback(null, address.address, address.family);
              })
              .catch((err: unknown) => callback(err as Error, "", 0));
          },
        },
      });
      const res = await fetch(url, {
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        redirect: "manual",
        ...(dispatcher ? { dispatcher } : {}),
      } as RequestInit);
      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel();
        await dispatcher?.close();
        const location = res.headers.get("location");
        if (!location || redirects === 5) throw new UpstreamError(502, "upstream_error", "generated image redirect is invalid");
        url = await assertSafeImageUrl(new URL(location, url).toString(), allowPrivateNetwork);
        continue;
      }
      if (!res.ok) throw new UpstreamError(502, "upstream_error", `failed to fetch generated image: HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      await dispatcher?.close();
      return buf.toString("base64");
    }
  } catch (err) {
    if (err instanceof UpstreamError) throw err;
    throw new UpstreamError(502, "upstream_error", `failed to fetch generated image: ${err instanceof Error ? err.message : String(err)}`);
  }
  throw new UpstreamError(502, "upstream_error", "generated image redirect is invalid");
}

export interface ConformOptions {
  images: UnifiedImage[];
  wanted: "url" | "b64_json" | "auto";
  dataDir: string;
  fileBaseUrl: string;
  fetchTimeoutMs: number;
  signal?: AbortSignal;
  /** 仅供本地测试等可信网络使用，生产调用保持 false。 */
  allowPrivateNetwork?: boolean;
}

export async function conformImages(opts: ConformOptions): Promise<UnifiedImage[]> {
  if (opts.wanted === "auto") return opts.images;
  const out: UnifiedImage[] = [];
  for (const img of opts.images) {
    if (opts.wanted === "b64_json") {
      if (img.b64 !== undefined) {
        out.push(img);
      } else if (img.url !== undefined) {
        out.push({ ...img, b64: await fetchAsB64(img.url, opts.fetchTimeoutMs, opts.signal, opts.allowPrivateNetwork), url: undefined });
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
export async function localizeImage(dataDir: string, img: UnifiedImage, fetchTimeoutMs: number, allowPrivateNetwork = false): Promise<LocalizedImage | null> {
  try {
    const b64 = img.b64 !== undefined ? img.b64 : img.url !== undefined ? await fetchAsB64(img.url, fetchTimeoutMs, undefined, allowPrivateNetwork) : undefined;
    if (b64 === undefined) return null;
    const dimensions = await readImageDimensions(Buffer.from(b64, "base64"));
    return { file: saveGeneratedImage(dataDir, b64).fileName, ...dimensions };
  } catch {
    return null;
  }
}
