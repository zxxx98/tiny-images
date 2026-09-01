import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../src/core/password.js";
import { openDb } from "../src/store/db.js";
import { ConflictError, quotaDayAt, Repo } from "../src/store/repo.js";

let dir: string;
let repo: Repo;
let now: number;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gu-"));
  now = Date.UTC(2026, 0, 1, 15, 59, 59);
  repo = new Repo(openDb(dir), () => now);
});
afterEach(() => {
  repo.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("password", () => {
  it("hash + verify", () => {
    const h = hashPassword("secret123");
    expect(h).toMatch(/^[0-9a-f]+:[0-9a-f]+$/);
    expect(verifyPassword("secret123", h)).toBe(true);
    expect(verifyPassword("wrong", h)).toBe(false);
  });
});

describe("channel groups", () => {
  it("CRUD + member replacement + cascade on delete", () => {
    const c1 = repo.createChannel({ name: "c1", baseUrl: "http://x" });
    const c2 = repo.createChannel({ name: "c2", baseUrl: "http://y" });
    const g = repo.createGroup("vip");
    repo.setGroupChannels(g.id, [c1.id, c2.id]);
    expect(repo.listGroups()).toEqual([{ id: g.id, name: "vip", createdAt: g.createdAt, channelIds: [c1.id, c2.id] }]);

    repo.setGroupChannels(g.id, [c2.id]);
    expect(repo.listGroups()[0].channelIds).toEqual([c2.id]);

    expect(() => repo.createGroup("vip")).toThrow(ConflictError);
    const renamed = repo.updateGroup(g.id, "svip");
    expect(renamed?.name).toBe("svip");
    expect(repo.updateGroup(999, "x")).toBeNull();

    // 渠道被删时成员关系级联消失
    repo.setGroupChannels(g.id, [c1.id]);
    repo.deleteChannel(c1.id);
    expect(repo.listGroups()[0].channelIds).toEqual([]);

    expect(repo.deleteGroup(g.id)).toBe(true);
    expect(repo.listGroups()).toHaveLength(0);
    expect(repo.deleteGroup(g.id)).toBe(false);
  });
});

describe("users", () => {
  it("create/list/get/update/delete + unique email", () => {
    const u = repo.createUser({ email: "A@x.com", passwordHash: "aa:bb", role: "user", quotaTotal: 100 });
    expect(u.email).toBe("a@x.com"); // 统一小写
    expect(u.quotaUsed).toBe(0);
    expect(u.allowNsfw).toBe(false);
    expect(() => repo.createUser({ email: "a@x.com", passwordHash: "c", role: "user", quotaTotal: 1 })).toThrow(ConflictError);
    expect(repo.getUserByEmail("A@X.com")?.id).toBe(u.id);
    expect(repo.listUsers()).toHaveLength(1);

    const patched = repo.updateUser(u.id, { quotaTotal: 50, enabled: false, passwordHash: "cc:dd", allowNsfw: true });
    expect(patched).toMatchObject({ quotaTotal: 50, enabled: false, passwordHash: "cc:dd", allowNsfw: true });
    expect(repo.updateUser(999, { enabled: true })).toBeNull();

    expect(repo.deleteUser(u.id)).toBe(true);
    expect(repo.getUser(u.id)).toBeNull();
    expect(repo.deleteUser(u.id)).toBe(false);
  });

  it("user groups + allowedChannelIds", () => {
    const c1 = repo.createChannel({ name: "c1", baseUrl: "http://x" });
    const c2 = repo.createChannel({ name: "c2", baseUrl: "http://y" });
    const g1 = repo.createGroup("g1");
    repo.setGroupChannels(g1.id, [c1.id]);
    const g2 = repo.createGroup("g2");
    repo.setGroupChannels(g2.id, [c2.id]);

    const u = repo.createUser({ email: "u@x.com", passwordHash: "a:b", role: "user", quotaTotal: 10 });
    // 无组 → null（全部渠道）
    expect(repo.allowedChannelIds(u.id)).toBeNull();
    expect(repo.allowedChannelIds(null)).toBeNull();

    repo.setUserGroups(u.id, [g1.id, g2.id]);
    expect(repo.getUser(u.id)?.groupIds).toEqual([g1.id, g2.id]);
    expect([...repo.allowedChannelIds(u.id)!].sort()).toEqual([c1.id, c2.id]);

    // 组被删 → 成员关系级联，组集合变小
    repo.deleteGroup(g2.id);
    expect(repo.allowedChannelIds(u.id)).toEqual([c1.id]);
  });

  it("chargeQuota conditional + null quota unlimited", () => {
    const u = repo.createUser({ email: "u@x.com", passwordHash: "a:b", role: "user", quotaTotal: 5 });
    expect(repo.chargeQuota(u.id, 3)).toBe(true);
    expect(repo.getUser(u.id)?.quotaUsed).toBe(3);
    expect(repo.chargeQuota(u.id, 3)).toBe(false); // 3+3 > 5
    expect(repo.getUser(u.id)?.quotaUsed).toBe(3);
    expect(repo.chargeQuota(u.id, 2)).toBe(true);

    const free = repo.createUser({ email: "f@x.com", passwordHash: "a:b", role: "user", quotaTotal: null });
    expect(repo.chargeQuota(free.id, 9999)).toBe(true);
  });

  it("uses Beijing calendar days and resets quota once after midnight", () => {
    expect(quotaDayAt(Date.UTC(2026, 0, 1, 15, 59, 59))).toBe("2026-01-01");
    expect(quotaDayAt(Date.UTC(2026, 0, 1, 16, 0, 0))).toBe("2026-01-02");

    const u = repo.createUser({ email: "daily@x.com", passwordHash: "a:b", role: "user", quotaTotal: 5 });
    expect(repo.chargeQuota(u.id, 5)).toBe(true);
    expect(repo.getUser(u.id)).toMatchObject({ quotaUsed: 5, quotaDay: "2026-01-01" });

    now = Date.UTC(2026, 0, 1, 16, 0, 0);
    expect(repo.getUserByEmail("daily@x.com")).toMatchObject({ quotaUsed: 0, quotaDay: "2026-01-02" });
    expect(repo.chargeQuota(u.id, 2)).toBe(true);
    expect(repo.listUsers()[0]).toMatchObject({ quotaUsed: 2, quotaDay: "2026-01-02" });
    expect(repo.getUser(u.id)?.quotaUsed).toBe(2);
  });

  it("keeps current-day reads read-only while another connection is writing", () => {
    const multiDir = path.join(dir, "current-day-read");
    const db1 = openDb(multiDir);
    const db2 = openDb(multiDir);
    const repo1 = new Repo(db1, () => now);
    const repo2 = new Repo(db2, () => now);
    const u = repo1.createUser({ email: "reader@x.com", passwordHash: "a:b", role: "user", quotaTotal: 5 });
    expect(repo1.chargeQuota(u.id, 1)).toBe(true);

    db1.exec("BEGIN IMMEDIATE");
    try {
      expect(repo2.getUser(u.id)).toMatchObject({ quotaUsed: 1, quotaDay: "2026-01-01" });
    } finally {
      db1.exec("ROLLBACK");
      repo1.close();
      repo2.close();
    }
  });

  it("never moves a quota day backward when Repo clocks disagree", () => {
    const multiDir = path.join(dir, "clock-skew");
    const oldRepo = new Repo(openDb(multiDir), () => Date.UTC(2026, 0, 1, 15, 59, 59));
    const newRepo = new Repo(openDb(multiDir), () => Date.UTC(2026, 0, 1, 16, 0, 0));
    try {
      const u = oldRepo.createUser({ email: "skew@x.com", passwordHash: "a:b", role: "user", quotaTotal: 5 });
      expect(oldRepo.chargeQuota(u.id, 3)).toBe(true);
      expect(newRepo.getUser(u.id)).toMatchObject({ quotaUsed: 0, quotaDay: "2026-01-02" });
      expect(newRepo.chargeQuota(u.id, 2)).toBe(true);

      expect(oldRepo.getUser(u.id)).toMatchObject({ quotaUsed: 2, quotaDay: "2026-01-02" });
      expect(oldRepo.chargeQuota(u.id, 1)).toBe(true);
      expect(newRepo.getUser(u.id)).toMatchObject({ quotaUsed: 3, quotaDay: "2026-01-02" });
    } finally {
      oldRepo.close();
      newRepo.close();
    }
  });

  it("configures SQLite to wait briefly for concurrent writers", () => {
    const db = openDb(path.join(dir, "busy-timeout"));
    try {
      const row = db.prepare("PRAGMA busy_timeout").get() as Record<string, unknown>;
      expect(Number(Object.values(row)[0])).toBeGreaterThanOrEqual(5_000);
    } finally {
      db.close();
    }
  });
});
