import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

const MIGRATIONS: string[] = [
  `
  CREATE TABLE IF NOT EXISTS channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL DEFAULT 'openai-compat',
    base_url TEXT NOT NULL,
    timeout_ms INTEGER NOT NULL DEFAULT 120000,
    edit_mode TEXT NOT NULL DEFAULT 'auto',
    extra_headers TEXT NOT NULL DEFAULT '{}',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS channel_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    api_key TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    cooldown_until INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS models (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    public_name TEXT NOT NULL,
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    upstream_name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS models_enabled_public_name ON models(public_name) WHERE enabled = 1;
  CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    key TEXT NOT NULL UNIQUE,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS request_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    model TEXT NOT NULL,
    channel_id INTEGER,
    api_key_id INTEGER,
    status TEXT NOT NULL,
    http_status INTEGER,
    latency_ms INTEGER,
    error_message TEXT
  );
  CREATE INDEX IF NOT EXISTS request_logs_ts ON request_logs(ts DESC);
  `,
];

export function openDb(dataDir: string): DatabaseSync {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, "tiny-images.db"));
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined;
  const current = row?.user_version ?? 0;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN IMMEDIATE;");
    try {
      db.exec(MIGRATIONS[v]);
      db.prepare(`PRAGMA user_version = ${v + 1}`).run();
      db.exec("COMMIT;");
    } catch (err) {
      db.exec("ROLLBACK;");
      throw err;
    }
  }
  return db;
}
