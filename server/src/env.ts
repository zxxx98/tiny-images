import path from "node:path";
import fs from "node:fs";
import { randomBytes } from "node:crypto";

export interface CloudflareImagesEnv {
  enabled: boolean;
  baseUrl: string | null;
  timeoutMs: number;
  maxInputBytes: number;
  maxInputPixels: number;
  maxDimension: number;
  maxOutputBytes: number;
  concurrency: number;
}

export interface TurnstileEnv {
  enabled: boolean;
  siteKey: string | null;
  secretKey: string | null;
  timeoutMs: number;
}

export interface Env {
  port: number;
  dataDir: string;
  publicBaseUrl: string | null;
  jwtSecret?: string | null;
  adminEmail?: string | null;
  adminPassword?: string | null;
  cloudflareImages?: CloudflareImagesEnv;
  turnstile?: TurnstileEnv;
}

function parseInteger(
  processEnv: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = processEnv[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function parseCloudflareBaseUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("CLOUDFLARE_IMAGES_BASE_URL must be a valid HTTPS root URL");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    (url.pathname !== "" && url.pathname !== "/")
  ) {
    throw new Error("CLOUDFLARE_IMAGES_BASE_URL must be an HTTPS root URL without credentials, path, query, or fragment");
  }
  const hostname = url.hostname.toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "0.0.0.0" ||
    hostname === "::1" ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname) ||
    /^10(?:\.\d{1,3}){3}$/.test(hostname) ||
    /^192\.168(?:\.\d{1,3}){2}$/.test(hostname) ||
    /^172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}$/.test(hostname) ||
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) ||
    hostname.includes(":")
  ) {
    throw new Error("CLOUDFLARE_IMAGES_BASE_URL must use a public hostname, not localhost or an IP address");
  }
  return url.origin;
}

export function loadEnv(processEnv: NodeJS.ProcessEnv = process.env): Env {
  const port = Number.parseInt(processEnv.PORT ?? "3000", 10);
  const cloudflareEnabled = processEnv.CLOUDFLARE_IMAGES_ENABLED === "true";
  if (processEnv.CLOUDFLARE_IMAGES_ENABLED && processEnv.CLOUDFLARE_IMAGES_ENABLED !== "true" && processEnv.CLOUDFLARE_IMAGES_ENABLED !== "false") {
    throw new Error("CLOUDFLARE_IMAGES_ENABLED must be 'true' or 'false'");
  }
  const cloudflareBaseUrl = parseCloudflareBaseUrl(processEnv.CLOUDFLARE_IMAGES_BASE_URL);
  if (cloudflareEnabled && !cloudflareBaseUrl) {
    throw new Error("CLOUDFLARE_IMAGES_BASE_URL is required when CLOUDFLARE_IMAGES_ENABLED=true");
  }
  const turnstileSiteKey = processEnv.TURNSTILE_SITE_KEY || null;
  const turnstileSecretKey = processEnv.TURNSTILE_SECRET_KEY || null;
  if (!!turnstileSiteKey !== !!turnstileSecretKey) {
    throw new Error("TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY must be configured together");
  }
  return {
    port: Number.isFinite(port) ? port : 3000,
    dataDir: processEnv.DATA_DIR ?? path.resolve("data"),
    publicBaseUrl: processEnv.PUBLIC_BASE_URL || null,
    jwtSecret: processEnv.JWT_SECRET || null,
    adminEmail: processEnv.ADMIN_EMAIL || null,
    adminPassword: processEnv.ADMIN_PASSWORD || null,
    cloudflareImages: {
      enabled: cloudflareEnabled,
      baseUrl: cloudflareBaseUrl,
      timeoutMs: parseInteger(processEnv, "CLOUDFLARE_IMAGES_TIMEOUT_MS", 120_000, 10_000, 300_000),
      maxInputBytes: parseInteger(processEnv, "UPSCALE_MAX_INPUT_BYTES", 20 * 1024 * 1024, 1, 50 * 1024 * 1024),
      maxInputPixels: parseInteger(processEnv, "UPSCALE_MAX_INPUT_PIXELS", 40_000_000, 1, 100_000_000),
      maxDimension: parseInteger(processEnv, "UPSCALE_MAX_DIMENSION", 8192, 1, 16_384),
      maxOutputBytes: parseInteger(processEnv, "UPSCALE_MAX_OUTPUT_BYTES", 50 * 1024 * 1024, 1, 100 * 1024 * 1024),
      concurrency: parseInteger(processEnv, "UPSCALE_CONCURRENCY", 2, 1, 16),
    },
    turnstile: {
      enabled: !!turnstileSiteKey && !!turnstileSecretKey,
      siteKey: turnstileSiteKey,
      secretKey: turnstileSecretKey,
      timeoutMs: parseInteger(processEnv, "TURNSTILE_TIMEOUT_MS", 10_000, 1_000, 60_000),
    },
  };
}

// JWT_SECRET 未配置时生成随机 secret 并持久化到 data 目录，重启后已签发的 token 仍然有效
export function resolveJwtSecret(dataDir: string, explicit: string | null): string {
  if (explicit) return explicit;
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, "jwt_secret");
  if (fs.existsSync(file)) {
    const saved = fs.readFileSync(file, "utf8").trim();
    if (saved) return saved;
  }
  const secret = randomBytes(32).toString("base64url");
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}
