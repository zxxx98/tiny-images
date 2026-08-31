# 每日额度刷新与已有图片编辑修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让普通用户额度按北京时间每日零点恢复，并让从生成结果或历史记录带入的图片可以直接提交编辑。

**Architecture:** SQLite `users.quota_day` 记录用量归属的北京时间日期，Repo 在读取或扣减额度前用注入时钟做懒刷新，Executor 和 API 保持现有调用方式。Web 将原图文件输入拆成可独立服务端渲染测试的组件，`required` 由已有文件数量决定。

**Tech Stack:** TypeScript、Node.js 22、SQLite `node:sqlite`、Fastify、React 18、Vitest、Vite

---

**设计文档:** `docs/superpowers/specs/2026-08-30-daily-quota-and-existing-image-edit-design.md`

**文件职责:**

- `server/src/store/db.ts`：追加无损 SQLite migration，新增 `users.quota_day`。
- `server/src/store/repo.ts`：北京时间日期计算、可注入时钟、额度懒刷新与原子扣减。
- `server/tests/groups-users-store.test.ts`：日期边界、当天稳定性和跨日扣减的 Repo 回归测试。
- `server/tests/quota-groups.test.ts`：通过真实 HTTP 路由证明额度耗尽后跨日恢复。
- `web/src/pages/EditImageInput.tsx`：原图文件输入及预览，集中管理条件 `required`。
- `web/src/pages/EditImageInput.test.tsx`：服务端渲染检查有图/无图时的原生校验属性。
- `web/src/pages/Playground.tsx`：复用原图输入组件，保留远端图片转 `File` 的现有数据流。
- `web/package.json`、`package.json`、`package-lock.json`：接入 Web Vitest 并纳入根目录全量测试。

### Task 1: 先写每日额度的失败回归测试

**Files:**

- Modify: `server/tests/groups-users-store.test.ts`
- Modify: `server/tests/quota-groups.test.ts`

- [ ] **Step 1: 为 Repo 测试注入可控时钟并添加北京时间边界测试**

在 `server/tests/groups-users-store.test.ts` 中把初始化改为：

```ts
let dir: string;
let repo: Repo;
let now: number;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gu-"));
  now = Date.UTC(2026, 0, 1, 15, 59, 59);
  repo = new Repo(openDb(dir), () => now);
});
```

在 `users` describe 中添加：

```ts
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
```

把 Repo import 改为：

```ts
import { ConflictError, quotaDayAt, Repo } from "../src/store/repo.js";
```

- [ ] **Step 2: 添加 HTTP 层跨日恢复测试**

在 `server/tests/quota-groups.test.ts` 声明 `let now: number`，并在 `beforeEach` 创建 Repo 前加入：

```ts
now = Date.UTC(2026, 0, 1, 15, 59, 59);
repo = new Repo(openDb(dir), () => now);
```

在 `describe("quota")` 中添加：

```ts
it("restores an exhausted quota after Beijing midnight", async () => {
  const s = await setupUser({ quotaTotal: 2, groupName: null });
  const auth = { authorization: `Bearer ${s.apiKey}` };

  const exhausted = await app.inject({
    method: "POST",
    url: "/v1/images/generations",
    headers: auth,
    payload: { model: "mdl", prompt: "p", n: 2 },
  });
  expect(exhausted.statusCode).toBe(200);
  expect(repo.getUser(s.userId)?.quotaUsed).toBe(2);
  expect((await app.inject({
    method: "POST",
    url: "/v1/images/generations",
    headers: auth,
    payload: { model: "mdl", prompt: "p" },
  })).statusCode).toBe(402);

  now = Date.UTC(2026, 0, 1, 16, 0, 0);
  const restored = await app.inject({
    method: "POST",
    url: "/v1/images/generations",
    headers: auth,
    payload: { model: "mdl", prompt: "p" },
  });
  expect(restored.statusCode).toBe(200);
  expect(repo.getUser(s.userId)).toMatchObject({ quotaUsed: 1, quotaDay: "2026-01-02" });
});
```

- [ ] **Step 3: 运行测试并确认 RED**

Run:

```bash
npm test -w server -- groups-users-store.test.ts quota-groups.test.ts
```

Expected: FAIL，因为 `quotaDayAt` 尚未导出、Repo 尚不接受时钟参数且 `UserRow` 没有 `quotaDay`。

### Task 2: 实现 SQLite 迁移和 Repo 懒刷新

