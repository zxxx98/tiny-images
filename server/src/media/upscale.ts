import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { ValidationError } from "../core/errors.js";

export type SupportedImageFormat = "png" | "jpeg" | "webp";

export interface UpscaleLimits {
  maxInputBytes: number;
  maxInputPixels: number;
  maxDimension: number;
  maxOutputBytes: number;
}

export interface ValidatedUpscaleInput {
  data: Buffer;
  format: SupportedImageFormat;
  extension: "png" | "jpg" | "webp";
  sourceWidth: number;
  sourceHeight: number;
  targetWidth: number;
  targetHeight: number;
  scale: 2 | 4;
}

export interface StagedUpscaleInput {
  fileName: string;
  fullPath: string;
}

export interface UpscaleOutput {
  buffer: Buffer;
  format: SupportedImageFormat;
  extension: "png" | "jpg" | "webp";
  width: number;
  height: number;
}

export class UpscaleError extends Error {
  constructor(
    message: string,
    public readonly diagnostic?: string,
  ) {
    super(message);
    this.name = "UpscaleError";
  }
}

function extensionFor(format: SupportedImageFormat): ValidatedUpscaleInput["extension"] {
  return format === "jpeg" ? "jpg" : format;
}

export function sniffImageFormat(buf: Buffer): SupportedImageFormat | null {
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) return "png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf.length >= 12 && buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") return "webp";
  return null;
}

export async function validateUpscaleInput(
  data: Buffer,
  scale: 2 | 4,
  limits: Pick<UpscaleLimits, "maxInputBytes" | "maxInputPixels" | "maxDimension">,
): Promise<ValidatedUpscaleInput> {
  if (data.length === 0) throw new ValidationError("'image' file is empty");
  if (data.length > limits.maxInputBytes) throw new ValidationError(`'image' exceeds the ${limits.maxInputBytes}-byte input limit`);
  const magicFormat = sniffImageFormat(data);
  if (!magicFormat) throw new ValidationError("'image' must be a PNG, JPEG, or WebP image");

  let metadata: Awaited<ReturnType<ReturnType<typeof sharp>["metadata"]>>;
  try {
    metadata = await sharp(data, { limitInputPixels: limits.maxInputPixels, failOn: "error" }).metadata();
  } catch {
    throw new ValidationError("'image' is invalid or exceeds the decoded pixel limit");
  }
  if (metadata.format !== magicFormat || !metadata.width || !metadata.height || (metadata.pages ?? 1) !== 1) {
    throw new ValidationError("'image' must be one valid, non-animated PNG, JPEG, or WebP image");
  }
  const sourceWidth = metadata.autoOrient?.width ?? metadata.width;
  const sourceHeight = metadata.autoOrient?.height ?? metadata.height;
  if (sourceWidth * sourceHeight > limits.maxInputPixels) {
    throw new ValidationError(`'image' exceeds the ${limits.maxInputPixels}-pixel input limit`);
  }
  const targetWidth = sourceWidth * scale;
  const targetHeight = sourceHeight * scale;
  if (!Number.isSafeInteger(targetWidth) || !Number.isSafeInteger(targetHeight) || Math.max(targetWidth, targetHeight) > limits.maxDimension) {
    throw new ValidationError(`upscale target dimensions must not exceed ${limits.maxDimension}px`);
  }
  return {
    data,
    format: magicFormat,
    extension: extensionFor(magicFormat),
    sourceWidth,
    sourceHeight,
    targetWidth,
    targetHeight,
    scale,
  };
}

