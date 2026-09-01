import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ChannelType, EditMode } from "../core/types.js";

export interface ChannelRow {
  id: number;
  name: string;
  type: ChannelType;
  baseUrl: string;
  timeoutMs: number;
  concurrency: number;
  editMode: EditMode;
  extraHeaders: Record<string, string>;
  enabled: boolean;
  createdAt: number;
}

export interface KeyRow {
  id: number;
  channelId: number;
  apiKey: string;
  enabled: boolean;
  cooldownUntil: number;
}

export interface ModelRow {
  id: number;
  publicName: string;
  channelId: number;
  upstreamName: string;
  enabled: boolean;
  priority: number;
  supportsImageToImage: boolean;
  createdAt: number;
}

export interface ApiKeyRow {
  id: number;
  name: string;
  key: string;
  enabled: boolean;
  userId: number | null;
  createdAt: number;
}

export interface LogEntry {
  ts: number;
  model: string;
  channelId: number | null;
  apiKeyId: number | null;
  status: "ok" | "error";
  httpStatus: number | null;
  latencyMs: number | null;
  errorMessage: string | null;
}

export interface LogRow extends LogEntry {
  id: number;
}

export interface GenerationEntry {
  createdAt: number;
  apiKeyId: number | null;
  userId: number | null;
  model: string;
  prompt: string;
  params: string;
  status: "pending" | "ok" | "error";
  channelId: number | null;
  latencyMs: number | null;
  errorMessage: string | null;
  images: string;
}

// 历史可见性：admin → 全部；有用户身份（JWT 或绑定 key）→ 该用户名下所有 key + 本人网页调用；
// 无主 key / 匿名 → 仅该 key 自己（或 apiKeyId 为空）的记录
export interface GenerationViewer {
  admin: boolean;
  userId: number | null;
  apiKeyId: number | null;
}

export interface GenerationRow extends GenerationEntry {
  id: number;
}

export interface GroupRow {
  id: number;
  name: string;
  createdAt: number;
  channelIds: number[];
}

export interface UserRow {
  id: number;
  email: string;
  passwordHash: string;
  role: "admin" | "user";
  enabled: boolean;
  createdAt: number;
  quotaTotal: number | null;
  quotaUsed: number;
  quotaDay: string | null;
  groupIds: number[];
}

export interface AppSettings {
  globalPrompt: string;
  announcement: string;
  announcementVersion: number;
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

export interface ChannelInput {
  name: string;
  type?: ChannelType;
  baseUrl: string;
  timeoutMs?: number;
  concurrency?: number;
  editMode?: EditMode;
  extraHeaders?: Record<string, string>;
  enabled?: boolean;
}

const LOG_KEEP = 50;
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

export function quotaDayAt(timestamp: number): string {
  return new Date(timestamp + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message);
}

export class Repo {
  private db: DatabaseSync;

  constructor(
    db: DatabaseSync,
    private readonly now: () => number = Date.now,
  ) {
    this.db = db;
  }

  close(): void {
    this.db.close();
  }

  // ---- application settings ----

  getAppSettings(): AppSettings {
    const rows = this.db.prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[];
    const values = new Map(rows.map((row) => [row.key, row.value]));
    return {
      globalPrompt: values.get("global_prompt") ?? "",
      announcement: values.get("announcement") ?? "",
      announcementVersion: Number(values.get("announcement_version") ?? "0"),
    };
  }

  updateAppSettings(input: { globalPrompt: string; announcement: string }): AppSettings {
    const current = this.getAppSettings();
    const announcementVersion =
      current.announcement === input.announcement ? current.announcementVersion : current.announcementVersion + 1;
    const put = this.db.prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    );
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      put.run("global_prompt", input.globalPrompt);
      put.run("announcement", input.announcement);
      put.run("announcement_version", String(announcementVersion));
      this.db.exec("COMMIT;");
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
    return this.getAppSettings();
  }

  // ---- channels ----

