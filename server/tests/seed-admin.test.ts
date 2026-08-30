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
  it("creates admin@local with random password when table empty", () => {
    const r = seedAdminIfEmpty(repo, {});
    expect(r.created).toBe(true);
    expect(r.email).toBe("admin@local");
    expect(r.password).toMatch(/^[A-Za-z0-9_-]{12}$/);
    const u = repo.getUserByEmail("admin@local")!;
    expect(u.role).toBe("admin");
    expect(verifyPassword(r.password!, u.passwordHash)).toBe(true);
  });
  it("uses ADMIN_EMAIL/ADMIN_PASSWORD when provided", () => {
    const r = seedAdminIfEmpty(repo, { adminEmail: "Boss@X.com", adminPassword: "super-secret" });
    expect(r).toEqual({ created: true, email: "boss@x.com", password: null });
    expect(verifyPassword("super-secret", repo.getUserByEmail("boss@x.com")!.passwordHash)).toBe(true);
  });
  it("no-op when users exist", () => {
    repo.createUser({ email: "a@x.com", passwordHash: "a:b", role: "user", quotaTotal: 1 });
    expect(seedAdminIfEmpty(repo, {})).toEqual({ created: false, email: "", password: null });
    expect(repo.listUsers()).toHaveLength(1);
  });
});
