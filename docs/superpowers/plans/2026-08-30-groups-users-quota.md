# 渠道分组、用户角色与额度 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 tiny-images 增加渠道多分组、admin/普通用户角色（邮箱+密码 JWT 登录）、按生图张数计费的额度系统，并把 `/v1` API key 绑定到用户。

**Architecture:** SQLite migration v3 新增 5 张表；Repo 层新增 groups/users/quota 方法；JWT 用 node:crypto HMAC 自实现（无新依赖）；配额扣减收敛在 `Executor`（调用前校验、成功后条件 UPDATE 原子扣减）；渠道过滤通过 `ModelRouter.resolve` 的 allowedChannelIds 参数贯穿到 `/v1` 处理器；前端在 Admin 页加「分组」「用户」Tab，Login 改邮箱+密码。

**Tech Stack:** Fastify 5 + TypeScript + node:sqlite（server）；React 18 + Vite（web）；无新增 npm 依赖。

**设计文档:** `docs/superpowers/specs/2026-08-30-groups-users-quota-design.md`

## Global Constraints

- 无新增 npm 依赖；密码哈希用 `node:crypto` scrypt，JWT 用 `node:crypto` HMAC-SHA256。
- 额度单位为"生图张数"：成功生成 n 张扣 n；超额返回 HTTP 402；admin 与 `quota_total IS NULL` 用户不限量。
- `ADMIN_TOKEN` 保持完全兼容：仍可作为管理接口与 `/v1` 的 Bearer 凭证（视为 admin）。
- 现有无主 api_key 行为不变：不鉴权空表逻辑、不扣额度、不限渠道。
- 修改 `Env` 接口时新字段必须是可选的（`jwtSecret?: string | null` 等），否则现有测试的 env 字面量全部编译失败。
- server 测试命令：`cd server && npx vitest run`；类型检查：`cd server && npx tsc -p tsconfig.build.json --noEmit`；web 构建：`cd web && npm run build`。
- 每个 Task 结束必须 commit；测试先行（TDD）。

---

### Task 1: Migration v3 + 密码工具 + Repo 分组/用户/额度方法

**Files:**
- Modify: `server/src/store/db.ts`（MIGRATIONS 数组追加第 3 项）
- Create: `server/src/core/password.ts`
- Modify: `server/src/store/repo.ts`
- Test: `server/tests/groups-users-store.test.ts`

**Interfaces:**
- Produces（后续任务依赖的精确签名）:

```ts
// core/password.ts
export function hashPassword(password: string): string;            // "salt:hash" 均 hex
export function verifyPassword(password: string, stored: string): boolean;

// repo.ts
export interface GroupRow { id: number; name: string; createdAt: number; channelIds: number[] }
export interface UserRow {
  id: number; email: string; passwordHash: string;
  role: "admin" | "user"; enabled: boolean; createdAt: number;
  quotaTotal: number | null; quotaUsed: number; groupIds: number[];
}
createGroup(name: string): GroupRow                     // 重名抛 ConflictError
listGroups(): GroupRow[]
updateGroup(id: number, name: string): GroupRow | null
deleteGroup(id: number): boolean
setGroupChannels(groupId: number, channelIds: number[]): void
getUser(id: number): UserRow | null
getUserByEmail(email: string): UserRow | null           // email 以小写存取
listUsers(): UserRow[]
createUser(input: { email: string; passwordHash: string; role: "admin" | "user"; quotaTotal: number | null }): UserRow  // 邮箱重复抛 ConflictError
updateUser(id: number, patch: { enabled?: boolean; quotaTotal?: number | null; passwordHash?: string }): UserRow | null
deleteUser(id: number): boolean
setUserGroups(userId: number, groupIds: number[]): void
allowedChannelIds(userId: number | null): number[] | null  // null=全部渠道；用户无组也返回 null
chargeQuota(userId: number, n: number): boolean            // 条件 UPDATE，失败=false
```

- [ ] **Step 1: 写失败的测试**

创建 `server/tests/groups-users-store.test.ts`：

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../src/core/password.js";
import { openDb } from "../src/store/db.js";
import { ConflictError, Repo } from "../src/store/repo.js";

let dir: string;
let repo: Repo;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gu-"));
  repo = new Repo(openDb(dir));
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
    expect(() => repo.createUser({ email: "a@x.com", passwordHash: "c", role: "user", quotaTotal: 1 })).toThrow(ConflictError);
    expect(repo.getUserByEmail("A@X.com")?.id).toBe(u.id);
    expect(repo.listUsers()).toHaveLength(1);

    const patched = repo.updateUser(u.id, { quotaTotal: 50, enabled: false, passwordHash: "cc:dd" });
    expect(patched).toMatchObject({ quotaTotal: 50, enabled: false, passwordHash: "cc:dd" });
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
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd server && npx vitest run tests/groups-users-store.test.ts`
Expected: FAIL（找不到 `../src/core/password.js`、repo 方法不存在）

- [ ] **Step 3: 实现**

`server/src/core/password.ts`（新建）：

```ts
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const hash = scryptSync(password, Buffer.from(saltHex, "hex"), 64);
  const expected = Buffer.from(hashHex, "hex");
  return hash.length === expected.length && timingSafeEqual(hash, expected);
}
```

`server/src/store/db.ts`：在 `MIGRATIONS` 数组末尾（v2 项之后）追加：

```ts
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
```

`server/src/store/repo.ts`：接口 `ApiKeyRow` 增加字段 `userId: number | null`；`toApiKey` 里加 `userId: row.user_id === null || row.user_id === undefined ? null : Number(row.user_id)`。`createApiKey` 签名改为 `createApiKey(name: string, userId: number | null = null)` 并在 INSERT 中写入 user_id。`updateApiKey` 的 patch 类型加 `userId?: number | null`（有传时覆盖）。

在 `Repo` 类末尾（`toGeneration` 之后）追加：

```ts
  // ---- channel groups ----

  createGroup(name: string): GroupRow {
    try {
      const res = this.db.prepare("INSERT INTO channel_groups (name, created_at) VALUES (?, ?)").run(name, Date.now());
      const id = Number(res.lastInsertRowid);
      return { id, name, createdAt: Date.now(), channelIds: [] };
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictError(`group '${name}' already exists`);
      throw err;
    }
  }

  listGroups(): GroupRow[] {
    const rows = this.db.prepare("SELECT * FROM channel_groups ORDER BY id").all() as Record<string, unknown>[];
    const members = this.db.prepare("SELECT group_id, channel_id FROM channel_group_members ORDER BY channel_id").all() as Record<string, unknown>[];
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
      groupIds: groupIds.map((g) => Number(g.group_id)),
    };
  }

  createUser(input: { email: string; passwordHash: string; role: "admin" | "user"; quotaTotal: number | null }): UserRow {
    const email = input.email.toLowerCase();
    try {
      const res = this.db
        .prepare("INSERT INTO users (email, password_hash, role, enabled, quota_total, quota_used, created_at) VALUES (?, ?, ?, 1, ?, 0, ?)")
        .run(email, input.passwordHash, input.role, input.quotaTotal, Date.now());
      return this.getUser(Number(res.lastInsertRowid))!;
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictError(`user '${email}' already exists`);
      throw err;
    }
  }

  getUser(id: number): UserRow | null {
    const row = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this.toUser(row) : null;
  }

  getUserByEmail(email: string): UserRow | null {
    const row = this.db.prepare("SELECT * FROM users WHERE email = ?").get(email.toLowerCase()) as Record<string, unknown> | undefined;
    return row ? this.toUser(row) : null;
  }

  listUsers(): UserRow[] {
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
      .prepare("SELECT DISTINCT m.channel_id FROM user_group_members ug JOIN channel_group_members m ON m.group_id = ug.group_id WHERE ug.user_id = ? ORDER BY m.channel_id")
      .all(userId) as Record<string, unknown>[];
    if (rows.length === 0) return null; // 未配置分组 = 不限
    return rows.map((r) => Number(r.channel_id));
  }

  chargeQuota(userId: number, n: number): boolean {
    const res = this.db
      .prepare("UPDATE users SET quota_used = quota_used + ? WHERE id = ? AND (quota_total IS NULL OR quota_used + ? <= quota_total)")
      .run(n, userId, n);
    return Number(res.changes) > 0;
  }
```

注意：文件顶部的 `import` 不需要新增（`GroupRow`/`UserRow` 接口定义在 `ConflictError` 附近的接口区，随实现一起添加）。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd server && npx vitest run tests/groups-users-store.test.ts && npx vitest run`
Expected: 全部 PASS（migration v3 不破坏既有 store 测试）

- [ ] **Step 5: Commit**

```bash
git add server/src/store/db.ts server/src/store/repo.ts server/src/core/password.ts server/tests/groups-users-store.test.ts
git commit -m "feat(server): migration v3 for groups/users/quota, repo methods, scrypt password"
```

---

### Task 2: JWT + 登录/me/改密码接口 + 鉴权中间件升级

**Files:**
- Create: `server/src/core/jwt.ts`
- Modify: `server/src/env.ts`（Env 加可选字段 + resolveJwtSecret/resolveAdminSeed）
- Modify: `server/src/server/auth.ts`（requireApiKey / requireAdmin / 新增 requireUser）
- Modify: `server/src/app.ts`（装配 jwtSecret、注册 auth 路由）
- Create: `server/src/server/authRoutes.ts`
- Test: `server/tests/users-auth.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `Repo.getUserByEmail/updateUser/chargeQuota`、`core/password.verifyPassword`。
- Produces:

```ts
// core/jwt.ts
export interface JwtPayload { uid: number; role: "admin" | "user"; exp: number }
export function signJwt(payload: { uid: number; role: "admin" | "user" }, secret: string, ttlSeconds: number): string;
export function verifyJwt(token: string, secret: string): JwtPayload | null;  // 无效/过期 → null

// env.ts（Env 新增可选字段）
jwtSecret?: string | null;
adminEmail?: string | null;
adminPassword?: string | null;
export function resolveJwtSecret(dataDir: string, explicit: string | null): string; // env 优先，否则 <dataDir>/jwt_secret 持久化

