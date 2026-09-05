import { lookup } from "node:dns/promises";
import ipaddr from "ipaddr.js";
import { Agent, fetch, type Response } from "undici";
import sharp from "sharp";
import { UpstreamError } from "../core/errors.js";

export const DEFAULT_IMAGE_FETCH_MAX_BYTES = 50 * 1024 * 1024;
export const DEFAULT_IMAGE_FETCH_MAX_PIXELS = 40_000_000;

export interface SafeImageFetchOptions {
  timeoutMs: number;
  maxBytes?: number;
  maxPixels?: number;
  allowPrivateNetwork?: boolean;
  signal?: AbortSignal;
}

interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

function denied(message: string): UpstreamError {
  return new UpstreamError(502, "upstream_error", message);
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

function parseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw denied("generated image URL is invalid");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw denied("generated image URL is not allowed");
  }
  return url;
}

async function resolveAddress(url: URL, allowPrivateNetwork: boolean): Promise<ResolvedAddress> {
  let addresses: { address: string; family: number }[];
  try {
    addresses = await lookup(url.hostname, { all: true, verbatim: true });
  } catch {
    throw denied("generated image host could not be resolved");
  }
  if (!addresses.length) throw denied("generated image host could not be resolved");
  if (!allowPrivateNetwork && addresses.some((item) => !isPublicIp(item.address))) {
    throw denied("generated image URL is not publicly routable");
  }
  const target = addresses[0];
  if (target.family !== 4 && target.family !== 6) throw denied("generated image host could not be resolved");
  return { address: target.address, family: target.family };
}

async function readBody(response: Response, maxBytes: number): Promise<Buffer> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > maxBytes)) {
    await response.body?.cancel();
    throw denied("generated image exceeds the configured size limit");
  }
  if (!response.body) throw denied("generated image response has no body");
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw denied("generated image exceeds the configured size limit");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

export async function validateImageBuffer(buffer: Buffer, maxBytes = DEFAULT_IMAGE_FETCH_MAX_BYTES, maxPixels = DEFAULT_IMAGE_FETCH_MAX_PIXELS): Promise<void> {
  if (buffer.length === 0 || buffer.length > maxBytes) throw denied("generated image exceeds the configured size limit");
  try {
    const metadata = await sharp(buffer, { failOn: "error" }).metadata();
    const width = metadata.autoOrient?.width ?? metadata.width;
    const height = metadata.autoOrient?.height ?? metadata.height;
    if (!metadata.format || !["png", "jpeg", "webp"].includes(metadata.format) || !width || !height || width * height > maxPixels) {
      throw denied("generated image format or dimensions are not allowed");
    }
  } catch (err) {
    if (err instanceof UpstreamError) throw err;
    throw denied("generated image format or dimensions are not allowed");
  }
}

export async function fetchValidatedImage(value: string, options: SafeImageFetchOptions): Promise<Buffer> {
  const maxBytes = options.maxBytes ?? DEFAULT_IMAGE_FETCH_MAX_BYTES;
  const maxPixels = options.maxPixels ?? DEFAULT_IMAGE_FETCH_MAX_PIXELS;
  const allowPrivateNetwork = options.allowPrivateNetwork === true;
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let url = parseUrl(value);

  for (let redirects = 0; redirects <= 5; redirects++) {
    const target = await resolveAddress(url, allowPrivateNetwork);
    const dispatcher = new Agent({
      connect: {
        lookup(_hostname, options, callback) {
          // Node 20+ 默认 Happy Eyeballs 以 all:true 调用 lookup 并要求数组结果；
          // 返回单地址字符串会让 net 报 ERR_INVALID_IP_ADDRESS，所有域名下载全部失败
          if (options.all) {
            callback(null, [{ address: target.address, family: target.family }]);
          } else {
            callback(null, target.address, target.family);
          }
        },
      },
    });
    try {
      const response = await fetch(url, { dispatcher, redirect: "manual", signal });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        const location = response.headers.get("location");
        if (!location || redirects === 5) throw denied("generated image redirect is invalid");
        url = parseUrl(new URL(location, url).toString());
        continue;
      }
      if (!response.ok) throw denied(`failed to fetch generated image: HTTP ${response.status}`);
      const buffer = await readBody(response, maxBytes);
      await validateImageBuffer(buffer, maxBytes, maxPixels);
      return buffer;
    } catch (err) {
      if (err instanceof UpstreamError) throw err;
      throw denied("failed to fetch generated image");
    } finally {
      await dispatcher.close();
    }
  }
  throw denied("generated image redirect is invalid");
}
