# History Retention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retain generation metadata for seven days, retain generated image files for the existing 24 hours, and cap administrator request logs at the newest 50 rows.

**Architecture:** Keep retention enforcement in the storage layer and call it from the existing hourly maintenance loop. A small retention module owns the seven-day duration and cutoff calculation, while `Repo` owns the physical SQL deletion; image sweeping remains unchanged and independent.

**Tech Stack:** TypeScript, Node.js 22 SQLite, Vitest, Fastify server lifecycle.

---

## File map

- Modify `server/src/store/repo.ts`: change the request-log row cap and add physical generation-history pruning.
- Modify `server/src/store/db.ts`: add an index on `generations.created_at` through the next SQLite migration.
- Create `server/src/store/retention.ts`: own the seven-day constant and cutoff calculation without server startup side effects.
- Modify `server/src/index.ts`: run image and generation-history cleanup at startup and hourly.
- Modify `server/tests/store.test.ts`: cover the 50-log cap, seven-day deletion boundary, and retention index.
- Create `server/tests/retention.test.ts`: cover the exact seven-day cutoff passed to the repository.
- Modify `README.md`: document the new limits separately for logs, history metadata, and image files.

### Task 1: Cap request logs at 50

**Files:**
- Modify: `server/tests/store.test.ts:117-127`
- Modify: `server/src/store/repo.ts:128,434-452`

- [ ] **Step 1: Change the storage test to require the newest 50 rows**

```ts
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
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -w server -- tests/store.test.ts -t "prunes to 50"`

Expected: FAIL because the repository still retains all 55 rows under its 1000-row limit.

- [ ] **Step 3: Apply the minimal production change**

```ts
const LOG_KEEP = 50;
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `npm test -w server -- tests/store.test.ts -t "prunes to 50"`

Expected: PASS with one selected test.

- [ ] **Step 5: Commit the log-limit change**

```bash
git add server/src/store/repo.ts server/tests/store.test.ts
git commit -m "feat: retain latest 50 request logs"
```

### Task 2: Physically prune generation history at the seven-day boundary

**Files:**
- Modify: `server/tests/store.test.ts:129-149`
- Modify: `server/src/store/repo.ts:469-531`
- Modify: `server/src/store/db.ts:110-116`

- [ ] **Step 1: Add a failing boundary test for repository pruning**

Add a small `generationEntry(createdAt, prompt)` helper in the `generations` test block, then add:

```ts
it("prunes generations strictly older than the cutoff", () => {
  repo.insertGeneration(generationEntry(99, "expired"));
  repo.insertGeneration(generationEntry(100, "boundary"));
  repo.insertGeneration(generationEntry(101, "fresh"));

  expect(repo.pruneGenerations(100)).toBe(1);
  expect(repo.listGenerations({ admin: true, userId: null, apiKeyId: null }, null, 10).map((row) => row.prompt)).toEqual([
    "fresh",
    "boundary",
  ]);
});
```

The helper must return a complete `GenerationEntry`:

```ts
const generationEntry = (createdAt: number, prompt: string) => ({
  createdAt,
  apiKeyId: null,
  userId: null,
  model: "m",
  prompt,
  params: "{}",
  status: "ok" as const,
  channelId: null,
  latencyMs: 1,
  errorMessage: null,
  images: "[]",
});
```

- [ ] **Step 2: Run the pruning test and verify RED**

Run: `npm test -w server -- tests/store.test.ts -t "prunes generations strictly"`

Expected: FAIL at TypeScript/runtime resolution because `Repo.pruneGenerations` does not exist.

- [ ] **Step 3: Add the minimal repository deletion method**

Place this alongside the other generation methods:

```ts
pruneGenerations(createdBefore: number): number {
  const result = this.db.prepare("DELETE FROM generations WHERE created_at < ?").run(createdBefore);
  return Number(result.changes);
}
```

- [ ] **Step 4: Run the pruning test and verify GREEN**

Run: `npm test -w server -- tests/store.test.ts -t "prunes generations strictly"`

Expected: PASS; only the row at timestamp 99 is deleted.

- [ ] **Step 5: Add a failing migration-index assertion**

Import `DatabaseSync` from `node:sqlite` in `server/tests/store.test.ts`, then add:

```ts
it("indexes generation creation time for retention pruning", () => {
  const db = new DatabaseSync(path.join(dir, "tiny-images.db"));
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?").get("generations_created_at");
  db.close();
  expect(row).toBeDefined();
});
```

- [ ] **Step 6: Run the index test and verify RED**

Run: `npm test -w server -- tests/store.test.ts -t "indexes generation creation time"`

Expected: FAIL because the index is absent.

- [ ] **Step 7: Add the next database migration**

Append this entry to `MIGRATIONS`:

```ts
  `
  CREATE INDEX IF NOT EXISTS generations_created_at ON generations(created_at);
  `,
