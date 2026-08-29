import { httpError } from "../core/errors.js";
import { ConflictError } from "../store/repo.js";
import type { EditMode } from "../core/types.js";
import type { AppContext } from "../app.js";

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function requireBody(req: { body: unknown }): Record<string, unknown> {
  if (!isRecord(req.body)) throw httpError(400, "a JSON object body is required");
  return req.body;
}

function requireStr(b: Record<string, unknown>, field: string): string {
  const v = b[field];
  if (typeof v !== "string" || !v.trim()) throw httpError(400, `'${field}' is required`);
  return v;
}

function optionalBoolean(b: Record<string, unknown>, field: string): boolean | undefined {
  const v = b[field];
  if (v === undefined) return undefined;
  if (typeof v !== "boolean") throw httpError(400, `'${field}' must be a boolean`);
  return v;
}

function validateChannelInput(b: Record<string, unknown>): { name?: string; baseUrl?: string; timeoutMs?: number; editMode?: EditMode; extraHeaders?: Record<string, string>; enabled?: boolean } {
  const out: Record<string, unknown> = {};
  if (b.name !== undefined) {
    if (typeof b.name !== "string" || !b.name.trim()) throw httpError(400, "'name' must be a non-empty string");
    out.name = b.name.trim();
  }
  if (b.baseUrl !== undefined) {
    if (typeof b.baseUrl !== "string" || !/^https?:\/\//.test(b.baseUrl)) throw httpError(400, "'baseUrl' must be an http(s) URL");
    out.baseUrl = b.baseUrl;
  }
  if (b.timeoutMs !== undefined) {
    if (typeof b.timeoutMs !== "number" || !Number.isFinite(b.timeoutMs) || b.timeoutMs < 1000) {
      throw httpError(400, "'timeoutMs' must be a number >= 1000");
    }
    out.timeoutMs = b.timeoutMs;
  }
  if (b.editMode !== undefined) {
    if (b.editMode !== "auto" && b.editMode !== "multipart" && b.editMode !== "json-base64") {
      throw httpError(400, "'editMode' must be 'auto', 'multipart' or 'json-base64'");
    }
    out.editMode = b.editMode;
  }
  if (b.extraHeaders !== undefined) {
    if (!isRecord(b.extraHeaders) || !Object.values(b.extraHeaders).every((v) => typeof v === "string")) {
      throw httpError(400, "'extraHeaders' must be an object of string values");
    }
    out.extraHeaders = b.extraHeaders;
  }
  const enabled = optionalBoolean(b, "enabled");
  if (enabled !== undefined) out.enabled = enabled;
  return out;
}

export function registerAdmin(ctx: AppContext): void {
  const repo = ctx.deps.repo;

  ctx.app.get("/admin/whoami", { preHandler: ctx.requireAdmin }, async () => ({ ok: true }));

  // ---- channels ----

  ctx.app.get("/admin/channels", { preHandler: ctx.requireAdmin }, async () => {
    return repo.listChannels().map((c) => ({ ...c, keys: repo.listKeys(c.id) }));
  });

  ctx.app.post("/admin/channels", { preHandler: ctx.requireAdmin }, async (req, reply) => {
    const input = validateChannelInput(requireBody(req));
    if (!input.name || !input.baseUrl) throw httpError(400, "'name' and 'baseUrl' are required");
    try {
      const channel = repo.createChannel(input as { name: string; baseUrl: string });
      return await reply.code(201).send({ ...channel, keys: [] });
    } catch (err) {
      if (err instanceof ConflictError) throw httpError(409, err.message);
      throw err;
    }
  });

  ctx.app.patch("/admin/channels/:id", { preHandler: ctx.requireAdmin }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const patch = validateChannelInput(requireBody(req));
    try {
      const channel = repo.updateChannel(id, patch);
      if (!channel) throw httpError(404, "channel not found");
      return { ...channel, keys: repo.listKeys(id) };
    } catch (err) {
      if (err instanceof ConflictError) throw httpError(409, err.message);
      throw err;
    }
  });

  ctx.app.delete("/admin/channels/:id", { preHandler: ctx.requireAdmin }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!repo.deleteChannel(id)) throw httpError(404, "channel not found");
    return await reply.code(204).send();
  });

  ctx.app.post("/admin/channels/:id/test", { preHandler: ctx.requireAdmin }, async (req) => {
    const id = Number((req.params as { id: string }).id);
    const channel = repo.getChannel(id);
    if (!channel) throw httpError(404, "channel not found");
    const key = repo.enabledKeys(id)[0];
    if (!key) return { ok: false, message: "no enabled api key", keyId: null };
    const result = await ctx.deps.provider.test(channel, key.apiKey);
    return { ...result, keyId: key.id };
  });

  // ---- channel keys ----

  ctx.app.post("/admin/channels/:id/keys", { preHandler: ctx.requireAdmin }, async (req, reply) => {
    const channelId = Number((req.params as { id: string }).id);
    if (!repo.getChannel(channelId)) throw httpError(404, "channel not found");
    const apiKey = requireStr(requireBody(req), "apiKey");
    const key = repo.createKey(channelId, apiKey);
    return await reply.code(201).send(key);
  });

  ctx.app.patch("/admin/keys/:keyId", { preHandler: ctx.requireAdmin }, async (req, reply) => {
    const keyId = Number((req.params as { keyId: string }).keyId);
    const b = requireBody(req);
    const patch: { enabled?: boolean; apiKey?: string } = {};
    const enabled = optionalBoolean(b, "enabled");
    if (enabled !== undefined) patch.enabled = enabled;
    if (b.apiKey !== undefined) {
      if (typeof b.apiKey !== "string" || !b.apiKey.trim()) throw httpError(400, "'apiKey' must be a non-empty string");
      patch.apiKey = b.apiKey;
    }
    const key = repo.updateKey(keyId, patch);
    if (!key) throw httpError(404, "key not found");
    return key;
  });

  ctx.app.delete("/admin/keys/:keyId", { preHandler: ctx.requireAdmin }, async (req, reply) => {
    const keyId = Number((req.params as { keyId: string }).keyId);
    if (!repo.deleteKey(keyId)) throw httpError(404, "key not found");
    return await reply.code(204).send();
  });

  // ---- models ----

  ctx.app.get("/admin/models", { preHandler: ctx.requireAdmin }, async () => {
    return repo.listModels().map((m) => ({
      ...m,
      channelName: repo.getChannel(m.channelId)?.name ?? null,
    }));
  });

  ctx.app.post("/admin/models", { preHandler: ctx.requireAdmin }, async (req, reply) => {
    const b = requireBody(req);
    const publicName = requireStr(b, "publicName");
    if (typeof b.channelId !== "number" || !Number.isInteger(b.channelId)) throw httpError(400, "'channelId' must be an integer");
    const channelId = b.channelId;
    if (!repo.getChannel(channelId)) throw httpError(400, `channel ${channelId} not found`);
    let upstreamName: string | undefined;
    if (b.upstreamName !== undefined) {
      if (typeof b.upstreamName !== "string" || !b.upstreamName.trim()) throw httpError(400, "'upstreamName' must be a non-empty string");
      upstreamName = b.upstreamName.trim();
    }
    try {
      const model = repo.createModel({ publicName: publicName.trim(), channelId, upstreamName });
      return await reply.code(201).send(model);
    } catch (err) {
      if (err instanceof ConflictError) throw httpError(409, err.message);
      throw err;
    }
  });

  ctx.app.patch("/admin/models/:id", { preHandler: ctx.requireAdmin }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const b = requireBody(req);
    const patch: { publicName?: string; channelId?: number; upstreamName?: string; enabled?: boolean } = {};
    if (b.publicName !== undefined) patch.publicName = requireStr(b, "publicName").trim();
    if (b.channelId !== undefined) {
      if (typeof b.channelId !== "number" || !Number.isInteger(b.channelId)) throw httpError(400, "'channelId' must be an integer");
      if (!repo.getChannel(b.channelId)) throw httpError(400, `channel ${b.channelId} not found`);
      patch.channelId = b.channelId;
    }
    if (b.upstreamName !== undefined) patch.upstreamName = requireStr(b, "upstreamName").trim();
    const enabled = optionalBoolean(b, "enabled");
    if (enabled !== undefined) patch.enabled = enabled;
    try {
      const model = repo.updateModel(id, patch);
      if (!model) throw httpError(404, "model not found");
      return model;
    } catch (err) {
      if (err instanceof ConflictError) throw httpError(409, err.message);
      throw err;
    }
  });

  ctx.app.delete("/admin/models/:id", { preHandler: ctx.requireAdmin }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!repo.deleteModel(id)) throw httpError(404, "model not found");
    return await reply.code(204).send();
  });

  // ---- api keys (outbound auth) ----

  ctx.app.get("/admin/api-keys", { preHandler: ctx.requireAdmin }, async () => repo.listApiKeys());

  ctx.app.post("/admin/api-keys", { preHandler: ctx.requireAdmin }, async (req, reply) => {
    const name = requireStr(requireBody(req), "name");
    return await reply.code(201).send(repo.createApiKey(name.trim()));
  });

  ctx.app.patch("/admin/api-keys/:id", { preHandler: ctx.requireAdmin }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const b = requireBody(req);
    const patch: { name?: string; enabled?: boolean } = {};
    if (b.name !== undefined) patch.name = requireStr(b, "name").trim();
    const enabled = optionalBoolean(b, "enabled");
    if (enabled !== undefined) patch.enabled = enabled;
    const key = repo.updateApiKey(id, patch);
    if (!key) throw httpError(404, "api key not found");
    return key;
  });

  ctx.app.delete("/admin/api-keys/:id", { preHandler: ctx.requireAdmin }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!repo.deleteApiKey(id)) throw httpError(404, "api key not found");
    return await reply.code(204).send();
  });

  // ---- logs ----

  ctx.app.get("/admin/logs", { preHandler: ctx.requireAdmin }, async (req) => {
    const raw = (req.query as { limit?: string } | null)?.limit;
    let limit = 50;
    if (raw !== undefined) {
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isFinite(parsed) || parsed < 1) throw httpError(400, "'limit' must be a positive integer");
      limit = Math.min(parsed, 500);
    }
    return repo.recentLogs(limit);
  });
}
