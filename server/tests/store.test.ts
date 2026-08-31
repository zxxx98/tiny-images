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
    expect(c.type).toBe("openai-compat");
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
  it("persists channel type on create and update", () => {
    const c = repo.createChannel({ name: "h", type: "ai-horde", baseUrl: "https://aihorde.net/api/v2" });
    expect(c.type).toBe("ai-horde");
    expect(repo.updateChannel(c.id, { type: "openai-compat" })?.type).toBe("openai-compat");
  });
});

describe("models", () => {
  it("allows duplicate enabled public_name (failover routes ordered by priority)", () => {
    const c1 = repo.createChannel({ name: "a", baseUrl: "https://x/v1" });
    const c2 = repo.createChannel({ name: "b", baseUrl: "https://y/v1" });
    const primary = repo.createModel({ publicName: "img-1", channelId: c1.id, priority: 0 });
    const backup = repo.createModel({ publicName: "img-1", channelId: c2.id, priority: 10 });
    const routes = repo.listEnabledModelRoutes("img-1");
    expect(routes.map((r) => r.id)).toEqual([primary.id, backup.id]);
    // 禁用备选后只剩主选
    repo.updateModel(backup.id, { enabled: false });
    expect(repo.listEnabledModelRoutes("img-1").map((r) => r.id)).toEqual([primary.id]);
    // priority 修改生效
    repo.updateModel(primary.id, { priority: 5 });
    expect(repo.getModel(primary.id)?.priority).toBe(5);
  });
  it("finds enabled by name", () => {
    const c = repo.createChannel({ name: "a", baseUrl: "https://x/v1" });
    const m = repo.createModel({ publicName: "img-1", channelId: c.id, upstreamName: "gpt-image-1" });
    expect(repo.findEnabledModel("img-1")?.id).toBe(m.id);
    repo.updateModel(m.id, { enabled: false });
    expect(repo.findEnabledModel("img-1")).toBeNull();
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

describe("application settings", () => {
  it("returns empty application settings by default", () => {
    expect(repo.getAppSettings()).toEqual({
      globalPrompt: "",
      announcement: "",
      announcementVersion: 0,
    });
  });

  it("persists settings and versions only changed announcements", () => {
    expect(repo.updateAppSettings({ globalPrompt: "house style", announcement: "hello" })).toEqual({
      globalPrompt: "house style",
      announcement: "hello",
      announcementVersion: 1,
    });
    expect(repo.updateAppSettings({ globalPrompt: "new style", announcement: "hello" }).announcementVersion).toBe(1);
    expect(repo.updateAppSettings({ globalPrompt: "new style", announcement: "changed" }).announcementVersion).toBe(2);
  });

  it("keeps application settings after reopening the database", () => {
    repo.updateAppSettings({ globalPrompt: "persistent style", announcement: "persistent notice" });
    repo.close();
    repo = new Repo(openDb(dir));
    expect(repo.getAppSettings()).toEqual({
      globalPrompt: "persistent style",
      announcement: "persistent notice",
      announcementVersion: 1,
    });
  });
});

describe("logs", () => {
  it("inserts, lists recent, prunes to 50", () => {
    for (let i = 0; i < 55; i++) {
      repo.insertLog({ ts: i, model: "m", channelId: 1, apiKeyId: null, status: "ok", httpStatus: 200, latencyMs: 10, errorMessage: null });
    }
    const logs = repo.recentLogs(100);
    expect(logs).toHaveLength(50);
    expect(logs[0].ts).toBe(54);
    expect(logs.at(-1)?.ts).toBe(5);
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