**Files:**

- Modify: `server/src/store/db.ts`
- Modify: `server/src/store/repo.ts`
- Test: `server/tests/groups-users-store.test.ts`
- Test: `server/tests/quota-groups.test.ts`

- [ ] **Step 1: 添加 `quota_day` migration**

在 `server/src/store/db.ts` 的 `MIGRATIONS` 尾部追加：

```ts
  `
  ALTER TABLE users ADD COLUMN quota_day TEXT;
  `,
```

- [ ] **Step 2: 添加北京时间日期函数、时钟和返回字段**

在 `server/src/store/repo.ts` 的 `LOG_KEEP` 附近加入：

```ts
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

export function quotaDayAt(timestamp: number): string {
  return new Date(timestamp + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
}
```

将 `UserRow` 增加：

```ts
quotaDay: string | null;
```

将 Repo 构造函数改为：

```ts
export class Repo {
  private db: DatabaseSync;

  constructor(
    db: DatabaseSync,
    private readonly now: () => number = Date.now,
  ) {
    this.db = db;
  }
```

并在 `toUser` 中增加：

```ts
quotaDay: row.quota_day === null || row.quota_day === undefined ? null : String(row.quota_day),
```

- [ ] **Step 3: 实现集中式懒刷新并接入所有额度读取路径**

在 users 区域加入：

```ts
private currentQuotaDay(): string {
  return quotaDayAt(this.now());
}

private refreshDailyQuota(userId: number): void {
  const day = this.currentQuotaDay();
  this.db
    .prepare("UPDATE users SET quota_used = 0, quota_day = ? WHERE id = ? AND (quota_day IS NULL OR quota_day <> ?)")
    .run(day, userId, day);
}

private refreshAllDailyQuotas(): void {
  const day = this.currentQuotaDay();
  this.db
    .prepare("UPDATE users SET quota_used = 0, quota_day = ? WHERE quota_day IS NULL OR quota_day <> ?")
    .run(day, day);
}
```

创建用户时直接记录当天：

```ts
const res = this.db
  .prepare("INSERT INTO users (email, password_hash, role, enabled, quota_total, quota_used, quota_day, created_at) VALUES (?, ?, ?, 1, ?, 0, ?, ?)")
  .run(email, input.passwordHash, input.role, input.quotaTotal, this.currentQuotaDay(), Date.now());
```

将读取与扣减方法改为：

```ts
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

chargeQuota(userId: number, n: number): boolean {
  this.refreshDailyQuota(userId);
  const res = this.db
    .prepare("UPDATE users SET quota_used = quota_used + ? WHERE id = ? AND (quota_total IS NULL OR quota_used + ? <= quota_total)")
    .run(n, userId, n);
  return Number(res.changes) > 0;
}
```

- [ ] **Step 4: 运行针对性测试并确认 GREEN**

Run:

```bash
npm test -w server -- groups-users-store.test.ts quota-groups.test.ts
```

Expected: 两个测试文件全部 PASS，跨日 API 请求由 402 恢复为 200。

- [ ] **Step 5: 运行服务端全量测试**

Run:

```bash
npm test -w server
```

Expected: 所有 server Vitest 测试 PASS，无未处理错误。

- [ ] **Step 6: 提交每日额度修复**

```bash
git add server/src/store/db.ts server/src/store/repo.ts server/tests/groups-users-store.test.ts server/tests/quota-groups.test.ts
git commit -m "fix(server): refresh user quotas daily in Beijing time"
```

### Task 3: 先写编辑表单失败测试，再实现条件校验

**Files:**

- Create: `web/src/pages/EditImageInput.test.tsx`
- Create: `web/src/pages/EditImageInput.tsx`
- Modify: `web/src/pages/Playground.tsx`
- Modify: `web/package.json`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: 接入 Web 测试命令**

运行依赖安装以准确更新 workspace lockfile：

```bash
npm install --save-dev -w web vitest@^3.0.5
```

在 `web/package.json` scripts 中增加：

```json
"test": "vitest run"
```

将根 `package.json` 的 test 改为：

```json
"test": "npm test -w server && npm test -w web"
```

- [ ] **Step 2: 写服务端渲染回归测试**

创建 `web/src/pages/EditImageInput.test.tsx`：

```tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import EditImageInput from "./EditImageInput";

const renderInput = (files: File[]): string =>
  renderToStaticMarkup(<EditImageInput files={files} previews={[]} onChange={() => undefined} />);

describe("EditImageInput", () => {
  it("requires a manual choice only when no image is already loaded", () => {
    expect(renderInput([])).toMatch(/<input[^>]+id="pg-edit-image"[^>]+required=""/);
    expect(renderInput([{ name: "existing.png" } as File])).not.toMatch(/id="pg-edit-image"[^>]+required=""/);
  });
});
```

- [ ] **Step 3: 运行 Web 测试并确认 RED**

Run:

```bash
npm test -w web -- EditImageInput.test.tsx
```

Expected: FAIL，因为 `./EditImageInput` 尚不存在。

- [ ] **Step 4: 创建最小的可测试原图输入组件**

创建 `web/src/pages/EditImageInput.tsx`：

```tsx
interface EditImageInputProps {
  files: File[];
  previews: string[];
  onChange: (files: File[]) => void;
}

export default function EditImageInput({ files, previews, onChange }: EditImageInputProps) {
  return (
    <>
      <label htmlFor="pg-edit-image">原图（可多选，PNG/JPG/WebP）</label>
      <input
        id="pg-edit-image"
        type="file"
        accept="image/png,image/jpeg,image/webp"
        multiple
        onChange={(e) => onChange(Array.from(e.target.files ?? []))}
        required={files.length === 0}
      />
      {previews.length > 0 && (
        <div className="edit-previews">
          {files.map((file, index) => (
            <figure key={`${file.name}-${index}`} className="edit-preview" title={file.name}>
              <img src={previews[index]} alt={`原图 ${index + 1}：${file.name}`} />
              <figcaption className="muted">{file.name}</figcaption>
            </figure>
          ))}
        </div>
      )}
    </>
  );
}
```

- [ ] **Step 5: Playground 复用组件**

在 `web/src/pages/Playground.tsx` import：

```ts
import EditImageInput from "./EditImageInput";
```

用以下内容替换原图 label、input 和预览块：

```tsx
<EditImageInput files={editFiles} previews={editPreviews} onChange={setEditFiles} />
```

保留 mask 输入和 `runEdit` 中遍历 `editFiles` 写入 `FormData` 的逻辑不变。

- [ ] **Step 6: 运行针对性 Web 测试并确认 GREEN**

Run:

```bash
npm test -w web -- EditImageInput.test.tsx
```

Expected: 1 test PASS；无图 markup 包含 `required`，已有图 markup 不包含。

- [ ] **Step 7: 构建 Web 以验证类型与 JSX 集成**

Run:

```bash
npm run build -w web
```

Expected: TypeScript 与 Vite 构建成功，退出码 0。

- [ ] **Step 8: 提交编辑修复**

```bash
git add package.json package-lock.json web/package.json web/src/pages/EditImageInput.tsx web/src/pages/EditImageInput.test.tsx web/src/pages/Playground.tsx
git commit -m "fix(web): reuse loaded images without file re-selection"
```

### Task 4: 完整验证、审查并推送

**Files:**

- Verify: `docs/superpowers/specs/2026-08-30-daily-quota-and-existing-image-edit-design.md`
- Verify: all files changed since `origin/main`

- [ ] **Step 1: 运行根目录全量测试**

Run:

```bash
npm test
```

Expected: server 与 web Vitest 全部 PASS，0 failures。

- [ ] **Step 2: 运行完整生产构建**

Run:

```bash
npm run build
```

Expected: Web Vite build 与 server TypeScript build 均退出码 0。

- [ ] **Step 3: 检查差异与迁移完整性**

Run:

```bash
git diff --check origin/main...HEAD
git status --short --branch
git log --oneline origin/main..HEAD
```

Expected: `git diff --check` 无输出；工作区干净；提交包含设计、每日额度修复和已有图片编辑修复。

- [ ] **Step 4: 对照规格逐项审查**

确认以下证据全部存在：

```text
北京时间 23:59:59 与次日 00:00:00 的日期断言
同日用量不清零、跨日清零且随后扣减为 1/2
quota_day migration 不改写其他表和字段
已有 File 时原图 input 没有 required
没有 File 时原图 input 仍有 required
服务端全量测试、Web 测试、完整 build 均通过
```

- [ ] **Step 5: 推送当前 main 到远端**

```bash
git push origin main
```

Expected: push 成功，`git rev-parse HEAD` 与 `git rev-parse origin/main` 输出相同提交。
