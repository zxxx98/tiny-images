import path from "node:path";

export interface Env {
  port: number;
  dataDir: string;
  adminToken: string | null;
  publicBaseUrl: string | null;
}

export function loadEnv(processEnv: NodeJS.ProcessEnv = process.env): Env {
  const port = Number.parseInt(processEnv.PORT ?? "3000", 10);
  return {
    port: Number.isFinite(port) ? port : 3000,
    dataDir: processEnv.DATA_DIR ?? path.resolve("data"),
    adminToken: processEnv.ADMIN_TOKEN || null,
    publicBaseUrl: processEnv.PUBLIC_BASE_URL || null,
  };
}