// auth.ts（FastifyRequest 新增声明）
req.callerUserId?: number | null;   // null = ADMIN_TOKEN / 无主 key / 匿名
req.callerRole?: "admin" | "user" | null;
// requireUser：AdminDeps 同 AuthDeps；ADMIN_TOKEN → {role:'admin'}；有效 JWT 且用户存在且 enabled → 放行；否则 401

// authRoutes.ts
export function registerAuthRoutes(ctx: AppContext & { jwtSecret: string }): void
// POST /admin/auth/login {email,password} → 200 {token, role, email} / 401
// GET  /admin/auth/me（requireUser）→ {role, email, quotaTotal, quotaUsed, quotaRemaining}
// PUT  /admin/auth/password（requireUser）{oldPassword,newPassword} → 204；ADMIN_TOKEN 身份调用返回 400
```

- [ ] **Step 1: 写失败的测试**

创建 `server/tests/users-auth.test.ts`：

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { Executor } from "../src/core/executor.js";
import { hashPassword } from "../src/core/password.js";
import { KeyPool } from "../src/core/keyPool.js";
import { ModelRouter } from "../src/core/router.js";
import { OpenAICompatProvider } from "../src/providers/openai-compat.js";
import { openDb } from "../src/store/db.js";
import { Repo } from "../src/store/repo.js";

let dir: string;
let repo: Repo;
let app: Awaited<ReturnType<typeof buildApp>>;
const H = { authorization: "Bearer admin-secret" };

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "au-"));
  repo = new Repo(openDb(dir));
  repo.createUser({ email: "admin@local", passwordHash: hashPassword("admin-pass"), role: "admin", quotaTotal: null });
  repo.createUser({ email: "u@x.com", passwordHash: hashPassword("user-pass"), role: "user", quotaTotal: 10 });
  const provider = new OpenAICompatProvider();
  const router = new ModelRouter(repo);
  const keyPool = new KeyPool(repo);
  app = await buildApp({
    env: { port: 0, dataDir: dir, adminToken: "admin-secret", publicBaseUrl: null },
    repo, router, keyPool, provider,
    executor: new Executor({ router, keyPool, provider, repo }),
    logger: false, webDist: null,
  });
});
afterEach(async () => {
  await app.close();
  repo.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function login(email: string, password: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await app.inject({ method: "POST", url: "/admin/auth/login", payload: { email, password } });
  return { status: res.statusCode, json: res.json() };
}

describe("POST /admin/auth/login", () => {
  it("ok → token", async () => {
    const r = await login("u@x.com", "user-pass");
    expect(r.status).toBe(200);
    expect(r.json.role).toBe("user");
    expect(typeof r.json.token).toBe("string");
  });
  it("wrong password / unknown email / disabled user → 401", async () => {
    expect((await login("u@x.com", "nope")).status).toBe(401);
    expect((await login("nobody@x.com", "user-pass")).status).toBe(401);
    const u = repo.getUserByEmail("u@x.com")!;
    repo.updateUser(u.id, { enabled: false });
    expect((await login("u@x.com", "user-pass")).status).toBe(401);
    repo.updateUser(u.id, { enabled: true });
  });
  it("bad body → 400", async () => {
    const res = await app.inject({ method: "POST", url: "/admin/auth/login", payload: { email: "u@x.com" } });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /admin/auth/me", () => {
  it("user token → quota info", async () => {
    const { json } = await login("u@x.com", "user-pass");
    const res = await app.inject({ url: "/admin/auth/me", headers: { authorization: `Bearer ${json.token}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ role: "user", email: "u@x.com", quotaTotal: 10, quotaUsed: 0, quotaRemaining: 10 });
  });
  it("admin token still works", async () => {
    const res = await app.inject({ url: "/admin/auth/me", headers: H });
    expect(res.statusCode).toBe(200);
    expect(res.json().role).toBe("admin");
  });
  it("no token → 401", async () => {
    expect((await app.inject({ url: "/admin/auth/me" })).statusCode).toBe(401);
  });
});

describe("role guard", () => {
  it("user JWT cannot call admin API", async () => {
    const { json } = await login("u@x.com", "user-pass");
    const res = await app.inject({ url: "/admin/channels", headers: { authorization: `Bearer ${json.token}` } });
    expect(res.statusCode).toBe(403);
  });
  it("admin JWT can call admin API", async () => {
    const { json } = await login("admin@local", "admin-pass");
    const res = await app.inject({ url: "/admin/whoami", headers: { authorization: `Bearer ${json.token}` } });
    expect(res.statusCode).toBe(200);
  });
});

