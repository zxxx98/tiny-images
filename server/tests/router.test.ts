import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/store/db.js";
import { Repo } from "../src/store/repo.js";
import { ModelRouter } from "../src/core/router.js";

let repo: Repo;
let router: ModelRouter;
beforeEach(() => {
  repo = new Repo(openDb(fs.mkdtempSync(path.join(os.tmpdir(), "rt-"))));
  router = new ModelRouter(repo);
});

describe("ModelRouter", () => {
  it("filters NSFW routes unless the caller is explicitly allowed", () => {
    const safeChannel = repo.createChannel({ name: "safe", baseUrl: "https://safe.test/v1" });
    const adultChannel = repo.createChannel({ name: "adult", baseUrl: "https://adult.test/v1" });
    const safe = repo.createModel({ publicName: "img", channelId: safeChannel.id, priority: 10 });
    const adult = repo.createModel({ publicName: "img", channelId: adultChannel.id, priority: 0, supportsNsfw: true });

    expect(router.resolve("img", { allowedChannelIds: null, allowNsfw: false })?.model.id).toBe(safe.id);
    expect(router.resolve("img", { allowedChannelIds: null, allowNsfw: true })?.model.id).toBe(adult.id);
    expect(router.resolve("img", { allowedChannelIds: [adultChannel.id], allowNsfw: false })).toBeNull();
  });
  it("resolves enabled model on enabled channel", () => {
    const c = repo.createChannel({ name: "a", baseUrl: "https://x/v1" });
    repo.createModel({ publicName: "img", channelId: c.id, upstreamName: "up-1" });
    const r = router.resolve("img")!;
    expect(r.model.upstreamName).toBe("up-1");
    expect(r.channel.baseUrl).toBe("https://x/v1");
  });
  it("rejects disabled model / disabled channel / unknown model", () => {
    const c = repo.createChannel({ name: "a", baseUrl: "https://x/v1" });
    const m = repo.createModel({ publicName: "img", channelId: c.id });
    repo.updateModel(m.id, { enabled: false });
    expect(router.resolve("img")).toBeNull();
    repo.updateModel(m.id, { enabled: true });
    repo.updateChannel(c.id, { enabled: false });
    expect(router.resolve("img")).toBeNull();
    expect(router.resolve("nope")).toBeNull();
  });
});

describe("ModelRouter failover + circuit breaker", () => {
  it("round-robins mappings with the same priority", () => {
    const c1 = repo.createChannel({ name: "a", baseUrl: "https://x/v1" });
    const c2 = repo.createChannel({ name: "b", baseUrl: "https://y/v1" });
    repo.createModel({ publicName: "img", channelId: c1.id, priority: 0 });
    repo.createModel({ publicName: "img", channelId: c2.id, priority: 0 });
    expect(router.resolve("img")!.channel.id).toBe(c1.id);
    expect(router.resolve("img")!.channel.id).toBe(c2.id);
    expect(router.resolve("img")!.channel.id).toBe(c1.id);
  });
  it("falls back to next channel by priority when primary disabled/not allowed", () => {
    const c1 = repo.createChannel({ name: "a", baseUrl: "https://x/v1" });
    const c2 = repo.createChannel({ name: "b", baseUrl: "https://y/v1" });
    repo.createModel({ publicName: "img", channelId: c1.id, priority: 0 });
    const backup = repo.createModel({ publicName: "img", channelId: c2.id, priority: 10 });
    // 主渠道禁用 → 走备选
    repo.updateChannel(c1.id, { enabled: false });
    expect(router.resolve("img")!.model.id).toBe(backup.id);
    repo.updateChannel(c1.id, { enabled: true });
    // 用户渠道组不包含主渠道 → 走备选
    expect(router.resolve("img", { allowedChannelIds: [c2.id], allowNsfw: false })!.model.id).toBe(backup.id);
    expect(router.resolve("img", { allowedChannelIds: [999], allowNsfw: false })).toBeNull();
  });

  it("opens circuit after consecutive failures and skips channel until cooldown", () => {
    const c1 = repo.createChannel({ name: "a", baseUrl: "https://x/v1" });
    const c2 = repo.createChannel({ name: "b", baseUrl: "https://y/v1" });
    repo.createModel({ publicName: "img", channelId: c1.id, priority: 0 });
    const backup = repo.createModel({ publicName: "img", channelId: c2.id, priority: 10 });
    // 阈值内仍选主渠道
    router.markFailure(c1.id);
    router.markFailure(c1.id);
    expect(router.resolve("img")!.channel.id).toBe(c1.id);
    // 达到阈值 → 主渠道熔断，切备选
    router.markFailure(c1.id);
    expect(router.isCoolingDown(c1.id)).toBe(true);
    expect(router.resolve("img")!.model.id).toBe(backup.id);
    // 冷却结束恢复
    router.markSuccess(c1.id);
    expect(router.resolve("img")!.channel.id).toBe(c1.id);
  });
});
