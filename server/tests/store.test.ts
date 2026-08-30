import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/store/db.js";
import { ConflictError, Repo } from "../src/store/repo.js";

let dir: string;
let repo: Repo;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ti-"));
  repo = new Repo(openDb(dir));
});
afterEach(() => {
  repo.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("channels", () => {
  it("creates and rejects duplicate name", () => {
    const c = repo.createChannel({ name: "a", baseUrl: "https://x/v1" });
    expect(c.enabled).toBe(true);
    expect(c.timeoutMs).toBe(120000);
    expect(() => repo.createChannel({ name: "a", baseUrl: "https://y/v1" })).toThrow(ConflictError);
  });
  it("updates and deletes", () => {
    const c = repo.createChannel({ name: "a", baseUrl: "https://x/v1" });
    const u = repo.updateChannel(c.id, { baseUrl: "https://z/v1", enabled: false });
    expect(u?.baseUrl).toBe("https://z/v1");
    expect(u?.enabled).toBe(false);
    expect(repo.deleteChannel(c.id)).toBe(true);
    expect(repo.getChannel(c.id)).toBeNull();
  });
});

describe("models", () => {
  it("enforces unique enabled public_name", () => {
    const c = repo.createChannel({ name: "a", baseUrl: "https://x/v1" });
    repo.createModel({ publicName: "img-1", channelId: c.id });
    expect(() => repo.createModel({ publicName: "img-1", channelId: c.id })).toThrow(ConflictError);
    const m2 = repo.createModel({ publicName: "img-1", channelId: c.id, enabled: false });
    expect(m2.enabled).toBe(false);
  });
  it("finds enabled by name and conflicts on duplicates among enabled", () => {
    const c = repo.createChannel({ name: "a", baseUrl: "https://x/v1" });
    const m = repo.createModel({ publicName: "img-1", channelId: c.id, upstreamName: "gpt-image-1" });
    expect(repo.findEnabledModel("img-1")?.id).toBe(m.id);
    repo.updateModel(m.id, { enabled: false });
    expect(repo.findEnabledModel("img-1")).toBeNull();
    // 禁用后允许新建同名启用模型
    const again = repo.createModel({ publicName: "img-1", channelId: c.id });
    expect(again.enabled).toBe(true);
    // 两个启用模型同名 → 冲突
    const other = repo.createModel({ publicName: "img-2", channelId: c.id });
    expect(() => repo.updateModel(other.id, { publicName: "img-1" })).toThrow(ConflictError);
    // 重新启用被禁用的同名模型也冲突
    expect(() => repo.updateModel(m.id, { enabled: true })).toThrow(ConflictError);
  });
});

describe("keys", () => {
  it("cooldown persists and enabled filtering ignores cooldown", () => {
    const c = repo.createChannel({ name: "a", baseUrl: "https://x/v1" });
    const k = repo.createKey(c.id, "sk-upstream");
    const until = Date.now() + 60_000;
    repo.setKeyCooldown(k.id, until);
    expect(repo.enabledKeys(c.id)[0].cooldownUntil).toBeGreaterThan(Date.now());
    expect(repo.enabledKeyCount(c.id)).toBe(1);
    repo.setKeyCooldown(k.id, 0);
    expect(repo.enabledKeys(c.id)[0].cooldownUntil).toBe(0);
  });
});

describe("api keys", () => {
  it("generates sk-tiny- prefixed key and finds it", () => {
    const k = repo.createApiKey("test");
    expect(k.key.startsWith("sk-tiny-")).toBe(true);
    expect(repo.findApiKeyByKey(k.key)?.id).toBe(k.id);
  });
});

describe("logs", () => {
  it("inserts, lists recent, prunes to 1000", () => {
    for (let i = 0; i < 1005; i++) {
      repo.insertLog({ ts: i, model: "m", channelId: 1, apiKeyId: null, status: "ok", httpStatus: 200, latencyMs: 10, errorMessage: null });
    }
    const logs = repo.recentLogs(2000);
    expect(logs).toHaveLength(1000);
    expect(logs[0].ts).toBe(1004);
  });
});

describe("generations", () => {
  it("insert/complete/list cursor pagination, key-filtered, failPending", () => {
    const a = repo.createApiKey("k1");
    const id1 = repo.insertGeneration({ createdAt: 1, apiKeyId: a.id, userId: null, model: "m", prompt: "p1", params: "{}", status: "pending", channelId: null, latencyMs: null, errorMessage: null, images: "[]" });
    const id2 = repo.insertGeneration({ createdAt: 2, apiKeyId: a.id, userId: null, model: "m", prompt: "p2", params: "{}", status: "ok", channelId: 1, latencyMs: 5, errorMessage: null, images: '[{"file":"a.png"}]' });
    repo.completeGeneration(id1, { status: "ok", channelId: 1, latencyMs: 9, images: '[{"file":"b.png"}]' });
    const page1 = repo.listGenerations({ admin: false, userId: null, apiKeyId: a.id }, null, 1);
    expect(page1.map((r) => r.id)).toEqual([id2]);
    expect(page1[0].images).toBe('[{"file":"a.png"}]');
    const page2 = repo.listGenerations({ admin: false, userId: null, apiKeyId: a.id }, id2, 10);
    expect(page2.map((r) => r.id)).toEqual([id1]);
    expect(page2[0].status).toBe("ok");
    expect(page2[0].latencyMs).toBe(9);
    const b = repo.createApiKey("k2");
    expect(repo.listGenerations({ admin: false, userId: null, apiKeyId: b.id }, null, 10)).toEqual([]);
    const id3 = repo.insertGeneration({ createdAt: 3, apiKeyId: a.id, userId: null, model: "m", prompt: "p3", params: "{}", status: "pending", channelId: null, latencyMs: null, errorMessage: null, images: "[]" });
    expect(repo.failPendingGenerations("server restarted")).toBe(1);
    expect(repo.listGenerations({ admin: false, userId: null, apiKeyId: a.id }, null, 10).find((r) => r.id === id3)?.errorMessage).toBe("server restarted");
  });
});