function stageDir(dataDir: string): string {
  const dir = path.join(dataDir, "upscale-inputs");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function generatedDir(dataDir: string): string {
  const dir = path.join(dataDir, "generated");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function stageUpscaleInput(dataDir: string, input: ValidatedUpscaleInput): StagedUpscaleInput {
  const fileName = `${randomBytes(16).toString("hex")}.${input.extension}`;
  const fullPath = path.join(stageDir(dataDir), fileName);
  fs.writeFileSync(fullPath, input.data, { flag: "wx", mode: 0o600 });
  return { fileName, fullPath };
}

export function removeStagedUpscaleInput(fullPath: string): void {
  try {
    fs.unlinkSync(fullPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

export function sweepExpiredUpscaleInputs(dataDir: string, ttlMs: number, now = Date.now()): number {
  const dir = path.join(dataDir, "upscale-inputs");
  if (!fs.existsSync(dir)) return 0;
  const cutoff = now - ttlMs;
  let swept = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!/^[0-9a-f]{32}\.(?:png|jpg|webp)$/.test(name)) continue;
    const full = path.join(dir, name);
    try {
      const stat = fs.statSync(full);
      if (stat.isFile() && stat.mtimeMs < cutoff) {
        fs.unlinkSync(full);
        swept++;
      }
    } catch {
      // 文件可能已被并发删除
    }
  }
  return swept;
}

export function buildCloudflareUpscaleUrl(
  baseUrl: string,
  stagedFileName: string,
  targetWidth: number,
  targetHeight: number,
): string {
  if (!/^[0-9a-f]{32}\.(?:png|jpg|webp)$/.test(stagedFileName)) throw new Error("invalid staged upscale file name");
  const sourcePath = `/upscale-inputs/${stagedFileName}`;
  const options = `width=${targetWidth},height=${targetHeight},fit=contain,upscale=generate,format=auto`;
  return `${baseUrl.replace(/\/$/, "")}/cdn-cgi/image/${options}${sourcePath}`;
}

async function readLimitedBody(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) throw new UpscaleError("upscale failed", "Cloudflare returned an empty response body");
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new UpscaleError("upscale failed", `Cloudflare output content-length ${contentLength} exceeds limit`);
  }
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
        throw new UpscaleError("upscale failed", `Cloudflare output exceeded ${maxBytes} bytes`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

export async function fetchCloudflareUpscale(input: {
  url: string;
  timeoutMs: number;
  maxOutputBytes: number;
  targetWidth: number;
  targetHeight: number;
  fetchImpl?: typeof fetch;
}): Promise<UpscaleOutput> {
  const fetchImpl = input.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(input.url, {
      method: "GET",
      headers: { accept: "image/png,image/jpeg,image/webp" },
      redirect: "error",
      signal: AbortSignal.timeout(input.timeoutMs),
    });
  } catch (err) {
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      throw new UpscaleError("upscale failed: Cloudflare Images request timed out", "Cloudflare request timed out");
    }
    throw new UpscaleError("upscale failed", `Cloudflare request failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!response.ok) {
    const message = response.status === 429
      ? "Cloudflare Images transformation quota is exhausted or rate limited"
      : "upscale failed";
    throw new UpscaleError(message, `Cloudflare returned HTTP ${response.status}`);
  }
  const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() ?? "";
  if (!contentType.startsWith("image/")) {
    throw new UpscaleError("upscale failed", `Cloudflare returned non-image content-type '${contentType || "missing"}'`);
  }
  const buffer = await readLimitedBody(response, input.maxOutputBytes);
  const magicFormat = sniffImageFormat(buffer);
  const expectedContentTypes: Record<SupportedImageFormat, string[]> = {
    png: ["image/png"],
    jpeg: ["image/jpeg", "image/jpg"],
    webp: ["image/webp"],
  };
  if (!magicFormat || !expectedContentTypes[magicFormat].includes(contentType)) {
    throw new UpscaleError("upscale failed", "Cloudflare output content-type or image magic is invalid");
  }

  let metadata: Awaited<ReturnType<ReturnType<typeof sharp>["metadata"]>>;
  try {
    metadata = await sharp(buffer, { limitInputPixels: input.targetWidth * input.targetHeight, failOn: "error" }).metadata();
  } catch {
    throw new UpscaleError("upscale failed", "Cloudflare output could not be decoded");
  }
  const width = metadata.autoOrient?.width ?? metadata.width;
  const height = metadata.autoOrient?.height ?? metadata.height;
  if (metadata.format !== magicFormat || !width || !height || (metadata.pages ?? 1) !== 1) {
    throw new UpscaleError("upscale failed", "Cloudflare output is not one supported image");
  }
  if (width !== input.targetWidth || height !== input.targetHeight) {
    throw new UpscaleError("upscale failed", `Cloudflare output dimensions ${width}x${height} did not match ${input.targetWidth}x${input.targetHeight}`);
  }
  return { buffer, format: magicFormat, extension: extensionFor(magicFormat), width, height };
}

export function saveUpscaleOutput(dataDir: string, output: UpscaleOutput): string {
  const fileName = `${randomBytes(16).toString("hex")}.${output.extension}`;
  const dir = generatedDir(dataDir);
  const temporary = path.join(dir, `.${fileName}.${randomBytes(6).toString("hex")}.tmp`);
  const finalPath = path.join(dir, fileName);
  try {
    fs.writeFileSync(temporary, output.buffer, { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, finalPath);
  } catch (err) {
    try { fs.unlinkSync(temporary); } catch { /* ignore cleanup failure */ }
    throw err;
  }
  return fileName;
}

export class ConcurrencyLimiter {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async run<T>(onQueued: () => void, task: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      onQueued();
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active++;
    try {
      return await task();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}