describe("PUT /admin/auth/password", () => {
  it("change password then re-login", async () => {
    const { json } = await login("u@x.com", "user-pass");
    const auth = { authorization: `Bearer ${json.token}` };
    const bad = await app.inject({ method: "PUT", url: "/admin/auth/password", headers: auth, payload: { oldPassword: "wrong", newPassword: "new-pass-1" } });
    expect(bad.statusCode).toBe(400);
    const ok = await app.inject({ method: "PUT", url: "/admin/auth/password", headers: auth, payload: { oldPassword: "user-pass", newPassword: "new-pass-1" } });
    expect(ok.statusCode).toBe(204);
    expect((await login("u@x.com", "new-pass-1")).status).toBe(200);
    expect((await login("u@x.com", "user-pass")).status).toBe(401);
  });
  it("admin-token identity cannot change password", async () => {
    const res = await app.inject({ method: "PUT", url: "/admin/auth/password", headers: H, payload: { oldPassword: "x", newPassword: "y" } });
    expect(res.statusCode).toBe(400);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd server && npx vitest run tests/users-auth.test.ts`
Expected: FAIL（404，路由不存在）

- [ ] **Step 3: 实现**

`server/src/core/jwt.ts`（新建）：

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

export interface JwtPayload {
  uid: number;
  role: "admin" | "user";
  exp: number;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

export function signJwt(payload: { uid: number; role: "admin" | "user" }, secret: string, ttlSeconds: number): string {
  const body: JwtPayload = { ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds };
  const head = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify(body));
  const sig = createHmac("sha256", secret).update(`${head}.${claims}`).digest("base64url");
  return `${head}.${claims}.${sig}`;
}

export function verifyJwt(token: string, secret: string): JwtPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [head, claims, sig] = parts;
  const expected = createHmac("sha256", secret).update(`${head}.${claims}`).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(claims, "base64url").toString("utf8")) as JwtPayload;
    if (typeof payload.uid !== "number" || (payload.role !== "admin" && payload.role !== "user")) return null;
    if (typeof payload.exp !== "number" || payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}
```

`server/src/env.ts`：`Env` 接口追加三个**可选**字段，文件末尾追加 `resolveJwtSecret`：

```ts
import fs from "node:fs";
import { randomBytes } from "node:crypto";
// Env 接口新增：
//   jwtSecret?: string | null;
//   adminEmail?: string | null;
//   adminPassword?: string | null;
// loadEnv 返回值追加（保持其他字段不变）：
//   jwtSecret: processEnv.JWT_SECRET || null,
//   adminEmail: processEnv.ADMIN_EMAIL || null,
//   adminPassword: processEnv.ADMIN_PASSWORD || null,

export function resolveJwtSecret(dataDir: string, explicit: string | null): string {
  if (explicit) return explicit;
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, "jwt_secret");
  if (fs.existsSync(file)) {
    const saved = fs.readFileSync(file, "utf8").trim();
    if (saved) return saved;
  }
  const secret = randomBytes(32).toString("base64url");
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}
```

`server/src/server/auth.ts` 整体替换为：

```ts
import type { FastifyReply, FastifyRequest } from "fastify";
import { verifyJwt } from "../core/jwt.js";
import type { Repo } from "../store/repo.js";

export interface AuthDeps {
  repo: Repo;
  adminToken: string | null;
  jwtSecret?: string | null;
}

export function bearerOf(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice(7).trim();
  return token || null;
}

declare module "fastify" {
  interface FastifyRequest {
    callerApiKeyId?: number | null;
    callerUserId?: number | null;
    callerRole?: "admin" | "user" | null;
  }
}

function unauthorized(reply: FastifyReply, message: string): void {
  reply.code(401).send({ error: { message, type: "invalid_request_error", code: "invalid_api_key" } });
}

function forbidden(reply: FastifyReply, message: string): void {
  reply.code(403).send({ error: { message, type: "invalid_request_error", code: null } });
}

function userFromJwt(deps: AuthDeps, token: string | null): { uid: number; role: "admin" | "user" } | null {
  if (!deps.jwtSecret || !token) return null;
  const payload = verifyJwt(token, deps.jwtSecret);
  return payload ? { uid: payload.uid, role: payload.role } : null;
}

export function makeRequireApiKey(deps: AuthDeps) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const token = bearerOf(req);
    if (deps.adminToken && token === deps.adminToken) {
      req.callerApiKeyId = null;
      req.callerUserId = null;
      req.callerRole = "admin";
      return;
    }
    const jwtUser = userFromJwt(deps, token);
    if (jwtUser) {
      const user = deps.repo.getUser(jwtUser.uid);
      if (!user || !user.enabled) {
        unauthorized(reply, "user is disabled or deleted");
        return;
      }
      req.callerApiKeyId = null;
      req.callerUserId = user.id;
      req.callerRole = user.role;
      return;
    }
    const keys = deps.repo.listApiKeys();
    if (keys.length === 0) {
      req.callerApiKeyId = null;
      req.callerUserId = null;
      return;
    }
    const found = token ? deps.repo.findApiKeyByKey(token) : null;
    if (!found || !found.enabled) {
      unauthorized(reply, "invalid api key");
      return;
    }
    req.callerApiKeyId = found.id;
    if (found.userId !== null) {
      const user = deps.repo.getUser(found.userId);
      if (!user || !user.enabled) {
        unauthorized(reply, "user is disabled or deleted");
        return;
      }
      req.callerUserId = user.id;
      req.callerRole = user.role;
    } else {
      req.callerUserId = null;
    }
  };
}

export function makeRequireAdmin(deps: AuthDeps) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const token = bearerOf(req);
    if (deps.adminToken && token === deps.adminToken) {
      req.callerUserId = null;
      req.callerRole = "admin";
      return;
    }
    const jwtUser = userFromJwt(deps, token);
    if (jwtUser && jwtUser.role === "admin") {
      const user = deps.repo.getUser(jwtUser.uid);
      if (user && user.enabled) {
        req.callerUserId = user.id;
        req.callerRole = "admin";
        return;
      }
    }
    if (!deps.adminToken) {
      const ip = req.ip ?? "";
      const loopback = ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
      if (loopback) return;
      reply.code(401).send({
        error: { message: "ADMIN_TOKEN not configured; admin API restricted to localhost", type: "invalid_request_error", code: null },
      });
      return;
    }
    unauthorized(reply, "invalid admin token");
  };
}

// 登录用户自身可用的接口（me / 改密码）。ADMIN_TOKEN 身份 role=admin 但 uid=null。
export function makeRequireUser(deps: AuthDeps) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const token = bearerOf(req);
    if (deps.adminToken && token === deps.adminToken) {
      req.callerUserId = null;
      req.callerRole = "admin";
      return;
    }
    const jwtUser = userFromJwt(deps, token);
    if (jwtUser) {
      const user = deps.repo.getUser(jwtUser.uid);
      if (user && user.enabled) {
        req.callerUserId = user.id;
        req.callerRole = user.role;
        return;
      }
    }
    forbidden(reply, "authentication required");
  };
}
```

`server/src/server/authRoutes.ts`（新建）：

```ts
import { signJwt } from "../core/jwt.js";
import { verifyPassword, hashPassword } from "../core/password.js";
import { httpError } from "../core/errors.js";
import type { AppContext } from "../app.js";
import { requireBody, requireStr } from "./validate.js";

export function registerAuthRoutes(ctx: AppContext, jwtSecret: string): void {
  const repo = ctx.deps.repo;

  ctx.app.post("/admin/auth/login", async (req) => {
    const b = requireBody(req);
    const email = requireStr(b, "email").trim().toLowerCase();
    const password = requireStr(b, "password");
    const user = repo.getUserByEmail(email);
    if (!user || !user.enabled || !verifyPassword(password, user.passwordHash)) {
      throw httpError(401, "invalid email or password");
    }
    const token = signJwt({ uid: user.id, role: user.role }, jwtSecret, 7 * 24 * 3600);
    return { token, role: user.role, email: user.email };
  });

  ctx.app.get("/admin/auth/me", { preHandler: ctx.requireUser }, async (req) => {
    if (req.callerRole === "admin" && !req.callerUserId) {
      return { role: "admin", email: "admin-token", quotaTotal: null, quotaUsed: 0, quotaRemaining: null };
    }
    const user = repo.getUser(req.callerUserId!);
    if (!user) throw httpError(401, "user not found");
    return {
      role: user.role,
      email: user.email,
      quotaTotal: user.quotaTotal,
      quotaUsed: user.quotaUsed,
      quotaRemaining: user.quotaTotal === null ? null : Math.max(0, user.quotaTotal - user.quotaUsed),
    };
  });

  ctx.app.put("/admin/auth/password", { preHandler: ctx.requireUser }, async (req, reply) => {
    if (!req.callerUserId) throw httpError(400, "admin-token identity has no password");
    const b = requireBody(req);
    const oldPassword = requireStr(b, "oldPassword");
    const newPassword = requireStr(b, "newPassword");
    if (newPassword.length < 6) throw httpError(400, "'newPassword' must be at least 6 characters");
    const user = repo.getUser(req.callerUserId)!;
    if (!verifyPassword(oldPassword, user.passwordHash)) throw httpError(400, "old password is incorrect");
    repo.updateUser(user.id, { passwordHash: hashPassword(newPassword) });
    return await reply.code(204).send();
  });
}
```

注意：`requireBody`/`requireStr` 目前是 `admin.ts` 的模块私有函数。将它们从 `admin.ts` 导出（加 `export` 关键字），authRoutes 从 `./admin.js` 导入：`import { requireBody, requireStr } from "./admin.js";`（上面 import 行相应调整）。

`server/src/app.ts` 修改：

```ts
// import 区追加
import { registerAuthRoutes } from "./server/authRoutes.js";
import { makeRequireUser } from "./server/auth.js";
import { resolveJwtSecret } from "./env.js";

// buildApp 内，const requireApiKey = ... 之前：
const jwtSecret = resolveJwtSecret(deps.env.dataDir, deps.env.jwtSecret ?? null);
const authDeps = { repo: deps.repo, adminToken: deps.env.adminToken, jwtSecret };

const requireApiKey = makeRequireApiKey(authDeps);
const requireAdmin = makeRequireAdmin(authDeps);
const requireUser = makeRequireUser(authDeps);
// AppContext 接口加一个字段：requireUser: ReturnType<typeof makeRequireUser>;
const ctx: AppContext = { app, deps, requireApiKey, requireAdmin, requireUser };

// registerV1(ctx); 之前插入：
registerAuthRoutes(ctx, jwtSecret);
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd server && npx vitest run && npx tsc -p tsconfig.build.json --noEmit`
Expected: 全部 PASS、类型检查通过

- [ ] **Step 5: Commit**

```bash
git add server/src/core/jwt.ts server/src/env.ts server/src/server/auth.ts server/src/server/authRoutes.ts server/src/server/admin.ts server/src/app.ts server/tests/users-auth.test.ts
git commit -m "feat(server): email+password login with JWT, requireUser, me/password endpoints"
```

---

### Task 3: Admin 分组与用户管理 API

**Files:**
- Modify: `server/src/server/admin.ts`
- Test: `server/tests/groups-users-admin.test.ts`

**Interfaces:**
- Consumes: Task 1 repo 方法、Task 2 的 `ctx.requireAdmin`（普通用户 JWT 会被 403）。
- Produces HTTP API（Task 6/7 前端使用）:

```
GET    /admin/groups                          → GroupRow[]（含 channelIds）
POST   /admin/groups {name}                   → 201 GroupRow
PATCH  /admin/groups/:id {name}               → GroupRow
DELETE /admin/groups/:id                      → 204
PUT    /admin/groups/:id/channels {channelIds:number[]} → 200 GroupRow

GET    /admin/users                           → UserView[]（不含 passwordHash，含 quotaRemaining）
POST   /admin/users {email,password,quotaTotal,groupIds?} → 201 UserView
PATCH  /admin/users/:id {enabled?,quotaTotal?,groupIds?,password?} → UserView
DELETE /admin/users/:id                       → 204（禁止删自己、禁用/删除任何 admin）

// api_keys 支持绑定用户（列表含 userId/userEmail）：
POST   /admin/api-keys {name, userId?}        → 201 ApiKeyRow
GET    /admin/api-keys                        → (ApiKeyRow & {userEmail: string|null})[]
```

`UserView` 形状：`{ id, email, role, enabled, createdAt, quotaTotal, quotaUsed, quotaRemaining, groupIds }`（`quotaRemaining = quotaTotal === null ? null : max(0, total-used)`）。

- [ ] **Step 1: 写失败的测试**

创建 `server/tests/groups-users-admin.test.ts`：

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { Executor } from "../src/core/executor.js";
import { hashPassword } from "../src/core/password.js";
import { KeyPool } from "../src/core/keyPool.js";
import { ModelRouter } from "../src/core/router.js";
import { OpenAICompatProvider } from "../src/providers/openai-compat.js";
import { openDb } from "../src/store/db.js";
import { Repo } from "../src/store/repo.js";

let dir: string;
let repo: Repo;
let app: Awaited<ReturnType<typeof buildApp>>;
const H = { authorization: "Bearer admin-secret" };

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gua-"));
  repo = new Repo(openDb(dir));
  repo.createUser({ email: "admin@local", passwordHash: hashPassword("admin-pass"), role: "admin", quotaTotal: null });
  const provider = new OpenAICompatProvider();
  const router = new ModelRouter(repo);
  const keyPool = new KeyPool(repo);
  app = await buildApp({
    env: { port: 0, dataDir: dir, adminToken: "admin-secret", publicBaseUrl: null },
    repo, router, keyPool, provider,
    executor: new Executor({ router, keyPool, provider, repo }),
    logger: false, webDist: null,
  });
});
afterEach(async () => {
  await app.close();
  repo.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function makeUser(overrides: Record<string, unknown> = {}): Promise<number> {
  const res = await app.inject({
    method: "POST", url: "/admin/users", headers: H,
    payload: { email: "u1@x.com", password: "secret1", quotaTotal: 100, ...overrides },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id;
}

describe("/admin/groups", () => {
  it("CRUD + channel binding", async () => {
    const c = await app.inject({ method: "POST", url: "/admin/channels", headers: H, payload: { name: "c1", baseUrl: "http://x" } });
    const channelId = c.json().id;

    const created = await app.inject({ method: "POST", url: "/admin/groups", headers: H, payload: { name: "vip" } });
    expect(created.statusCode).toBe(201);
    const gid = created.json().id;

    const bind = await app.inject({ method: "PUT", url: `/admin/groups/${gid}/channels`, headers: H, payload: { channelIds: [channelId] } });
    expect(bind.statusCode).toBe(200);
    expect(bind.json().channelIds).toEqual([channelId]);

    const list = await app.inject({ url: "/admin/groups", headers: H });
    expect(list.json()).toHaveLength(1);
    expect(list.json()[0]).toMatchObject({ name: "vip", channelIds: [channelId] });

    const renamed = await app.inject({ method: "PATCH", url: `/admin/groups/${gid}`, headers: H, payload: { name: "svip" } });
    expect(renamed.json().name).toBe("svip");

    expect((await app.inject({ method: "DELETE", url: `/admin/groups/${gid}`, headers: H })).statusCode).toBe(204);
    expect((await app.inject({ method: "DELETE", url: `/admin/groups/${gid}`, headers: H })).statusCode).toBe(404);
  });
  it("validation errors", async () => {
    expect((await app.inject({ method: "POST", url: "/admin/groups", headers: H, payload: {} })).statusCode).toBe(400);
    const g = (await app.inject({ method: "POST", url: "/admin/groups", headers: H, payload: { name: "g" } })).json();
    expect((await app.inject({ method: "PUT", url: `/admin/groups/${g.id}/channels`, headers: H, payload: { channelIds: [999] } })).statusCode).toBe(400);
  });
});

describe("/admin/users", () => {
  it("create/list/patch/delete", async () => {
    const g = (await app.inject({ method: "POST", url: "/admin/groups", headers: H, payload: { name: "g" } })).json();
    const uid = await makeUser({ groupIds: [g.id] });

    const list = await app.inject({ url: "/admin/users", headers: H });
    const u = list.json().find((x: { id: number }) => x.id === uid);
    expect(u).toMatchObject({ email: "u1@x.com", role: "user", enabled: true, quotaTotal: 100, quotaUsed: 0, quotaRemaining: 100, groupIds: [g.id] });
    expect(u.passwordHash).toBeUndefined();

    const patched = await app.inject({ method: "PATCH", url: `/admin/users/${uid}`, headers: H, payload: { quotaTotal: 5, groupIds: [], enabled: false, password: "newpass1" } });
    expect(patched.json()).toMatchObject({ quotaTotal: 5, groupIds: [], enabled: false, quotaRemaining: 5 });

    expect((await app.inject({ method: "DELETE", url: `/admin/users/${uid}`, headers: H })).statusCode).toBe(204);
    expect((await app.inject({ method: "DELETE", url: `/admin/users/${uid}`, headers: H })).statusCode).toBe(404);
  });
  it("cannot delete/disable admins, cannot delete self, role immutable", async () => {
    const adminId = repo.getUserByEmail("admin@local")!.id;
    expect((await app.inject({ method: "DELETE", url: `/admin/users/${adminId}`, headers: H })).statusCode).toBe(400);
    expect((await app.inject({ method: "PATCH", url: `/admin/users/${adminId}`, headers: H, payload: { enabled: false } })).statusCode).toBe(400);
    // "self" = ADMIN_TOKEN 身份 uid 为 null，直接用 admin JWT 测
    const login = await app.inject({ method: "POST", url: "/admin/auth/login", payload: { email: "admin@local", password: "admin-pass" } });
    const jwth = { authorization: `Bearer ${login.json().token}` };
    expect((await app.inject({ method: "DELETE", url: `/admin/users/${adminId}`, headers: jwth })).statusCode).toBe(400);
    const u = await makeUser();
    expect((await app.inject({ method: "PATCH", url: `/admin/users/${u}`, headers: H, payload: { role: "admin" } })).statusCode).toBe(400);
  });
  it("validation: email/password/quota", async () => {
    expect((await app.inject({ method: "POST", url: "/admin/users", headers: H, payload: { email: "not-an-email", password: "secret1", quotaTotal: 1 } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/admin/users", headers: H, payload: { email: "a@x.com", password: "123", quotaTotal: 1 } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/admin/users", headers: H, payload: { email: "a@x.com", password: "secret1" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/admin/users", headers: H, payload: { email: "a@x.com", password: "secret1", quotaTotal: 0 } })).statusCode).toBe(400);
    const dup = await makeUser();
    expect((await app.inject({ method: "POST", url: "/admin/users", headers: H, payload: { email: "u1@x.com", password: "secret1", quotaTotal: 1 } })).statusCode).toBe(409);
    void dup;
  });
});

describe("api key user binding", () => {
  it("create with userId, list shows userEmail", async () => {
    const uid = await makeUser({ email: "bound@x.com" });
    const k = await app.inject({ method: "POST", url: "/admin/api-keys", headers: H, payload: { name: "k", userId: uid } });
    expect(k.statusCode).toBe(201);
    expect(k.json().userId).toBe(uid);
    const list = await app.inject({ url: "/admin/api-keys", headers: H });
    expect(list.json()[0]).toMatchObject({ userId: uid, userEmail: "bound@x.com" });
    expect((await app.inject({ method: "POST", url: "/admin/api-keys", headers: H, payload: { name: "k2", userId: 999 } })).statusCode).toBe(400);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd server && npx vitest run tests/groups-users-admin.test.ts`
Expected: FAIL（404）

- [ ] **Step 3: 实现**

在 `server/src/server/admin.ts` 的 `registerAdmin` 内、「// ---- logs ----」段之前追加（`validateChannelInput` 等辅助函数已有；需新增两个小助手放在文件顶部辅助函数区）：

```ts
function optionalInt(b: Record<string, unknown>, field: string): number | undefined {
  const v = b[field];
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v)) throw httpError(400, `'${field}' must be an integer`);
  return v;
}

function intArray(b: Record<string, unknown>, field: string): number[] | undefined {
  const v = b[field];
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || !v.every((x) => typeof x === "number" && Number.isInteger(x))) {
    throw httpError(400, `'${field}' must be an array of integers`);
  }
  return v as number[];
}

function toUserView(u: ReturnType<Repo["getUser"]> & object) {
  return {
    id: u.id,
    email: u.email,
    role: u.role,
    enabled: u.enabled,
    createdAt: u.createdAt,
    quotaTotal: u.quotaTotal,
    quotaUsed: u.quotaUsed,
    quotaRemaining: u.quotaTotal === null ? null : Math.max(0, u.quotaTotal - u.quotaUsed),
    groupIds: u.groupIds,
  };
}
```

（`Repo` 需要导入类型：文件顶部加 `import type { Repo } from "../store/repo.js";`，若已有则跳过。）

```ts
  // ---- channel groups ----

  ctx.app.get("/admin/groups", { preHandler: ctx.requireAdmin }, async () => repo.listGroups());

  ctx.app.post("/admin/groups", { preHandler: ctx.requireAdmin }, async (req, reply) => {
    const name = requireStr(requireBody(req), "name").trim();
    try {
      return await reply.code(201).send(repo.createGroup(name));
    } catch (err) {
      if (err instanceof ConflictError) throw httpError(409, err.message);
      throw err;
    }
  });

  ctx.app.patch("/admin/groups/:id", { preHandler: ctx.requireAdmin }, async (req) => {
    const id = Number((req.params as { id: string }).id);
    const name = requireStr(requireBody(req), "name").trim();
    try {
      const group = repo.updateGroup(id, name);
      if (!group) throw httpError(404, "group not found");
      return group;
    } catch (err) {
      if (err instanceof ConflictError) throw httpError(409, err.message);
      throw err;
    }
  });

  ctx.app.delete("/admin/groups/:id", { preHandler: ctx.requireAdmin }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!repo.deleteGroup(id)) throw httpError(404, "group not found");
    return await reply.code(204).send();
  });

  ctx.app.put("/admin/groups/:id/channels", { preHandler: ctx.requireAdmin }, async (req) => {
    const id = Number((req.params as { id: string }).id);
    const channelIds = intArray(requireBody(req), "channelIds") ?? [];
    for (const cid of channelIds) {
      if (!repo.getChannel(cid)) throw httpError(400, `channel ${cid} not found`);
    }
    if (!repo.updateGroup(id, repo.listGroups().find((g) => g.id === id)?.name ?? "")) throw httpError(404, "group not found");
    repo.setGroupChannels(id, channelIds);
    return repo.listGroups().find((g) => g.id === id)!;
  });

  // ---- users ----

  ctx.app.get("/admin/users", { preHandler: ctx.requireAdmin }, async () => repo.listUsers().map(toUserView));

  ctx.app.post("/admin/users", { preHandler: ctx.requireAdmin }, async (req, reply) => {
    const b = requireBody(req);
    const email = requireStr(b, "email").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw httpError(400, "'email' must be a valid email address");
    const password = requireStr(b, "password");
    if (password.length < 6) throw httpError(400, "'password' must be at least 6 characters");
    if (typeof b.quotaTotal !== "number" || !Number.isInteger(b.quotaTotal) || b.quotaTotal <= 0) {
      throw httpError(400, "'quotaTotal' must be a positive integer");
    }
    const groupIds = intArray(b, "groupIds") ?? [];
    for (const gid of groupIds) {
      if (!repo.listGroups().some((g) => g.id === gid)) throw httpError(400, `group ${gid} not found`);
    }
    let user;
    try {
      user = repo.createUser({ email, passwordHash: hashPassword(password), role: "user", quotaTotal: b.quotaTotal });
    } catch (err) {
      if (err instanceof ConflictError) throw httpError(409, err.message);
      throw err;
    }
    repo.setUserGroups(user.id, groupIds);
    return await reply.code(201).send(toUserView(repo.getUser(user.id)!));
  });

  ctx.app.patch("/admin/users/:id", { preHandler: ctx.requireAdmin }, async (req) => {
    const id = Number((req.params as { id: string }).id);
    const b = requireBody(req);
    const existing = repo.getUser(id);
    if (!existing) throw httpError(404, "user not found");
    if ("role" in b) throw httpError(400, "role cannot be changed");
    const patch: { enabled?: boolean; quotaTotal?: number | null; passwordHash?: string } = {};
    if (b.enabled !== undefined) {
      if (typeof b.enabled !== "boolean") throw httpError(400, "'enabled' must be a boolean");
      if (existing.role === "admin" && b.enabled === false) throw httpError(400, "cannot disable an admin");
      patch.enabled = b.enabled;
    }
    if (b.quotaTotal !== undefined) {
      if (b.quotaTotal === null) {
        if (existing.role !== "admin") throw httpError(400, "'quotaTotal' null is only allowed for admins");
        patch.quotaTotal = null;
      } else if (typeof b.quotaTotal === "number" && Number.isInteger(b.quotaTotal) && b.quotaTotal > 0) {
        patch.quotaTotal = b.quotaTotal;
      } else {
        throw httpError(400, "'quotaTotal' must be a positive integer or null (admin only)");
      }
    }
    if (b.password !== undefined) {
      if (typeof b.password !== "string" || b.password.length < 6) throw httpError(400, "'password' must be at least 6 characters");
      patch.passwordHash = hashPassword(b.password);
    }
    const updated = repo.updateUser(id, patch);
    if (!updated) throw httpError(404, "user not found");
    if (b.groupIds !== undefined) {
      const groupIds = intArray(b, "groupIds")!;
      for (const gid of groupIds) {
        if (!repo.listGroups().some((g) => g.id === gid)) throw httpError(400, `group ${gid} not found`);
      }
      repo.setUserGroups(id, groupIds);
    }
    return toUserView(repo.getUser(id)!);
  });

  ctx.app.delete("/admin/users/:id", { preHandler: ctx.requireAdmin }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const existing = repo.getUser(id);
    if (!existing) throw httpError(404, "user not found");
    if (existing.role === "admin") throw httpError(400, "cannot delete an admin");
    if (req.callerUserId === id) throw httpError(400, "cannot delete yourself");
    repo.deleteUser(id);
    return await reply.code(204).send();
  });
```

同时修改 `// ---- api keys ----` 段的 POST，支持可选 `userId`；GET 列表附带 `userEmail`：

```ts
  ctx.app.get("/admin/api-keys", { preHandler: ctx.requireAdmin }, async () =>
    repo.listApiKeys().map((k) => ({
      ...k,
      userEmail: k.userId === null ? null : (repo.getUser(k.userId)?.email ?? null),
    })),
  );

  ctx.app.post("/admin/api-keys", { preHandler: ctx.requireAdmin }, async (req, reply) => {
    const b = requireBody(req);
    const name = requireStr(b, "name");
    let userId: number | null = null;
    if (b.userId !== undefined && b.userId !== null) {
      if (typeof b.userId !== "number" || !Number.isInteger(b.userId)) throw httpError(400, "'userId' must be an integer");
      if (!repo.getUser(b.userId)) throw httpError(400, `user ${b.userId} not found`);
      userId = b.userId;
    }
    return await reply.code(201).send(repo.createApiKey(name.trim(), userId));
  });
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd server && npx vitest run && npx tsc -p tsconfig.build.json --noEmit`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/server/admin.ts server/tests/groups-users-admin.test.ts
git commit -m "feat(server): admin groups/users APIs, api-key user binding"
```

---

### Task 4: 渠道过滤路由 + 额度校验/扣减

**Files:**
- Modify: `server/src/core/router.ts`
- Modify: `server/src/core/executor.ts`
- Create: `server/src/core/errors.ts` 内追加 `QuotaError`（Modify）
- Modify: `server/src/server/v1.ts`（/v1/models 过滤）
- Modify: `server/src/server/generations.ts` / `edits.ts` / `stream.ts` / `jobs.ts` 中所有 `executor.generate|executor.edit` 调用点（传 `callerUserId`、`allowedChannelIds`）
- Test: `server/tests/quota-groups.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `repo.allowedChannelIds/chargeQuota/getUser`，Task 2 的 `req.callerUserId`。
- Produces:

```ts
// router.ts
resolve(publicName: string, allowedChannelIds?: number[] | null): ResolvedRoute | null
// allowedChannelIds 非 null 且不含 model.channelId → 返回 null（表现为模型不存在）

// executor.ts（ExecutorOptions 新增可选字段）
callerUserId?: number | null;
allowedChannelIds?: number | null[] | null;   // 修正：number[] | null

// errors.ts
export class QuotaError extends Error { constructor() /* message: "quota exceeded" */ }
// toOpenAIError 追加分支：QuotaError → { status: 402, body: { error: { message, type: "insufficient_quota", code: "quota_exceeded" } } }
```

额度规则（全部在 `Executor.call` 内实现）：`callerUserId` 为空 → 不校验不扣减；用户 role=admin 或 quotaTotal=null → 不校验不扣减；否则请求前校验剩余 >= 预计张数（`req.n ?? 1`），不足抛 `QuotaError`；provider 成功后按 `result.images.length` 条件扣减，条件更新失败（并发超支）仅 `console.warn` 记录，不抛错。

- [ ] **Step 1: 写失败的测试**

创建 `server/tests/quota-groups.test.ts`：

```ts
import Fastify from "fastify";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { Executor } from "../src/core/executor.js";
import { hashPassword } from "../src/core/password.js";
import { KeyPool } from "../src/core/keyPool.js";
import { ModelRouter } from "../src/core/router.js";
import { OpenAICompatProvider } from "../src/providers/openai-compat.js";
import { openDb } from "../src/store/db.js";
import { Repo } from "../src/store/repo.js";

let upstream: ReturnType<typeof Fastify>;
let dir: string;
let repo: Repo;
let app: Awaited<ReturnType<typeof buildApp>>;
const H = { authorization: "Bearer admin-secret" };
let upstreamUrl = "";

beforeEach(async () => {
  upstream = Fastify();
  upstream.post("/v1/images/generations", async () => ({
    created: 1,
    data: [{ b64_json: Buffer.from("fake-image").toString("base64") }],
  }));
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "qg-"));
  repo = new Repo(openDb(dir));
  repo.createUser({ email: "admin@local", passwordHash: hashPassword("admin-pass"), role: "admin", quotaTotal: null });
  await upstream.listen({ port: 0, host: "127.0.0.1" });
  upstreamUrl = `http://127.0.0.1:${(upstream.server.address() as { port: number }).port}/v1`;
  const provider = new OpenAICompatProvider();
  const router = new ModelRouter(repo);
  const keyPool = new KeyPool(repo);
  app = await buildApp({
    env: { port: 0, dataDir: dir, adminToken: "admin-secret", publicBaseUrl: null },
    repo, router, keyPool, provider,
    executor: new Executor({ router, keyPool, provider, repo }),
    logger: false, webDist: null,
  });
});
afterEach(async () => {
  await app.close();
  await upstream.close();
  repo.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

interface Setup { apiKey: string; channelId: number; userId: number }
async function setupUser(opts: { quotaTotal: number | null; groupName: string | null }): Promise<Setup> {
  const c = await app.inject({ method: "POST", url: "/admin/channels", headers: H, payload: { name: `c-${Math.random()}`, baseUrl: upstreamUrl } });
  const channelId = c.json().id;
  await app.inject({ method: "POST", url: `/admin/channels/${channelId}/keys`, headers: H, payload: { apiKey: "sk-up" } });
  await app.inject({ method: "POST", url: "/admin/models", headers: H, payload: { publicName: "mdl", channelId } });
  const u = await app.inject({
    method: "POST", url: "/admin/users", headers: H,
    payload: { email: `u${Math.random()}@x.com`, password: "secret1", quotaTotal: opts.quotaTotal ?? 2 },
  });
  const userId = u.json().id;
  if (opts.groupName) {
    const g = await app.inject({ method: "POST", url: "/admin/groups", headers: H, payload: { name: opts.groupName } });
    await app.inject({ method: "PUT", url: `/admin/groups/${g.json().id}/channels`, headers: H, payload: { channelIds: [channelId] } });
    await app.inject({ method: "PATCH", url: `/admin/users/${userId}`, headers: H, payload: { groupIds: [g.json().id] } });
  }
  const k = await app.inject({ method: "POST", url: "/admin/api-keys", headers: H, payload: { name: "k", userId } });
  return { apiKey: k.json().key, channelId, userId };
}

describe("quota", () => {
  it("402 when remaining < n, no upstream call", async () => {
    const s = await setupUser({ quotaTotal: 2, groupName: null });
    const auth = { authorization: `Bearer ${s.apiKey}` };
    const r1 = await app.inject({ method: "POST", url: "/v1/images/generations", headers: auth, payload: { model: "mdl", prompt: "p", n: 2 } });
    expect(r1.statusCode).toBe(200);
    expect(repo.getUser(s.userId)?.quotaUsed).toBe(2);
    const r2 = await app.inject({ method: "POST", url: "/v1/images/generations", headers: auth, payload: { model: "mdl", prompt: "p" } });
    expect(r2.statusCode).toBe(402);
    expect(r2.json().error.type).toBe("insufficient_quota");
  });
  it("charges per image count, disabled user key rejected", async () => {
    const s = await setupUser({ quotaTotal: 5, groupName: null });
    const auth = { authorization: `Bearer ${s.apiKey}` };
    const r = await app.inject({ method: "POST", url: "/v1/images/generations", headers: auth, payload: { model: "mdl", prompt: "p" } });
    expect(r.statusCode).toBe(200);
    expect(repo.getUser(s.userId)?.quotaUsed).toBe(1);
    repo.updateUser(s.userId, { enabled: false });
    const r2 = await app.inject({ method: "POST", url: "/v1/images/generations", headers: auth, payload: { model: "mdl", prompt: "p" } });
    expect(r2.statusCode).toBe(401);
  });
  it("unbound key and admin token bypass quota", async () => {
    const k = await app.inject({ method: "POST", url: "/admin/api-keys", headers: H, payload: { name: "free" } });
    const r = await app.inject({ method: "POST", url: "/v1/images/generations", headers: { authorization: `Bearer ${k.json().key}` }, payload: { model: "mdl", prompt: "p" } });
    expect(r.statusCode).toBe(200);
    const r2 = await app.inject({ method: "POST", url: "/v1/images/generations", headers: H, payload: { model: "mdl", prompt: "p" } });
    expect(r2.statusCode).toBe(200);
  });
});

describe("channel group filtering", () => {
  it("/v1/models and generations restricted to user's groups", async () => {
    // 渠道A在组内、渠道B不在
    const cA = await app.inject({ method: "POST", url: "/admin/channels", headers: H, payload: { name: "A", baseUrl: upstreamUrl } });
    const cB = await app.inject({ method: "POST", url: "/admin/channels", headers: H, payload: { name: "B", baseUrl: upstreamUrl } });
    await app.inject({ method: "POST", url: "/admin/models", headers: H, payload: { publicName: "in-group", channelId: cA.json().id } });
    // "out-group" 指向渠道B：先建后停用启用绕开唯一索引不必要，直接建即可
    await app.inject({ method: "POST", url: "/admin/models", headers: H, payload: { publicName: "out-group", channelId: cB.json().id } });
    const u = await app.inject({ method: "POST", url: "/admin/users", headers: H, payload: { email: "g@x.com", password: "secret1", quotaTotal: 10 } });
    const g = await app.inject({ method: "POST", url: "/admin/groups", headers: H, payload: { name: "onlyA" } });
    await app.inject({ method: "PUT", url: `/admin/groups/${g.json().id}/channels`, headers: H, payload: { channelIds: [cA.json().id] } });
    await app.inject({ method: "PATCH", url: `/admin/users/${u.json().id}`, headers: H, payload: { groupIds: [g.json().id] } });
    const k = await app.inject({ method: "POST", url: "/admin/api-keys", headers: H, payload: { name: "k", userId: u.json().id } });
    const auth = { authorization: `Bearer ${k.json().key}` };

    const models = await app.inject({ url: "/v1/models", headers: auth });
    const ids = models.json().data.map((m: { id: string }) => m.id);
    expect(ids).toContain("in-group");
    expect(ids).not.toContain("out-group");

    const ok = await app.inject({ method: "POST", url: "/v1/images/generations", headers: auth, payload: { model: "in-group", prompt: "p" } });
    expect(ok.statusCode).toBe(200);
    const blocked = await app.inject({ method: "POST", url: "/v1/images/generations", headers: auth, payload: { model: "out-group", prompt: "p" } });
    expect(blocked.statusCode).toBe(404);

    // admin token 不受限
    const adminModels = await app.inject({ url: "/v1/models", headers: H });
    expect(adminModels.json().data).toHaveLength(2);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd server && npx vitest run tests/quota-groups.test.ts`
Expected: FAIL（402 用例得到 200；过滤用例 out-group 仍 200）

- [ ] **Step 3: 实现**

`server/src/core/errors.ts`：追加 QuotaError 类，并在 `toOpenAIError` 的 `ModelNotFoundError` 分支之后追加：

```ts
export class QuotaError extends Error {
  constructor() {
    super("quota exceeded");
    this.name = "QuotaError";
  }
}

// toOpenAIError 内追加：
  if (err instanceof QuotaError) {
    return { status: 402, body: { error: { message: err.message, type: "insufficient_quota", code: "quota_exceeded" } } };
  }
```

`server/src/core/router.ts` 整体替换为：

```ts
import type { ChannelRow, ModelRow, Repo } from "../store/repo.js";

export interface ResolvedRoute {
  model: ModelRow;
  channel: ChannelRow;
}

export class ModelRouter {
  constructor(private readonly repo: Repo) {}

  resolve(publicName: string, allowedChannelIds?: number[] | null): ResolvedRoute | null {
    const model = this.repo.findEnabledModel(publicName);
    if (!model) return null;
    if (allowedChannelIds && allowedChannelIds.length > 0 && !allowedChannelIds.includes(model.channelId)) return null;
    const channel = this.repo.getChannel(model.channelId);
    if (!channel || !channel.enabled) return null;
    return { model, channel };
  }
}
```

`server/src/core/executor.ts` 修改：

```ts
// import 追加
import { ModelNotFoundError, QuotaError, UpstreamError } from "./errors.js";

// ExecutorOptions 追加字段
export interface ExecutorOptions {
  callerApiKeyId: number | null;
  callerUserId?: number | null;
  allowedChannelIds?: number[] | null;
  signal?: AbortSignal;
}

// call() 内，route resolve 一行替换为：
    const route = this.deps.router.resolve(publicName, opts.allowedChannelIds ?? null);
    if (!route) throw new ModelNotFoundError(publicName);

// route resolve 之后、start 之前插入额度校验：
    const user = opts.callerUserId ? this.deps.repo.getUser(opts.callerUserId) : null;
    const quotaLimited = !!user && user.role !== "admin" && user.quotaTotal !== null;
    if (quotaLimited) {
      const wanted = "n" in payload.req && typeof payload.req.n === "number" ? payload.req.n : 1;
      if (user!.quotaTotal! - user!.quotaUsed < wanted) throw new QuotaError();
    }

// provider 成功分支（markSuccess 之后、return 之前）插入扣减：
        if (quotaLimited) {
          const charged = this.deps.repo.chargeQuota(user!.id, result.images.length);
          if (!charged) console.warn(`[quota] concurrent over-spend for user ${user!.id}; charged=${result.images.length}`);
        }
```

`server/src/server/v1.ts` 的 `/v1/models` 处理器替换为：

```ts
  ctx.app.get("/v1/models", { preHandler: ctx.requireApiKey }, async (req) => {
    const allowed = ctx.deps.repo.allowedChannelIds(req.callerUserId ?? null);
    const models = ctx.deps.repo.listEnabledModels().filter((m) => !allowed || allowed.includes(m.channelId));
    return {
      object: "list",
      data: models.map((m) => ({ id: m.publicName, object: "model", owned_by: "tiny-images" })),
    };
  });
```

所有 executor 调用点传用户上下文。先执行 `cd server && grep -rn "executor.generate\|executor.edit\|deps.executor" src/` 找齐调用点（已知 `server/generations.ts` 的 `finishSync`、`server/stream.ts` 的 `streamImageFlow`，可能还有 `server/jobs.ts`）。每个调用点的 opts 对象统一改为：

```ts
{
  callerApiKeyId: req.callerApiKeyId ?? null,
  callerUserId: req.callerUserId ?? null,
  allowedChannelIds: ctx.deps.repo.allowedChannelIds(req.callerUserId ?? null),
  signal: requestSignal(req, reply),
}
```

对于不持有 `req` 的调用点（如 jobs.ts 后台执行），用与该处现有 `callerApiKeyId` 相同的来源变量传入 `callerUserId` / `allowedChannelIds`（创建 job 时把这两个值随任务参数快照下来）。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd server && npx vitest run && npx tsc -p tsconfig.build.json --noEmit`
Expected: 全部 PASS（含既有 v1-generations/v1-edits/v1-stream/jobs 测试——无主 key 行为不变）

- [ ] **Step 5: Commit**

```bash
git add server/src/core/router.ts server/src/core/executor.ts server/src/core/errors.ts server/src/server/v1.ts server/src/server/generations.ts server/src/server/stream.ts server/src/server/edits.ts server/src/server/jobs.ts server/tests/quota-groups.test.ts
git commit -m "feat(server): channel-group route filtering and per-image quota (402)"
```

---

### Task 5: 初始 admin 种子

**Files:**
- Modify: `server/src/store/seed.ts`（追加 `seedAdminIfEmpty`）
- Modify: `server/src/index.ts`（调用并打印）
- Test: `server/tests/seed-admin.test.ts`

**Interfaces:**
- Produces:

```ts
export function seedAdminIfEmpty(
  repo: Repo,
  env: { adminEmail?: string | null; adminPassword?: string | null },
): { created: boolean; email: string; password: string | null }
// users 表非空 → { created:false, email:"", password:null }
// ADMIN_EMAIL/ADMIN_PASSWORD 都设置 → 用其创建 admin，password 返回 null（不打印）
// 否则 → email "admin@local"，随机 12 位 base64url 密码，调用方负责打印到日志
```

- [ ] **Step 1: 写失败的测试**

创建 `server/tests/seed-admin.test.ts`：

```ts
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd server && npx vitest run tests/seed-admin.test.ts`
Expected: FAIL（seedAdminIfEmpty 不存在）

- [ ] **Step 3: 实现**

`server/src/store/seed.ts` 末尾追加（文件顶部补 `import { randomBytes } from "node:crypto";` 与 `import { hashPassword } from "../core/password.js";`）：

```ts
export function seedAdminIfEmpty(
  repo: Repo,
  env: { adminEmail?: string | null; adminPassword?: string | null },
): { created: boolean; email: string; password: string | null } {
  if (repo.listUsers().length > 0) return { created: false, email: "", password: null };
  const email = (env.adminEmail ?? "admin@local").toLowerCase();
  const password = env.adminPassword ?? randomBytes(9).toString("base64url"); // 12 字符
  repo.createUser({ email, passwordHash: hashPassword(password), role: "admin", quotaTotal: null });
  return { created: true, email, password: env.adminPassword ? null : password };
}
```

`server/src/index.ts`：在 `seedIfEmpty(env.dataDir, repo);` 之后插入：

```ts
const seeded = seedAdminIfEmpty(repo, env);
if (seeded.created) {
  if (seeded.password) {
    console.info(`created initial admin ${seeded.email} with password: ${seeded.password} (change it after first login)`);
  } else {
    console.info(`created initial admin ${seeded.email}`);
  }
}
```

并在顶部 import 区把 `import { seedIfEmpty } from "./store/seed.js";` 改为 `import { seedIfEmpty, seedAdminIfEmpty } from "./store/seed.js";`。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd server && npx vitest run && npx tsc -p tsconfig.build.json --noEmit`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/store/seed.ts server/src/index.ts server/tests/seed-admin.test.ts
git commit -m "feat(server): seed initial admin account on first start"
```

---

### Task 6: 前端 — api.ts / Login / App（角色守卫 + 额度展示 + 改密码）

**Files:**
- Modify: `web/src/api.ts`
- Modify: `web/src/pages/Login.tsx`（整体替换）
- Modify: `web/src/App.tsx`

**Interfaces:**
- Consumes: Task 2/3 的 HTTP API。
- Produces（Task 7 依赖）:

```ts
// api.ts 新增
export const ROLE_KEY = "tiny-role";
export function getRole(): "admin" | "user" | null;
export function setRole(role: "admin" | "user" | null): void;
export function loginRequest(email: string, password: string): Promise<{ token: string; role: "admin" | "user"; email: string }>;
export interface Me { role: "admin" | "user"; email: string; quotaTotal: number | null; quotaUsed: number; quotaRemaining: number | null }
export function fetchMe(): Promise<Me>;
export interface ChannelGroup { id: number; name: string; createdAt: number; channelIds: number[] }
export interface UserView { id: number; email: string; role: "admin" | "user"; enabled: boolean; createdAt: number; quotaTotal: number | null; quotaUsed: number; quotaRemaining: number | null; groupIds: number[] }
// ApiKey 接口追加: userId: number | null; userEmail?: string | null
```

- [ ] **Step 1: api.ts 追加类型与函数**

在 `web/src/api.ts` 的 `TOKEN_KEY` 区之后追加：

```ts
export const ROLE_KEY = "tiny-role";

export function getRole(): "admin" | "user" | null {
  const v = localStorage.getItem(ROLE_KEY);
  return v === "admin" || v === "user" ? v : null;
}

export function setRole(role: "admin" | "user" | null): void {
  if (role) localStorage.setItem(ROLE_KEY, role);
  else localStorage.removeItem(ROLE_KEY);
}

export async function loginRequest(email: string, password: string): Promise<{ token: string; role: "admin" | "user"; email: string }> {
  const res = await fetch("/admin/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const parsed = (await res.json().catch(() => ({}))) as { token?: string; role?: "admin" | "user"; email?: string; error?: { message?: string } };
  if (!res.ok || !parsed.token) throw new ApiError(res.status, parsed as { error?: { message?: string } });
  return { token: parsed.token, role: parsed.role!, email: parsed.email! };
}

export interface Me {
  role: "admin" | "user";
  email: string;
  quotaTotal: number | null;
  quotaUsed: number;
  quotaRemaining: number | null;
}

export function fetchMe(): Promise<Me> {
  return api<Me>("/admin/auth/me");
}

export interface ChannelGroup {
  id: number;
  name: string;
  createdAt: number;
  channelIds: number[];
}

export interface UserView {
  id: number;
  email: string;
  role: "admin" | "user";
  enabled: boolean;
  createdAt: number;
  quotaTotal: number | null;
  quotaUsed: number;
  quotaRemaining: number | null;
  groupIds: number[];
}
```

`ApiKey` 接口追加两个字段：`userId: number | null;` 与 `userEmail?: string | null;`。`clearToken` 无需改动；`App.tsx` 的 logout 需同时清 role（本 Task Step 3 处理）。

- [ ] **Step 2: Login.tsx 整体替换为邮箱+密码**

```tsx
import { FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError, clearToken, loginRequest, setRole, setToken } from "../api";

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const r = await loginRequest(email.trim(), password);
      clearToken();
      setToken(r.token);
      setRole(r.role);
      navigate("/");
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 401
          ? "邮箱或密码不正确"
          : err instanceof ApiError
            ? err.message
            : "连接服务失败，请确认服务可用后重试",
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="login-wrap">
      <form className="card login-card" onSubmit={submit}>
        <div className="login-hero">
          <h1 className="rainbow">tiny-images 95</h1>
          <p className="muted">使用邮箱和密码登录</p>
        </div>
        <label htmlFor="login-email">邮箱</label>
        <input
          id="login-email"
          type="email"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoFocus
        />
        <label htmlFor="login-password">密码</label>
        <input
          id="login-password"
          type="password"
          placeholder="密码"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        <button className="btn primary" type="submit" disabled={!email.trim() || !password || submitting}>
          {submitting ? "登录中…" : "登录"}
        </button>
      </form>
    </div>
  );
}
```

- [ ] **Step 3: App.tsx — 角色守卫、导航项、额度显示、改密码**

修改点（其余保持不变）：

1. import 区追加：`import { clearToken, fetchMe, getRole, setRole, getToken, type Me } from "./api";`（替换原 `import { getToken } from "./api";`）。
2. `RequireToken` 之后新增守卫组件：

```tsx
function RequireAdmin({ children }: { children: React.ReactElement }) {
  if (!getToken()) return <Navigate to="/login" replace />;
  if (getRole() !== "admin") return <Navigate to="/" replace />;
  return children;
}
```

3. `App` 组件内追加状态与效果（`const navigate = ...` 之后）：

```tsx
  const [me, setMe] = useState<Me | null>(null);
  useEffect(() => {
    if (!getToken()) return;
    fetchMe()
      .then(setMe)
      .catch(() => setMe(null));
  }, [location.pathname]);
```

（需在 import 里加 `useState`：`import { Component, ReactNode, useEffect, useState } from "react";`）

4. `logout` 改为：

```tsx
  const logout = () => {
    clearToken();
    setRole(null);
    navigate("/login");
  };
```

5. 改密码处理函数（`logout` 之后）：

```tsx
  const changePassword = async () => {
    const oldPassword = window.prompt("输入当前密码");
    if (!oldPassword) return;
    const newPassword = window.prompt("输入新密码（至少 6 位）");
    if (!newPassword) return;
    try {
      await api("/admin/auth/password", { method: "PUT", body: { oldPassword, newPassword } });
      window.alert("密码已修改");
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "修改失败");
    }
  };
```

（顶部 import 追加 `api`。）

6. menubar 的 `<nav>` 内，「管理后台」NavLink 包裹条件渲染：

```tsx
          {getRole() === "admin" && (
            <NavLink to="/admin" className={({ isActive }) => `nav-btn ${isActive ? "active" : ""}`}>
              管理后台
            </NavLink>
          )}
```

7. 登出按钮之前插入额度显示与改密码入口：

```tsx
        {getToken() && me && (
          <span className="muted">
            {me.email}
            {me.quotaRemaining !== null ? ` · 剩余额度 ${me.quotaRemaining}/${me.quotaTotal}` : ""}
          </span>
        )}
        {getToken() && (
          <button className="btn small" onClick={changePassword}>
            改密码
          </button>
        )}
```

8. `/admin` 路由的守卫由 `RequireToken` 换成 `RequireAdmin`：

```tsx
            <Route
              path="/admin"
              element={
                <RequireAdmin>
                  <Admin />
                </RequireAdmin>
              }
            />
```

- [ ] **Step 4: 构建验证**

Run: `cd web && npm run build && cd ../server && npx tsc -p tsconfig.build.json --noEmit`
Expected: web 构建成功、无类型错误

- [ ] **Step 5: Commit**

```bash
git add web/src/api.ts web/src/pages/Login.tsx web/src/App.tsx
git commit -m "feat(web): email/password login, role guard, quota display, change password"
```

---

### Task 7: 前端 — Admin 分组 Tab、用户 Tab、Key 绑定用户

**Files:**
- Create: `web/src/pages/admin/GroupsTab.tsx`
- Create: `web/src/pages/admin/UsersTab.tsx`
- Modify: `web/src/pages/Admin.tsx`（TABS 扩展、导入、渲染）
- Modify: `web/src/pages/Admin.tsx` 内 `ApiKeysTab`（创建时可选关联用户）

**Interfaces:**
- Consumes: Task 6 的 `ChannelGroup`/`UserView` 类型与 `api()`。

- [ ] **Step 1: 创建 GroupsTab.tsx**

`web/src/pages/admin/GroupsTab.tsx`（新建目录 `web/src/pages/admin/`）：

```tsx
import { FormEvent, useEffect, useState } from "react";
import { api, type Channel, type ChannelGroup } from "../../api";

export default function GroupsTab() {
  const [groups, setGroups] = useState<ChannelGroup[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [editing, setEditing] = useState<Partial<ChannelGroup> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = (): void => {
    api<ChannelGroup[]>("/admin/groups").then(setGroups).catch((e) => setError(e.message));
    api<Channel[]>("/admin/channels").then(setChannels).catch(() => undefined);
  };
  useEffect(load, []);

  const save = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!editing) return;
    setError(null);
    try {
      if (editing.id) await api(`/admin/groups/${editing.id}`, { method: "PATCH", body: { name: editing.name } });
      else await api("/admin/groups", { method: "POST", body: { name: editing.name } });
      setEditing(null);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const saveMembers = async (group: ChannelGroup, channelIds: number[]): Promise<void> => {
    try {
      await api(`/admin/groups/${group.id}/channels`, { method: "PUT", body: { channelIds } });
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const toggleMember = (group: ChannelGroup, channelId: number): void => {
    const has = group.channelIds.includes(channelId);
    saveMembers(group, has ? group.channelIds.filter((c) => c !== channelId) : [...group.channelIds, channelId]);
  };

  const remove = async (id: number): Promise<void> => {
    if (!confirm("删除该分组？组内渠道本身不受影响，属于该分组的用户将失去这些渠道的访问权。")) return;
    await api(`/admin/groups/${id}`, { method: "DELETE" });
    load();
  };

  return (
    <div className="card">
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      <p className="muted">分组用于限制普通用户可用的渠道：一个渠道可属于多个分组；用户未配置分组时可使用全部渠道。</p>
      <button className="btn primary" onClick={() => setEditing({})}>
        新建分组
      </button>
      {editing && (
        <form className="inline-form" onSubmit={save}>
          <h3>{editing.id ? "编辑分组" : "新建分组"}</h3>
          <label htmlFor="g-name">分组名称</label>
          <input id="g-name" value={editing.name ?? ""} onChange={(e) => setEditing({ ...editing, name: e.target.value })} required />
          <div className="row">
            <button className="btn primary" type="submit">
              保存
            </button>
            <button className="btn ghost" type="button" onClick={() => setEditing(null)}>
              取消
            </button>
          </div>
        </form>
      )}
      {groups.length === 0 && <p className="muted">还没有分组。</p>}
      {groups.map((g) => (
        <div key={g.id} className="entity">
          <div className="entity-head">
            <strong>{g.name}</strong>
            <span className="muted">
              {g.channelIds.length} 个渠道 / 共 {channels.length} 个
            </span>
            <span className="spacer" />
            <button className="btn small" onClick={() => setEditing(g)}>
              改名
            </button>
            <button className="btn small danger" onClick={() => remove(g.id)}>
              删除
            </button>
          </div>
          <div className="keys">
            {channels.map((c) => (
              <span key={c.id} className={`pill ${g.channelIds.includes(c.id) ? "" : "off"}`}>
                <button className="link" onClick={() => toggleMember(g, c.id)}>
                  {g.channelIds.includes(c.id) ? "✓ " : "+ "}
                  {c.name}
                </button>
              </span>
            ))}
            {channels.length === 0 && <span className="muted">先在「渠道」页添加渠道。</span>}
          </div>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: 创建 UsersTab.tsx**

`web/src/pages/admin/UsersTab.tsx`：

```tsx
import { FormEvent, useEffect, useState } from "react";
import { api, type ChannelGroup, type UserView } from "../../api";

const fmtTime = (ts: number): string => new Date(ts).toLocaleString();

export default function UsersTab() {
  const [users, setUsers] = useState<UserView[]>([]);
  const [groups, setGroups] = useState<ChannelGroup[]>([]);
  const [editing, setEditing] = useState<Partial<UserView> & { password?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = (): void => {
    api<UserView[]>("/admin/users").then(setUsers).catch((e) => setError(e.message));
    api<ChannelGroup[]>("/admin/groups").then(setGroups).catch(() => undefined);
  };
  useEffect(load, []);

  const toggleGroup = (gid: number): void => {
    if (!editing) return;
    const ids = editing.groupIds ?? [];
    setEditing({ ...editing, groupIds: ids.includes(gid) ? ids.filter((x) => x !== gid) : [...ids, gid] });
  };

  const save = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!editing) return;
    setError(null);
    try {
      if (editing.id) {
        const body: Record<string, unknown> = { groupIds: editing.groupIds ?? [], enabled: editing.enabled };
        if (editing.quotaTotal !== undefined && editing.quotaTotal !== null) body.quotaTotal = editing.quotaTotal;
        if (editing.password) body.password = editing.password;
        await api(`/admin/users/${editing.id}`, { method: "PATCH", body });
      } else {
        await api("/admin/users", {
          method: "POST",
          body: { email: editing.email, password: editing.password, quotaTotal: editing.quotaTotal, groupIds: editing.groupIds ?? [] },
        });
      }
      setEditing(null);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const resetPassword = async (u: UserView): Promise<void> => {
    const pwd = window.prompt(`为 ${u.email} 设置新密码（至少 6 位）`);
    if (!pwd) return;
    try {
      await api(`/admin/users/${u.id}`, { method: "PATCH", body: { password: pwd } });
      window.alert("密码已重置");
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "重置失败");
    }
  };

  const toggleEnabled = async (u: UserView): Promise<void> => {
    await api(`/admin/users/${u.id}`, { method: "PATCH", body: { enabled: !u.enabled } });
    load();
  };

  const remove = async (u: UserView): Promise<void> => {
    if (!confirm(`删除用户 ${u.email}？其 API key 将解绑（保留但不再计额度）。`)) return;
    await api(`/admin/users/${u.id}`, { method: "DELETE" });
    load();
  };

  return (
    <div className="card">
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      <button className="btn primary" onClick={() => setEditing({ enabled: true, groupIds: [] })}>
        新建用户
      </button>
      {editing && (
        <form className="inline-form" onSubmit={save}>
          <h3>{editing.id ? `编辑用户 ${editing.email}` : "新建用户"}</h3>
          {!editing.id && (
            <>
              <label htmlFor="u-email">邮箱（登录账号）</label>
              <input id="u-email" type="email" value={editing.email ?? ""} onChange={(e) => setEditing({ ...editing, email: e.target.value })} required />
            </>
          )}
          <label htmlFor="u-password">{editing.id ? "重置密码（留空不修改）" : "初始密码（至少 6 位）"}</label>
          <input
            id="u-password"
            type="text"
            value={editing.password ?? ""}
            onChange={(e) => setEditing({ ...editing, password: e.target.value })}
            {...(editing.id ? {} : { required: true, minLength: 6 })}
          />
          <label htmlFor="u-quota">额度（生图张数，正整数）</label>
          <input
            id="u-quota"
            type="number"
            min={1}
            step={1}
            value={editing.quotaTotal ?? ""}
            onChange={(e) => setEditing({ ...editing, quotaTotal: e.target.value === "" ? undefined : Number(e.target.value) })}
            required={!editing.id || (editing.quotaTotal ?? 0) > 0}
          />
          <label>渠道分组（不选 = 不限渠道）</label>
          <div className="keys">
            {groups.map((g) => (
              <span key={g.id} className={`pill ${(editing.groupIds ?? []).includes(g.id) ? "" : "off"}`}>
                <button className="link" type="button" onClick={() => toggleGroup(g.id)}>
                  {(editing.groupIds ?? []).includes(g.id) ? "✓ " : "+ "}
                  {g.name}
                </button>
              </span>
            ))}
            {groups.length === 0 && <span className="muted">尚无分组，可先在「分组」页创建。</span>}
          </div>
          {editing.id && (
            <label className="check">
              <input type="checkbox" checked={editing.enabled ?? true} onChange={(e) => setEditing({ ...editing, enabled: e.target.checked })} /> 启用
            </label>
          )}
          <div className="row">
            <button className="btn primary" type="submit">
              保存
            </button>
            <button className="btn ghost" type="button" onClick={() => setEditing(null)}>
              取消
            </button>
          </div>
        </form>
      )}
      {users.length === 0 && <p className="muted">还没有用户。</p>}
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>邮箱</th>
              <th>角色</th>
              <th>状态</th>
              <th>额度</th>
              <th>分组</th>
              <th>创建时间</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.email}</td>
                <td>{u.role}</td>
                <td>
                  <span className={`pill ${u.enabled ? "" : "off"}`}>{u.enabled ? "启用" : "禁用"}</span>
                </td>
                <td>{u.quotaRemaining === null ? "不限" : `${u.quotaRemaining}/${u.quotaTotal}（已用 ${u.quotaUsed}）`}</td>
                <td>
                  {(u.groupIds ?? []).length === 0
                    ? "不限"
                    : (u.groupIds ?? [])
                        .map((gid) => groups.find((g) => g.id === gid)?.name ?? `#${gid}`)
                        .join("、")}
                </td>
                <td className="muted">{fmtTime(u.createdAt)}</td>
                <td>
                  {u.role === "user" && (
                    <>
                      <button className="btn small" onClick={() => setEditing({ ...u })}>
                        编辑
                      </button>{" "}
                      <button className="btn small" onClick={() => resetPassword(u)}>
                        重置密码
                      </button>{" "}
                      <button className="btn small" onClick={() => toggleEnabled(u)}>
                        {u.enabled ? "禁用" : "启用"}
                      </button>{" "}
                      <button className="btn small danger" onClick={() => remove(u)}>
                        删除
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Admin.tsx 挂载两个 Tab + ApiKeysTab 关联用户**

`web/src/pages/Admin.tsx` 修改：

1. 顶部 import 追加：

```tsx
import GroupsTab from "./admin/GroupsTab";
import UsersTab from "./admin/UsersTab";
// 并在 from "../api" 的导入中加入 type UserView
```

2. Tab 类型与列表扩展：

```tsx
type Tab = "channels" | "models" | "keys" | "logs" | "groups" | "users";

const TABS: [Tab, string][] = [
  ["channels", "渠道"],
  ["groups", "分组"],
  ["models", "模型映射"],
  ["keys", "API Keys"],
  ["users", "用户"],
  ["logs", "请求日志"],
];
```

3. `<div role="tabpanel">` 内追加两行：

```tsx
        {tab === "groups" && <GroupsTab />}
        {tab === "users" && <UsersTab />}
```

4. `ApiKeysTab` 支持创建时绑定用户：组件内加状态与数据加载：

```tsx
  const [users, setUsers] = useState<UserView[]>([]);
  const [userId, setUserId] = useState<string>("");
  // load() 内追加：
  api<UserView[]>("/admin/users")
    .then((list) => setUsers(list.filter((u) => u.role === "user" && u.enabled)))
    .catch(() => undefined);
```

创建表单（`<form className="row">`）里、提交按钮之前插入：

```tsx
        <label htmlFor="ak-user">关联用户（可选）</label>
        <select id="ak-user" value={userId} onChange={(e) => setUserId(e.target.value)}>
          <option value="">不关联（不计额度）</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.email}
            </option>
          ))}
        </select>
```

`create` 里请求体改为：

```tsx
      const k = await api<ApiKey>("/admin/api-keys", {
        method: "POST",
        body: { name, ...(userId ? { userId: Number(userId) } : {}) },
      });
```

表格 `<th>名称</th>` 后加 `<th>关联用户</th>`，对应行加 `<td>{k.userEmail ?? <span className="muted">-</span>}</td>`（列数保持一致）。

- [ ] **Step 4: 构建验证**

Run: `cd web && npm run build`
Expected: 构建成功

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/admin/GroupsTab.tsx web/src/pages/admin/UsersTab.tsx web/src/pages/Admin.tsx
git commit -m "feat(web): admin groups/users tabs, api-key user binding"
```

---

### Task 8: 全量验证与手工冒烟

**Files:** 无新文件（验证 + 修复）

- [ ] **Step 1: 全量自动化验证**

Run:

```bash
cd server && npx vitest run && npx tsc -p tsconfig.build.json --noEmit && cd ../web && npm run build
```

Expected: server 全部测试 PASS、类型检查通过、web 构建成功。失败则修复后重跑。

- [ ] **Step 2: 手工冒烟（本地起服务）**

Run:

```bash
cd server && DATA_DIR=$(mktemp -d) ADMIN_TOKEN=devtoken npx tsx src/index.ts &
# 观察启动日志中的初始 admin 邮箱与随机密码
```

用浏览器或 curl 验证完整链路：

1. 打开 `http://localhost:3000`，用日志里的初始 admin 邮箱密码登录。
2. Admin → 分组：建组「vip」并勾选一个渠道。
3. Admin → 用户：创建 `tester@x.com`（密码 ≥6 位、额度 3、分组 vip），生成一个关联该用户的 API Key。
4. Admin → API Keys：确认列表显示关联用户。
5. 用该 key 调 `POST /v1/images/generations`（model 需已映射；如无上游可用 Guide 页的示例 curl 换成本服务地址）：确认返回 200 且用户额度 3→递减；连续调用至额度耗尽确认返回 402。
6. 登出，用 `tester@x.com` 登录：确认导航无「管理后台」、顶部显示剩余额度；直接访问 `http://localhost:3000/admin` 应回跳 `/`。
7. 「改密码」：修改后用新密码重新登录成功。

注意：没有真实上游渠道时第 5 步的 200 无法达成（上游会 502），此时可用 `curl` 断言 402/404/额度数值即可——额度校验发生在调用上游之前。

- [ ] **Step 3: 停掉冒烟服务并提交（若有修复）**

```bash
git status   # 若有修复改动，按所属 Task 语义提交
git commit -m "fix(server|web): smoke fixes for groups/users/quota"  # 仅在有改动时
```

---

## Self-Review 记录

- 规格覆盖：分组多对多（Task 1/3/7）、用户+JWT+ADMIN_TOKEN 兼容（Task 2/5/6）、用户管理 API（Task 3/7）、额度按张数扣+402+并发安全（Task 4）、api_key 绑定用户（Task 3/4/7）、初始 admin（Task 5）、/v1/models 过滤（Task 4）——均有着落。
- 类型一致性：`allowedChannelIds(userId): number[] | null`、`chargeQuota(userId, n): boolean`、`ExecutorOptions.callerUserId/allowedChannelIds`、`UserView`/`Me` 前后端字段一致。
- 已知取舍：被删用户的历史 generations 仍按 api_key 关联展示（规格未要求按用户隔离历史，YAGNI）；jobs.ts 调用点在 Task 4 中按 grep 结果统一修改。
