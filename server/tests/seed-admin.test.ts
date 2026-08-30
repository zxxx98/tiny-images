import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyPassword } from "../src/core/password.js";
import { openDb } from "../src/store/db.js";
import { Repo } from "../src/store/repo.js";
import { seedAdminIfEmpty } from "../src/store/seed.js";

let dir: string;
let repo: Repo;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sa-"));
  repo = new Repo(openDb(dir));
});
afterEach(() => {
  repo.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("seedAdminIfEmpty", () => {
  it("requires ADMIN_EMAIL/ADMIN_PASSWORD when table empty", () => {
    expect(() => seedAdminIfEmpty(repo, {})).toThrow(/ADMIN_EMAIL/);
    expect(() => seedAdminIfEmpty(repo, { adminEmail: "a@x.com" })).toThrow(/ADMIN_EMAIL/);
    expect(() => seedAdminIfEmpty(repo, { adminPassword: "pw" })).toThrow(/ADMIN_EMAIL/);
    expect(repo.listUsers()).toHaveLength(0);
  });
  it("creates admin from ADMIN_EMAIL/ADMIN_PASSWORD", () => {
    const r = seedAdminIfEmpty(repo, { adminEmail: "Boss@X.com", adminPassword: "super-secret" });
    expect(r).toEqual({ created: true, email: "boss@x.com", password: null });
    const u = repo.getUserByEmail("boss@x.com")!;
    expect(u.role).toBe("admin");
    expect(verifyPassword("super-secret", u.passwordHash)).toBe(true);
  });
  it("no-op when users exist", () => {
    repo.createUser({ email: "a@x.com", passwordHash: "a:b", role: "user", quotaTotal: 1 });
    expect(seedAdminIfEmpty(repo, {})).toEqual({ created: false, email: "", password: null });
    expect(repo.listUsers()).toHaveLength(1);
  });
});
