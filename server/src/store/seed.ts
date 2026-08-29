import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import type { Repo } from "./repo.js";

interface SeedConfig {
  channels?: { name: string; baseUrl: string; keys?: string[]; timeoutMs?: number; editMode?: string; extraHeaders?: Record<string, string> }[];
  models?: { name: string; channel: string; upstream?: string }[];
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
      baseUrl: ch.baseUrl,
      timeoutMs: ch.timeoutMs,
      editMode: ch.editMode as never,
      extraHeaders: ch.extraHeaders,
    });
    channelIds.set(ch.name, created.id);
    for (const key of ch.keys ?? []) repo.createKey(created.id, key);
  }
  for (const m of cfg.models ?? []) {
    const channelId = channelIds.get(m.channel);
    if (!channelId) throw new Error(`config.yaml: model '${m.name}' references unknown channel '${m.channel}'`);
    repo.createModel({ publicName: m.name, channelId, upstreamName: m.upstream });
  }
}
