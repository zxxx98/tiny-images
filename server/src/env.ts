import path from "node:path";
import fs from "node:fs";
import { randomBytes } from "node:crypto";

export interface Env {
  port: number;
  dataDir: string;
  publicBaseUrl: string | null;
  jwtSecret?: string | null;
  adminEmail?: string | null;
  adminPassword?: string | null;
}

export function loadEnv(processEnv: NodeJS.ProcessEnv = process.env): Env {
  const port = Number.parseInt(processEnv.PORT ?? "3000", 10);
  return {
    port: Number.isFinite(port) ? port : 3000,
    dataDir: processEnv.DATA_DIR ?? path.resolve("data"),
    publicBaseUrl: processEnv.PUBLIC_BASE_URL || null,
    jwtSecret: processEnv.JWT_SECRET || null,
    adminEmail: processEnv.ADMIN_EMAIL || null,
    adminPassword: processEnv.ADMIN_PASSWORD || null,
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
