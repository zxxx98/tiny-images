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
  `
  CREATE TABLE IF NOT EXISTS generations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at INTEGER NOT NULL,
    api_key_id INTEGER,
    model TEXT NOT NULL,
    prompt TEXT NOT NULL,
    params TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL,
    channel_id INTEGER,
    latency_ms INTEGER,
    error_message TEXT,
    images TEXT NOT NULL DEFAULT '[]'
  );
  CREATE INDEX IF NOT EXISTS generations_cursor ON generations(id DESC);
  `,
  `
  CREATE TABLE IF NOT EXISTS channel_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS channel_group_members (
    group_id INTEGER NOT NULL REFERENCES channel_groups(id) ON DELETE CASCADE,
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    UNIQUE(group_id, channel_id)
  );
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin','user')),
    enabled INTEGER NOT NULL DEFAULT 1,
    quota_total INTEGER,
    quota_used INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS user_group_members (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    group_id INTEGER NOT NULL REFERENCES channel_groups(id) ON DELETE CASCADE,
    UNIQUE(user_id, group_id)
  );
  ALTER TABLE api_keys ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
  `,
  `
  ALTER TABLE generations ADD COLUMN user_id INTEGER;
  CREATE INDEX IF NOT EXISTS generations_user ON generations(user_id);
  `,
  `
  -- 同一对外模型名允许多条启用映射（按 priority 升序故障转移）
  DROP INDEX IF EXISTS models_enabled_public_name;
  ALTER TABLE models ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
  `,
  `
  ALTER TABLE users ADD COLUMN quota_day TEXT;
  `,
  `
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  `
  CREATE INDEX IF NOT EXISTS generations_created_at ON generations(created_at);
  `,
  `
  ALTER TABLE models ADD COLUMN supports_image_to_image INTEGER NOT NULL DEFAULT 0;
  `,
  `
  ALTER TABLE channels ADD COLUMN concurrency INTEGER NOT NULL DEFAULT 2;
  `,
  `
  ALTER TABLE users ADD COLUMN allow_nsfw INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE models ADD COLUMN supports_nsfw INTEGER NOT NULL DEFAULT 0;
  `,
  `
  ALTER TABLE channels ADD COLUMN generation_mode TEXT NOT NULL DEFAULT 'images';
  `,
  `
  CREATE TABLE IF NOT EXISTS prompt_favorites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS prompt_favorites_user ON prompt_favorites(user_id, id DESC);
  `,
  `
  -- 用户下载水印配置：JSON { enabled, text }，NULL 视为未启用
  ALTER TABLE users ADD COLUMN watermark TEXT;
  `,
  `
  CREATE TABLE IF NOT EXISTS plaza_shares (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at INTEGER NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    generation_id INTEGER,
    file TEXT NOT NULL,
    width INTEGER,
    height INTEGER,
    model TEXT,
    prompt TEXT NOT NULL DEFAULT '',
    revised_prompt TEXT
  );
  CREATE INDEX IF NOT EXISTS plaza_shares_cursor ON plaza_shares(id DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS plaza_shares_user_file ON plaza_shares(user_id, file);
  `,
  `
  -- 官方模板库：文生图（example_image 生成示例）与图生图（example_before/after 前后示例）
  CREATE TABLE IF NOT EXISTS templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL CHECK (type IN ('text2image','image2image')),
    name TEXT NOT NULL,
    prompt TEXT NOT NULL,
    example_image TEXT,
    example_before TEXT,
    example_after TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
  `
  -- owner_user_id 为 NULL 表示官方模板（仅管理员可改删）；非 NULL 为用户自己录入的模板（仅本人可见/可删）
  ALTER TABLE templates ADD COLUMN owner_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
  `,
  `
  ALTER TABLE channels ADD COLUMN allow_private_image_fetch INTEGER NOT NULL DEFAULT 0;
  `,
  `
  CREATE TABLE quota_reservations (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount INTEGER NOT NULL CHECK (amount > 0),
    quota_day TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX quota_reservations_user ON quota_reservations(user_id);
  `,
];

export function openDb(dataDir: string): DatabaseSync {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, "tiny-images.db"));
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
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