```

- [ ] **Step 8: Run both focused generation tests and verify GREEN**

Run: `npm test -w server -- tests/store.test.ts -t "prunes generations strictly|indexes generation creation time"`

Expected: PASS with two selected tests.

- [ ] **Step 9: Commit repository pruning and its index**

```bash
git add server/src/store/repo.ts server/src/store/db.ts server/tests/store.test.ts
git commit -m "feat: prune expired generation history"
```

### Task 3: Schedule independent seven-day history cleanup

**Files:**
- Create: `server/tests/retention.test.ts`
- Create: `server/src/store/retention.ts`
- Modify: `server/src/index.ts:46-52`

- [ ] **Step 1: Write a failing unit test for the exact seven-day cutoff**

```ts
import { describe, expect, it, vi } from "vitest";
import { pruneExpiredGenerationHistory } from "../src/store/retention.js";

describe("generation history retention", () => {
  it("prunes rows older than exactly seven days", () => {
    const pruneGenerations = vi.fn(() => 2);
    const now = Date.UTC(2026, 7, 31, 12);

    expect(pruneExpiredGenerationHistory({ pruneGenerations }, now)).toBe(2);
    expect(pruneGenerations).toHaveBeenCalledWith(now - 7 * 24 * 60 * 60 * 1000);
  });
});
```

- [ ] **Step 2: Run the retention test and verify RED**

Run: `npm test -w server -- tests/retention.test.ts`

Expected: FAIL because `server/src/store/retention.ts` does not exist.

- [ ] **Step 3: Implement the retention unit**

```ts
export const GENERATION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface GenerationHistoryPruner {
  pruneGenerations(createdBefore: number): number;
}

export function pruneExpiredGenerationHistory(repo: GenerationHistoryPruner, now = Date.now()): number {
  return repo.pruneGenerations(now - GENERATION_RETENTION_MS);
}
```

- [ ] **Step 4: Run the retention test and verify GREEN**

Run: `npm test -w server -- tests/retention.test.ts`

Expected: PASS with one test.

- [ ] **Step 5: Wire history pruning into the existing startup/hourly sweep**

Import `pruneExpiredGenerationHistory` in `server/src/index.ts` and extend the existing function without changing the image TTL:

```ts
// 每小时独立清理生成图（24h）和历史记录（7d）
const sweep = (): void => {
  const sweptImages = sweepExpired(env.dataDir, 24 * 3600_000);
  if (sweptImages > 0) app.log.info(`swept ${sweptImages} expired generated images`);

  const sweptHistory = pruneExpiredGenerationHistory(repo);
  if (sweptHistory > 0) app.log.info(`swept ${sweptHistory} expired generation records`);
};
sweep();
setInterval(sweep, 3600_000).unref();
```

- [ ] **Step 6: Run retention and store tests**

Run: `npm test -w server -- tests/retention.test.ts tests/store.test.ts`

Expected: PASS for both files.

- [ ] **Step 7: Commit scheduled cleanup**

```bash
git add server/src/store/retention.ts server/src/index.ts server/tests/retention.test.ts
git commit -m "feat: schedule seven-day history cleanup"
```

### Task 4: Documentation and full verification

**Files:**
- Modify: `README.md:160-164`

- [ ] **Step 1: Update the documented limits**

Replace the current combined limitation with:

```md
- `request_logs` 仅保留最近 50 条。
- 生成历史记录保留 7 天；历史图片文件仍按 24 小时 TTL 清理，图片过期后可继续查看 prompt 并重新生成。
```

- [ ] **Step 2: Run formatting and diff checks**

Run: `git diff --check && rg -n "1000|24 小时|7 天|50 条" README.md server/src server/tests`

Expected: `git diff --check` exits 0; active documentation and test names use the new limits, while unrelated historical design documents may still describe their original scope.

- [ ] **Step 3: Run the complete test suite**

Run: `npm test`

Expected: server 170 existing tests plus the new retention coverage pass; web 18 tests pass.

- [ ] **Step 4: Run the production build**

Run: `npm run build`

Expected: both web and server builds exit 0.

- [ ] **Step 5: Commit documentation**

```bash
git add README.md
git commit -m "docs: document history retention limits"
```

- [ ] **Step 6: Inspect final branch state**

Run: `git status --short && git log --oneline --decorate -5`

Expected: clean worktree with the retention implementation commits above the approved design commit.
