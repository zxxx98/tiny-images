import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/store/db.js";
import { Repo } from "../src/store/repo.js";
import { KeyPool } from "../src/core/keyPool.js";

let repo: Repo;
let pool: KeyPool;
let channelId: number;
beforeEach(() => {
  repo = new Repo(openDb(fs.mkdtempSync(path.join(os.tmpdir(), "kp-"))));
  pool = new KeyPool(repo);
  channelId = repo.createChannel({ name: "a", baseUrl: "https://x/v1" }).id;
});

describe("KeyPool", () => {
  it("returns null when no keys", () => {
    expect(pool.pick(channelId)).toBeNull();
  });
  it("rotates between keys", () => {
    const k1 = repo.createKey(channelId, "sk-1");
    const k2 = repo.createKey(channelId, "sk-2");
    const picks = [pool.pick(channelId)!.keyId, pool.pick(channelId)!.keyId];
    expect(new Set(picks)).toEqual(new Set([k1.id, k2.id]));
  });
  it("skips cooled-down keys", () => {
    const k = repo.createKey(channelId, "sk-1");
    pool.markFailure(k.id, 60_000);
    expect(pool.pick(channelId)).toBeNull();
    pool.markSuccess(k.id);
    expect(pool.pick(channelId)?.keyId).toBe(k.id);
  });
  it("ignores disabled keys", () => {
    const k = repo.createKey(channelId, "sk-1");
    repo.updateKey(k.id, { enabled: false });
    expect(pool.pick(channelId)).toBeNull();
  });
});
