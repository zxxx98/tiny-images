import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { hashPassword } from "../core/password.js";
import type { ChannelType } from "../core/types.js";
import type { Repo } from "./repo.js";

interface SeedConfig {
  channels?: { name: string; type?: ChannelType; baseUrl: string; keys?: string[]; timeoutMs?: number; concurrency?: number; editMode?: string; extraHeaders?: Record<string, string> }[];
  models?: { name: string; channel: string; upstream?: string; supportsImageToImage?: boolean }[];
}

export function seedIfEmpty(dataDir: string, repo: Repo): void {
  if (repo.listChannels().length > 0 || repo.listModels().length > 0) return;
  const file = path.join(dataDir, "config.yaml");
  if (!fs.existsSync(file)) return;
  let cfg: SeedConfig;
  try {
    cfg = parse(fs.readFileSync(file, "utf8")) as SeedConfig;
  } catch (err) {
    throw new Error(`failed to parse ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const channelIds = new Map<string, number>();
  for (const ch of cfg.channels ?? []) {
    const created = repo.createChannel({
      name: ch.name,
      type: ch.type,
      baseUrl: ch.baseUrl,
      timeoutMs: ch.timeoutMs,
      concurrency: ch.concurrency,
      editMode: ch.editMode as never,
      extraHeaders: ch.extraHeaders,
    });
    channelIds.set(ch.name, created.id);
    for (const key of ch.keys ?? []) repo.createKey(created.id, key);
  }
  for (const m of cfg.models ?? []) {
    const channelId = channelIds.get(m.channel);
    if (!channelId) throw new Error(`config.yaml: model '${m.name}' references unknown channel '${m.channel}'`);
    repo.createModel({ publicName: m.name, channelId, upstreamName: m.upstream, supportsImageToImage: m.supportsImageToImage });
  }
}

export function seedAdminIfEmpty(
  repo: Repo,
  env: { adminEmail?: string | null; adminPassword?: string | null },
): { created: boolean; email: string; password: string | null } {
  if (repo.listUsers().length > 0) return { created: false, email: "", password: null };
  // 未设置环境变量时不报错：由 Web 端 /setup 设置页引导创建初始 admin
  if (!env.adminEmail || !env.adminPassword) return { created: false, email: "", password: null };
  const email = env.adminEmail.toLowerCase();
  repo.createUser({ email, passwordHash: hashPassword(env.adminPassword), role: "admin", quotaTotal: null });
  return { created: true, email, password: null };
}
