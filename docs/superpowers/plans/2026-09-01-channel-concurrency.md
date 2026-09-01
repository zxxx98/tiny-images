# 渠道并发设置 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为每个渠道增加默认值为 2 的持久化并发上限，并在所有统一执行路径中实施该限制。

**Architecture:** SQLite 和渠道 DTO 保存正整数 `concurrency`。`Executor` 为每个渠道维护一个可动态更新上限的 FIFO 信号量，把完整的 provider/Key 轮换周期包在槽位中；管理 API 和 React 表单负责校验与配置。

**Tech Stack:** TypeScript、Node.js SQLite、Fastify、React、Vitest

---

### Task 1: 持久化并发设置并暴露管理 API

**Files:**
- Modify: `server/tests/store.test.ts`
- Modify: `server/tests/admin.test.ts`
- Modify: `server/tests/files-seed.test.ts`
- Modify: `server/src/store/db.ts`
- Modify: `server/src/core/types.ts`
- Modify: `server/src/store/repo.ts`
- Modify: `server/src/store/seed.ts`
- Modify: `server/src/server/admin.ts`
- Modify: `README.md`

- [ ] **Step 1: 写失败测试**

在 store 测试断言缺省 `concurrency === 2`、显式创建与更新值会持久化；在 admin 测试断言创建/更新返回并发值，`0`、小数和字符串返回 400；在 seed 测试断言 YAML 的 `concurrency: 4` 被读取。

- [ ] **Step 2: 验证测试因字段缺失而失败**

Run: `npm test -w server -- tests/store.test.ts tests/admin.test.ts tests/files-seed.test.ts`
Expected: FAIL，断言收到 `undefined` 或非法值未被拒绝。

- [ ] **Step 3: 最小实现数据与 API**

新增迁移：

```sql
ALTER TABLE channels ADD COLUMN concurrency INTEGER NOT NULL DEFAULT 2;
```

为渠道类型与仓储映射新增 `concurrency`，INSERT/UPDATE 包含该列，创建缺省使用 2。`validateChannelInput` 仅接受大于等于 1 的整数。种子类型和创建调用透传可选值，并在 README YAML 示例中展示 `concurrency: 2`。

- [ ] **Step 4: 验证数据与 API 测试通过**

Run: `npm test -w server -- tests/store.test.ts tests/admin.test.ts tests/files-seed.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add server README.md
git commit -m "feat: persist channel concurrency settings"
```

### Task 2: 在 Executor 实施渠道级并发限制

**Files:**
- Create: `server/src/core/concurrency.ts`
- Create: `server/tests/concurrency.test.ts`
- Modify: `server/tests/executor.test.ts`
- Modify: `server/src/core/executor.ts`

- [ ] **Step 1: 写信号量和 Executor 失败测试**

信号量测试覆盖 FIFO、调大立即放行、调小等待活动数下降和 task 异常释放。Executor 集成测试创建 `concurrency: 2` 渠道，发起 3 个受控 provider 调用，断言第三个在前两个之一释放前未进入 provider，释放后完成。

- [ ] **Step 2: 验证测试因实现缺失而失败**

Run: `npm test -w server -- tests/concurrency.test.ts tests/executor.test.ts`
Expected: FAIL，因为 `AdaptiveConcurrencyLimiter` 不存在且 Executor 未排队。

- [ ] **Step 3: 实现自适应 FIFO 信号量**

公开 API：

```ts
export class AdaptiveConcurrencyLimiter {
  constructor(max: number);
  setMax(max: number): void;
  run<T>(task: () => Promise<T>): Promise<T>;
}
```

`setMax` 和 `finally` 都调用私有 `drain()`，当 `active < max` 时按 FIFO 唤醒队列。`Executor` 用 `Map<number, AdaptiveConcurrencyLimiter>` 缓存实例，每次请求同步 `channel.concurrency`，并用 `limiter.run(() => this.callUpstream(...))` 包住额度检查后的原有上游逻辑。

- [ ] **Step 4: 验证限流测试与完整 server 测试通过**

Run: `npm test -w server -- tests/concurrency.test.ts tests/executor.test.ts`
Expected: PASS。

Run: `npm test -w server`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add server
git commit -m "feat: limit concurrent requests per channel"
```

### Task 3: 管理端配置渠道并发

**Files:**
- Modify: `web/src/api.ts`
- Modify: `web/src/pages/Admin.tsx`
- Modify: `web/src/pages/Admin.test.tsx`

- [ ] **Step 1: 写失败测试**

扩展 `newChannelDraft` 测试，断言草稿包含 `concurrency: 2`。

- [ ] **Step 2: 验证测试失败**

Run: `npm test -w web -- src/pages/Admin.test.tsx`
Expected: FAIL，草稿缺少并发字段。

- [ ] **Step 3: 最小实现表单与列表**

Web `Channel` 新增 `concurrency: number`；草稿设为 2；渠道表单新增 `type="number" min={1} step={1}` 输入并写回数值；渠道行新增“并发 N”标签。

- [ ] **Step 4: 验证 Web 测试通过**

Run: `npm test -w web -- src/pages/Admin.test.tsx`
Expected: PASS。

Run: `npm test -w web`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add web
git commit -m "feat(web): configure channel concurrency"
```

### Task 4: 完整验证与集成

**Files:**
- Verify: all changed files

- [ ] **Step 1: 自检需求覆盖与差异**

Run: `git diff main...HEAD --check && git diff --stat main...HEAD`
Expected: 无空白错误，差异仅包含规格、计划、渠道持久化/校验/限流/UI/测试/文档。

- [ ] **Step 2: 完整测试与构建**

Run: `npm test && npm run build`
Expected: 两个命令均退出 0。

- [ ] **Step 3: 合并到 main 后复验并推送**

按用户已指定的集成方式，将功能分支合并到 `main`，在合并结果上再次运行 `npm test && npm run build`，然后 `git push origin main`。