  createChannel(input: ChannelInput): ChannelRow {
    try {
      const res = this.db
        .prepare(
          `INSERT INTO channels (name, type, base_url, timeout_ms, concurrency, edit_mode, extra_headers, enabled, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.name,
          input.type ?? "openai-compat",
          input.baseUrl,
          input.timeoutMs ?? 120000,
          input.concurrency ?? 2,
          input.editMode ?? "auto",
          JSON.stringify(input.extraHeaders ?? {}),
          input.enabled === false ? 0 : 1,
          Date.now(),
        );
      return this.getChannel(Number(res.lastInsertRowid))!;
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictError(`channel name '${input.name}' already exists`);
      throw err;
    }
  }

  getChannel(id: number): ChannelRow | null {
    const row = this.db.prepare("SELECT * FROM channels WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this.toChannel(row) : null;
  }

  listChannels(): ChannelRow[] {
    const rows = this.db.prepare("SELECT * FROM channels ORDER BY id").all() as Record<string, unknown>[];
    return rows.map((r) => this.toChannel(r));
  }

  updateChannel(id: number, patch: Partial<ChannelInput>): ChannelRow | null {
    const existing = this.getChannel(id);
    if (!existing) return null;
    const merged = { ...existing, ...patch };
    try {
      this.db
        .prepare("UPDATE channels SET name = ?, type = ?, base_url = ?, timeout_ms = ?, concurrency = ?, edit_mode = ?, extra_headers = ?, enabled = ? WHERE id = ?")
        .run(merged.name, merged.type, merged.baseUrl, merged.timeoutMs, merged.concurrency, merged.editMode, JSON.stringify(merged.extraHeaders), merged.enabled ? 1 : 0, id);
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictError(`channel name '${merged.name}' already exists`);
      throw err;
    }
    return this.getChannel(id);
  }

  deleteChannel(id: number): boolean {
    const res = this.db.prepare("DELETE FROM channels WHERE id = ?").run(id);
    return Number(res.changes) > 0;
  }

  private toChannel(row: Record<string, unknown>): ChannelRow {
    return {
      id: Number(row.id),
      name: String(row.name),
      type: String(row.type) as ChannelType,
      baseUrl: String(row.base_url),
      timeoutMs: Number(row.timeout_ms),
      concurrency: Number(row.concurrency),
      editMode: String(row.edit_mode) as EditMode,
      extraHeaders: JSON.parse(String(row.extra_headers ?? "{}")) as Record<string, string>,
      enabled: Number(row.enabled) === 1,
      createdAt: Number(row.created_at),
    };
  }

  // ---- channel keys ----

  createKey(channelId: number, apiKey: string): KeyRow {
    const res = this.db
      .prepare("INSERT INTO channel_keys (channel_id, api_key, enabled, cooldown_until) VALUES (?, ?, 1, 0)")
      .run(channelId, apiKey);
    return this.getKey(Number(res.lastInsertRowid))!;
  }

  getKey(keyId: number): KeyRow | null {
    const row = this.db.prepare("SELECT * FROM channel_keys WHERE id = ?").get(keyId) as Record<string, unknown> | undefined;
    return row ? this.toKey(row) : null;
  }

  listKeys(channelId: number): KeyRow[] {
    const rows = this.db.prepare("SELECT * FROM channel_keys WHERE channel_id = ? ORDER BY id").all(channelId) as Record<string, unknown>[];
    return rows.map((r) => this.toKey(r));
  }

  enabledKeys(channelId: number): KeyRow[] {
    const rows = this.db
      .prepare("SELECT * FROM channel_keys WHERE channel_id = ? AND enabled = 1 ORDER BY id")
      .all(channelId) as Record<string, unknown>[];
    return rows.map((r) => this.toKey(r));
  }

  enabledKeyCount(channelId: number): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM channel_keys WHERE channel_id = ? AND enabled = 1").get(channelId) as { n: number | bigint };
    return Number(row.n);
  }

  updateKey(keyId: number, patch: { enabled?: boolean; apiKey?: string }): KeyRow | null {
    const existing = this.getKey(keyId);
    if (!existing) return null;
    const enabled = patch.enabled ?? existing.enabled;
    const apiKey = patch.apiKey ?? existing.apiKey;
    this.db.prepare("UPDATE channel_keys SET enabled = ?, api_key = ? WHERE id = ?").run(enabled ? 1 : 0, apiKey, keyId);
    return this.getKey(keyId);
  }

  deleteKey(keyId: number): boolean {
    const res = this.db.prepare("DELETE FROM channel_keys WHERE id = ?").run(keyId);
    return Number(res.changes) > 0;
  }

  setKeyCooldown(keyId: number, cooldownUntil: number): void {
    this.db.prepare("UPDATE channel_keys SET cooldown_until = ? WHERE id = ?").run(cooldownUntil, keyId);
  }

  private toKey(row: Record<string, unknown>): KeyRow {
    return {
      id: Number(row.id),
      channelId: Number(row.channel_id),
      apiKey: String(row.api_key),
      enabled: Number(row.enabled) === 1,
      cooldownUntil: Number(row.cooldown_until),
    };
  }

  // ---- models ----

  // 同一 publicName 允许多条启用映射（按 priority 升序做故障转移），不再有唯一性约束
  createModel(input: {
    publicName: string;
    channelId: number;
    upstreamName?: string;
    enabled?: boolean;
    priority?: number;
    supportsImageToImage?: boolean;
  }): ModelRow {
    const enabled = input.enabled !== false;
    const supportsImageToImage = input.supportsImageToImage === true;
    const res = this.db
      .prepare(
        "INSERT INTO models (public_name, channel_id, upstream_name, enabled, priority, supports_image_to_image, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        input.publicName,
        input.channelId,
        input.upstreamName ?? input.publicName,
        enabled ? 1 : 0,
        input.priority ?? 0,
        supportsImageToImage ? 1 : 0,
        Date.now(),
      );
    return this.getModel(Number(res.lastInsertRowid))!;
  }

  getModel(id: number): ModelRow | null {
    const row = this.db.prepare("SELECT * FROM models WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this.toModel(row) : null;
  }

  findEnabledModel(publicName: string): ModelRow | null {
    const row = this.db.prepare("SELECT * FROM models WHERE public_name = ? AND enabled = 1").get(publicName) as Record<string, unknown> | undefined;
    return row ? this.toModel(row) : null;
  }

  listModels(): ModelRow[] {
    const rows = this.db.prepare("SELECT * FROM models ORDER BY id").all() as Record<string, unknown>[];
    return rows.map((r) => this.toModel(r));
  }

  listEnabledModels(): ModelRow[] {
    const rows = this.db.prepare("SELECT * FROM models WHERE enabled = 1 ORDER BY id").all() as Record<string, unknown>[];
    return rows.map((r) => this.toModel(r));
  }

  // 同名启用映射按 priority 升序（同 priority 按 id 稳定排序）返回，供路由做故障转移
  listEnabledModelRoutes(publicName: string): ModelRow[] {
    const rows = this.db
      .prepare("SELECT * FROM models WHERE public_name = ? AND enabled = 1 ORDER BY priority ASC, id ASC")
      .all(publicName) as Record<string, unknown>[];
    return rows.map((r) => this.toModel(r));
  }

  updateModel(
    id: number,
    patch: {
      publicName?: string;
      channelId?: number;
      upstreamName?: string;
      enabled?: boolean;
      priority?: number;
      supportsImageToImage?: boolean;
    },
  ): ModelRow | null {
    const existing = this.getModel(id);
    if (!existing) return null;
    const merged = { ...existing, ...patch };
    this.db
      .prepare(
        "UPDATE models SET public_name = ?, channel_id = ?, upstream_name = ?, enabled = ?, priority = ?, supports_image_to_image = ? WHERE id = ?",
      )
      .run(
        merged.publicName,
        merged.channelId,
        merged.upstreamName,
        merged.enabled ? 1 : 0,
        merged.priority,
        merged.supportsImageToImage ? 1 : 0,
        id,
      );
    return this.getModel(id);
  }

  deleteModel(id: number): boolean {
    const res = this.db.prepare("DELETE FROM models WHERE id = ?").run(id);
    return Number(res.changes) > 0;
  }

  private toModel(row: Record<string, unknown>): ModelRow {
    return {
      id: Number(row.id),
      publicName: String(row.public_name),
      channelId: Number(row.channel_id),
      upstreamName: String(row.upstream_name),
      enabled: Number(row.enabled) === 1,
      priority: row.priority === undefined ? 0 : Number(row.priority),
      supportsImageToImage: Number(row.supports_image_to_image) === 1,
      createdAt: Number(row.created_at),
    };
  }

  // ---- api keys (outbound auth) ----

  createApiKey(name: string, userId: number | null = null): ApiKeyRow {
    const key = `sk-tiny-${randomBytes(24).toString("base64url")}`;
    const res = this.db
      .prepare("INSERT INTO api_keys (name, key, enabled, user_id, created_at) VALUES (?, ?, 1, ?, ?)")
      .run(name, key, userId, Date.now());
    return this.getApiKey(Number(res.lastInsertRowid))!;
  }

  getApiKey(id: number): ApiKeyRow | null {
    const row = this.db.prepare("SELECT * FROM api_keys WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this.toApiKey(row) : null;
  }

  listApiKeys(): ApiKeyRow[] {
    const rows = this.db.prepare("SELECT * FROM api_keys ORDER BY id").all() as Record<string, unknown>[];
    return rows.map((r) => this.toApiKey(r));
  }

  findApiKeyByKey(key: string): ApiKeyRow | null {
    const row = this.db.prepare("SELECT * FROM api_keys WHERE key = ?").get(key) as Record<string, unknown> | undefined;
    return row ? this.toApiKey(row) : null;
  }

  updateApiKey(id: number, patch: { name?: string; enabled?: boolean; userId?: number | null }): ApiKeyRow | null {
    const existing = this.getApiKey(id);
    if (!existing) return null;
    const name = patch.name ?? existing.name;
    const enabled = patch.enabled ?? existing.enabled;
    const userId = patch.userId !== undefined ? patch.userId : existing.userId;
    this.db.prepare("UPDATE api_keys SET name = ?, enabled = ?, user_id = ? WHERE id = ?").run(name, enabled ? 1 : 0, userId, id);
    return this.getApiKey(id);
  }

  deleteApiKey(id: number): boolean {
    const res = this.db.prepare("DELETE FROM api_keys WHERE id = ?").run(id);
    return Number(res.changes) > 0;
  }

  private toApiKey(row: Record<string, unknown>): ApiKeyRow {
    return {
      id: Number(row.id),
      name: String(row.name),
      key: String(row.key),
      enabled: Number(row.enabled) === 1,
      userId: row.user_id === null || row.user_id === undefined ? null : Number(row.user_id),
      createdAt: Number(row.created_at),
    };
  }

  // ---- request logs ----

  insertLog(entry: LogEntry): void {
    this.db
      .prepare(
        `INSERT INTO request_logs (ts, model, channel_id, api_key_id, status, http_status, latency_ms, error_message)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.ts,
        entry.model,
        entry.channelId,
        entry.apiKeyId,
        entry.status,
        entry.httpStatus,
        entry.latencyMs,
        entry.errorMessage,
      );
    this.db
      .prepare(`DELETE FROM request_logs WHERE id NOT IN (SELECT id FROM request_logs ORDER BY id DESC LIMIT ${LOG_KEEP})`)
      .run();
  }

  recentLogs(limit: number): LogRow[] {
    const rows = this.db.prepare("SELECT * FROM request_logs ORDER BY id DESC LIMIT ?").all(limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: Number(r.id),
      ts: Number(r.ts),
      model: String(r.model),
      channelId: r.channel_id === null ? null : Number(r.channel_id),
      apiKeyId: r.api_key_id === null ? null : Number(r.api_key_id),
      status: String(r.status) as "ok" | "error",
      httpStatus: r.http_status === null ? null : Number(r.http_status),
      latencyMs: r.latency_ms === null ? null : Number(r.latency_ms),
      errorMessage: r.error_message === null ? null : String(r.error_message),
    }));
  }

  // ---- generations（生成历史）----

  insertGeneration(e: GenerationEntry): number {
    const res = this.db
      .prepare(
        `INSERT INTO generations (created_at, api_key_id, user_id, model, prompt, params, status, channel_id, latency_ms, error_message, images)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(e.createdAt, e.apiKeyId, e.userId, e.model, e.prompt, e.params, e.status, e.channelId, e.latencyMs, e.errorMessage, e.images);
    return Number(res.lastInsertRowid);
  }

  completeGeneration(
    id: number,
    patch: Partial<Pick<GenerationEntry, "status" | "channelId" | "latencyMs" | "errorMessage" | "images">>,
  ): void {
    const row = this.db.prepare("SELECT * FROM generations WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) return;
    const merged = {
      status: patch.status ?? (row.status as string),
      channelId: "channelId" in patch ? patch.channelId : (row.channel_id as number | null),
      latencyMs: "latencyMs" in patch ? patch.latencyMs : (row.latency_ms as number | null),
      errorMessage: "errorMessage" in patch ? patch.errorMessage : (row.error_message as string | null),
      images: patch.images ?? (row.images as string),
    };
    this.db
      .prepare(`UPDATE generations SET status = ?, channel_id = ?, latency_ms = ?, error_message = ?, images = ? WHERE id = ?`)
      .run(merged.status, merged.channelId ?? null, merged.latencyMs ?? null, merged.errorMessage ?? null, merged.images, id);
  }

  listGenerations(viewer: GenerationViewer, before: number | null, limit: number): GenerationRow[] {
    let rows: Record<string, unknown>[];
    if (viewer.admin) {
      rows = this.db
        .prepare(`SELECT * FROM generations WHERE (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?`)
        .all(before, before, limit) as Record<string, unknown>[];
    } else if (viewer.userId !== null) {
      rows = this.db
        .prepare(
          `SELECT * FROM generations
           WHERE (user_id = ? OR api_key_id IN (SELECT id FROM api_keys WHERE user_id = ?))
             AND (? IS NULL OR id < ?)
           ORDER BY id DESC LIMIT ?`,
        )
        .all(viewer.userId, viewer.userId, before, before, limit) as Record<string, unknown>[];
    } else {
      rows = this.db
        .prepare(
          `SELECT * FROM generations
           WHERE (? IS NULL OR api_key_id = ?) AND (? IS NULL OR id < ?)
           ORDER BY id DESC LIMIT ?`,
        )
        .all(viewer.apiKeyId, viewer.apiKeyId, before, before, limit) as Record<string, unknown>[];
    }
    return rows.map((r) => this.toGeneration(r));
  }

  failPendingGenerations(message: string): number {
    const res = this.db
      .prepare(`UPDATE generations SET status = 'error', error_message = ? WHERE status = 'pending'`)
      .run(message);
    return Number(res.changes);
  }

  pruneGenerations(createdBefore: number): number {
    const result = this.db.prepare("DELETE FROM generations WHERE created_at < ?").run(createdBefore);
    return Number(result.changes);
  }

  private toGeneration(r: Record<string, unknown>): GenerationRow {
    return {
      id: Number(r.id),
      createdAt: Number(r.created_at),
      apiKeyId: r.api_key_id === null ? null : Number(r.api_key_id),
      userId: r.user_id === null || r.user_id === undefined ? null : Number(r.user_id),
      model: String(r.model),
      prompt: String(r.prompt),
      params: String(r.params),
      status: String(r.status) as GenerationRow["status"],
      channelId: r.channel_id === null ? null : Number(r.channel_id),
      latencyMs: r.latency_ms === null ? null : Number(r.latency_ms),
      errorMessage: r.error_message === null ? null : String(r.error_message),
      images: String(r.images),
    };
  }

  // ---- channel groups ----

  createGroup(name: string): GroupRow {
    const now = Date.now();
    try {
      const res = this.db.prepare("INSERT INTO channel_groups (name, created_at) VALUES (?, ?)").run(name, now);
      const id = Number(res.lastInsertRowid);
      return { id, name, createdAt: now, channelIds: [] };
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictError(`group '${name}' already exists`);
      throw err;
    }
  }

  listGroups(): GroupRow[] {
    const rows = this.db.prepare("SELECT * FROM channel_groups ORDER BY id").all() as Record<string, unknown>[];
    const members = this.db
      .prepare("SELECT group_id, channel_id FROM channel_group_members ORDER BY channel_id")
      .all() as Record<string, unknown>[];
    return rows.map((r) => {
      const id = Number(r.id);
      return {
        id,
        name: String(r.name),
        createdAt: Number(r.created_at),
        channelIds: members.filter((m) => Number(m.group_id) === id).map((m) => Number(m.channel_id)),
      };
    });
  }

  updateGroup(id: number, name: string): GroupRow | null {
    if (!this.db.prepare("SELECT id FROM channel_groups WHERE id = ?").get(id)) return null;
    try {
      this.db.prepare("UPDATE channel_groups SET name = ? WHERE id = ?").run(name, id);
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictError(`group '${name}' already exists`);
      throw err;
    }
    return this.listGroups().find((g) => g.id === id) ?? null;
  }

  deleteGroup(id: number): boolean {
    const res = this.db.prepare("DELETE FROM channel_groups WHERE id = ?").run(id);
    return Number(res.changes) > 0;
  }

  setGroupChannels(groupId: number, channelIds: number[]): void {
    this.db.prepare("DELETE FROM channel_group_members WHERE group_id = ?").run(groupId);
    const ins = this.db.prepare("INSERT OR IGNORE INTO channel_group_members (group_id, channel_id) VALUES (?, ?)");
    for (const cid of new Set(channelIds)) ins.run(groupId, cid);
  }

  // ---- users ----

  private currentQuotaDay(): string {
    return quotaDayAt(this.now());
  }

  private refreshDailyQuota(userId: number): void {
    const day = this.currentQuotaDay();
    const row = this.db.prepare("SELECT quota_day FROM users WHERE id = ?").get(userId) as { quota_day: string | null } | undefined;
    if (!row || (row.quota_day !== null && row.quota_day >= day)) return;
    this.db
      .prepare("UPDATE users SET quota_used = 0, quota_day = ? WHERE id = ? AND (quota_day IS NULL OR quota_day < ?)")
      .run(day, userId, day);
  }

  private refreshAllDailyQuotas(): void {
    const day = this.currentQuotaDay();
    const pending = this.db
      .prepare("SELECT 1 FROM users WHERE quota_day IS NULL OR quota_day < ? LIMIT 1")
      .get(day);
    if (!pending) return;
    this.db
      .prepare("UPDATE users SET quota_used = 0, quota_day = ? WHERE quota_day IS NULL OR quota_day < ?")
      .run(day, day);
  }

  private toUser(row: Record<string, unknown>): UserRow {
    const groupIds = this.db
      .prepare("SELECT group_id FROM user_group_members WHERE user_id = ? ORDER BY group_id")
      .all(Number(row.id)) as Record<string, unknown>[];
    return {
      id: Number(row.id),
      email: String(row.email),
      passwordHash: String(row.password_hash),
      role: String(row.role) as UserRow["role"],
      enabled: Number(row.enabled) === 1,
      createdAt: Number(row.created_at),
      quotaTotal: row.quota_total === null || row.quota_total === undefined ? null : Number(row.quota_total),
      quotaUsed: Number(row.quota_used),
      quotaDay: row.quota_day === null || row.quota_day === undefined ? null : String(row.quota_day),
      groupIds: groupIds.map((g) => Number(g.group_id)),
    };
  }

  createUser(input: { email: string; passwordHash: string; role: "admin" | "user"; quotaTotal: number | null }): UserRow {
    const email = input.email.toLowerCase();
    try {
      const res = this.db
        .prepare("INSERT INTO users (email, password_hash, role, enabled, quota_total, quota_used, quota_day, created_at) VALUES (?, ?, ?, 1, ?, 0, ?, ?)")
        .run(email, input.passwordHash, input.role, input.quotaTotal, this.currentQuotaDay(), Date.now());
      return this.getUser(Number(res.lastInsertRowid))!;
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictError(`user '${email}' already exists`);
      throw err;
    }
  }

  getUser(id: number): UserRow | null {
    this.refreshDailyQuota(id);
    const row = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this.toUser(row) : null;
  }

  getUserByEmail(email: string): UserRow | null {
    const row = this.db.prepare("SELECT id FROM users WHERE email = ?").get(email.toLowerCase()) as { id: number } | undefined;
    return row ? this.getUser(Number(row.id)) : null;
  }

  listUsers(): UserRow[] {
    this.refreshAllDailyQuotas();
    const rows = this.db.prepare("SELECT * FROM users ORDER BY id").all() as Record<string, unknown>[];
    return rows.map((r) => this.toUser(r));
  }

  updateUser(id: number, patch: { enabled?: boolean; quotaTotal?: number | null; passwordHash?: string }): UserRow | null {
    const existing = this.getUser(id);
    if (!existing) return null;
    const enabled = patch.enabled ?? existing.enabled;
    const quotaTotal = patch.quotaTotal !== undefined ? patch.quotaTotal : existing.quotaTotal;
    const passwordHash = patch.passwordHash ?? existing.passwordHash;
    this.db.prepare("UPDATE users SET enabled = ?, quota_total = ?, password_hash = ? WHERE id = ?").run(enabled ? 1 : 0, quotaTotal, passwordHash, id);
    return this.getUser(id);
  }

  deleteUser(id: number): boolean {
    // api_keys.user_id 为 ON DELETE SET NULL，无需手动处理
    const res = this.db.prepare("DELETE FROM users WHERE id = ?").run(id);
    return Number(res.changes) > 0;
  }

  setUserGroups(userId: number, groupIds: number[]): void {
    this.db.prepare("DELETE FROM user_group_members WHERE user_id = ?").run(userId);
    const ins = this.db.prepare("INSERT OR IGNORE INTO user_group_members (user_id, group_id) VALUES (?, ?)");
    for (const gid of new Set(groupIds)) ins.run(userId, gid);
  }

  allowedChannelIds(userId: number | null): number[] | null {
    if (userId === null) return null;
    const rows = this.db
      .prepare(
        "SELECT DISTINCT m.channel_id FROM user_group_members ug JOIN channel_group_members m ON m.group_id = ug.group_id WHERE ug.user_id = ? ORDER BY m.channel_id",
      )
      .all(userId) as Record<string, unknown>[];
    if (rows.length === 0) return null; // 未配置分组 = 不限
    return rows.map((r) => Number(r.channel_id));
  }

  chargeQuota(userId: number, n: number): boolean {
    this.refreshDailyQuota(userId);
    const res = this.db
      .prepare("UPDATE users SET quota_used = quota_used + ? WHERE id = ? AND (quota_total IS NULL OR quota_used + ? <= quota_total)")
      .run(n, userId, n);
    return Number(res.changes) > 0;
  }
}
