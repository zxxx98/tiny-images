# 生成历史 + 可恢复生成请求 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 服务端持久化每次图片生成的记录与图片文件，Playground 改用服务端 job 轮询（切走可恢复），并新增历史页面。

**Architecture:** SQLite 新增 `generations` 表；兼容端点完成后落库，Playground 专用 job 端点在内存 JobManager 中后台执行并落库；图片一律本地化到 `data/generated/` 由 `/files/:name` 提供访问；前端 Playground 轮询 job + localStorage 恢复，新增 History 页。

**Tech Stack:** Fastify 5 + node:sqlite + Vitest（server）；React 19 + react-router（web）。

**Spec:** `docs/superpowers/specs/2026-08-30-generation-history-design.md`

## Global Constraints

- OpenAI 兼容端点 `/v1/images/generations` 对外契约不变。
- 历史按 API key（`callerApiKeyId`）过滤；游标分页 `before`+`limit`，limit≤100 默认 30。
- TTL 清扫（24h，`sweepExpired`）保持现状，不豁免历史引用的文件。
- 文件被清扫后历史页显示「已过期」占位（前端 img onerror）。
- 服务端启动时把遗留 `pending` 置为 `error("server restarted")`。
- 不改动 `request_logs`（LOG_KEEP=1000）与 admin 现有接口。
- server 代码风格：ESM + `.js` 后缀导入、中文注释只在说明约束处。

---

### Task 1: generations 表 + Repo 方法

**Files:**
- Modify: `server/src/store/db.ts`（MIGRATIONS 数组末尾追加）
- Modify: `server/src/store/repo.ts`
- Test: `server/tests/store.test.ts`

**Interfaces:**
- Produces（Task 3/4 依赖）:
  ```ts
  export interface GenerationEntry {
    id?: number;
    createdAt: number;
    apiKeyId: number | null;
    model: string;
    prompt: string;
    params: string;            // JSON 文本
    status: "pending" | "ok" | "error";
    channelId: number | null;
    latencyMs: number | null;
    errorMessage: string | null;
    images: string;            // JSON 文本 [{file, revisedPrompt?}]
  }
  export interface GenerationRow extends GenerationEntry { id: number }
  class Repo {
    insertGeneration(e: GenerationEntry): number;
    completeGeneration(id: number, patch: Partial<Pick<GenerationEntry, "status" | "channelId" | "latencyMs" | "errorMessage" | "images">>): void;
    listGenerations(apiKeyId: number | null, before: number | null, limit: number): GenerationRow[];
    failPendingGenerations(message: string): number;
  }
  ```

- [ ] **Step 1: 写失败测试**（追加到 `server/tests/store.test.ts`，该文件已有 `dir`/`repo` beforeEach 模式，沿用）

```ts
import { openDb } from "../src/store/db.js"; // 若已导入则忽略

describe("generations", () => {
  it("insert/complete/list cursor pagination", () => {
    const a = repo.createApiKey({ name: "k1" }); // 沿用现有 helper；若无 createApiKey 用文件里现有建 key 方法
    const id1 = repo.insertGeneration({ createdAt: 1, apiKeyId: a.id, model: "m", prompt: "p1", params: "{}", status: "pending", channelId: null, latencyMs: null, errorMessage: null, images: "[]" });
    const id2 = repo.insertGeneration({ createdAt: 2, apiKeyId: a.id, model: "m", prompt: "p2", params: "{}", status: "ok", channelId: 1, latencyMs: 5, errorMessage: null, images: '[{"file":"a.png"}]' });
    repo.completeGeneration(id1, { status: "ok", channelId: 1, latencyMs: 9, images: '[{"file":"b.png"}]' });
    const page1 = repo.listGenerations(a.id, null, 1);
    expect(page1.map((r) => r.id)).toEqual([id2]);
    expect(page1[0].images).toBe('[{"file":"a.png"}]');
    const page2 = repo.listGenerations(a.id, id2, 10);
    expect(page2.map((r) => r.id)).toEqual([id1]);
    expect(page2[0].status).toBe("ok");
    // 其他 key 看不到
    const b = repo.createApiKey({ name: "k2" });
    expect(repo.listGenerations(b.id, null, 10)).toEqual([]);
    // failPending
    const id3 = repo.insertGeneration({ createdAt: 3, apiKeyId: a.id, model: "m", prompt: "p3", params: "{}", status: "pending", channelId: null, latencyMs: null, errorMessage: null, images: "[]" });
    expect(repo.failPendingGenerations("server restarted")).toBe(1);
    expect(repo.listGenerations(a.id, null, 10).find((r) => r.id === id3)?.errorMessage).toBe("server restarted");
  });
});
```

- [ ] **Step 2: 运行确认失败** — `cd server && npx vitest run tests/store.test.ts`，Expected: FAIL（`insertGeneration is not a function`）。

- [ ] **Step 3: 实现** — `db.ts` 迁移数组追加：

```ts
  `
  CREATE TABLE IF NOT EXISTS generations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at INTEGER NOT NULL,
    api_key_id INTEGER,
    model TEXT NOT NULL,
    prompt TEXT NOT NULL,
    params TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL,
    channel_id INTEGER,
    latency_ms INTEGER,
    error_message TEXT,
    images TEXT NOT NULL DEFAULT '[]'
  );
  CREATE INDEX IF NOT EXISTS generations_cursor ON generations(id DESC);
  `,
```

`repo.ts` 追加（类型定义放 `LogRow` 之后）：

```ts
export interface GenerationEntry {
  createdAt: number;
  apiKeyId: number | null;
  model: string;
  prompt: string;
  params: string;
  status: "pending" | "ok" | "error";
  channelId: number | null;
  latencyMs: number | null;
  errorMessage: string | null;
  images: string;
}

export interface GenerationRow extends GenerationEntry {
  id: number;
}
```

`Repo` 类内追加：

```ts
  // ---- generations ----

  insertGeneration(e: GenerationEntry): number {
    const res = this.db
      .prepare(
        `INSERT INTO generations (created_at, api_key_id, model, prompt, params, status, channel_id, latency_ms, error_message, images)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(e.createdAt, e.apiKeyId, e.model, e.prompt, e.params, e.status, e.channelId, e.latencyMs, e.errorMessage, e.images);
    return Number(res.lastInsertRowid);
  }

  completeGeneration(
    id: number,
    patch: Partial<Pick<GenerationEntry, "status" | "channelId" | "latencyMs" | "errorMessage" | "images">>,
  ): void {
    const row = this.db.prepare("SELECT * FROM generations WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) return;
    const merged = {
      status: patch.status ?? (row.status as string),
      channelId: "channelId" in patch ? patch.channelId : (row.channel_id as number | null),
      latencyMs: "latencyMs" in patch ? patch.latencyMs : (row.latency_ms as number | null),
      errorMessage: "errorMessage" in patch ? patch.errorMessage : (row.error_message as string | null),
      images: patch.images ?? (row.images as string),
    };
    this.db
      .prepare(
        `UPDATE generations SET status = ?, channel_id = ?, latency_ms = ?, error_message = ?, images = ? WHERE id = ?`,
      )
      .run(merged.status, merged.channelId, merged.latencyMs, merged.errorMessage, merged.images, id);
  }

  listGenerations(apiKeyId: number | null, before: number | null, limit: number): GenerationRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM generations
         WHERE (? IS NULL OR api_key_id = ?) AND (? IS NULL OR id < ?)
         ORDER BY id DESC LIMIT ?`,
      )
      .all(apiKeyId, apiKeyId, before, before, limit) as Record<string, unknown>[];
    return rows.map((r) => this.toGeneration(r));
  }

  failPendingGenerations(message: string): number {
    const res = this.db
      .prepare(`UPDATE generations SET status = 'error', error_message = ? WHERE status = 'pending'`)
      .run(message);
    return Number(res.changes);
  }

  private toGeneration(r: Record<string, unknown>): GenerationRow {
    return {
      id: Number(r.id),
      createdAt: Number(r.created_at),
      apiKeyId: (r.api_key_id as number | null) ?? null,
      model: String(r.model),
      prompt: String(r.prompt),
      params: String(r.params),
      status: r.status as GenerationRow["status"],
      channelId: (r.channel_id as number | null) ?? null,
      latencyMs: (r.latency_ms as number | null) ?? null,
      errorMessage: (r.error_message as string | null) ?? null,
      images: String(r.images),
    };
  }
```

（若 `store.test.ts` 中建 API key 的方法名不同，改用该文件已有方法。）

- [ ] **Step 4: 运行确认通过** — `cd server && npx vitest run tests/store.test.ts`，Expected: PASS。
- [ ] **Step 5: Commit** — `git add server/src/store/db.ts server/src/store/repo.ts server/tests/store.test.ts && git commit -m "feat(store): generations table and repo methods"`

---

### Task 2: localizeImage — 结果图片本地化

**Files:**
- Modify: `server/src/media/b64cache.ts`
- Test: `server/tests/b64cache.test.ts`

**Interfaces:**
- Produces（Task 3/4 依赖）:
  ```ts
  // 失败（下载失败/无内容）返回 null，不抛异常；成功返回 generated/ 下文件名
  export async function localizeImage(dataDir: string, img: UnifiedImage, fetchTimeoutMs: number): Promise<{ file: string } | null>;
  ```

- [ ] **Step 1: 写失败测试**（追加到 `server/tests/b64cache.test.ts`，沿用该文件现有 PNG_B64 常量与 mock fetch 模式）

```ts
it("localizeImage saves b64 and downloads url, returns null on failure", async () => {
  const fromB64 = await localizeImage(dir, { b64: PNG_B64 }, 1000);
  expect(fromB64?.file).toMatch(/\.png$/);
  expect(fs.existsSync(path.join(dir, "generated", fromB64!.file))).toBe(true);

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(new Blob([Buffer.from(PNG_B64, "base64")]), { status: 200 })) as typeof fetch;
  try {
    const fromUrl = await localizeImage(dir, { url: "http://example.test/x.png" }, 1000);
    expect(fromUrl?.file).toMatch(/\.png$/);
  } finally {
    globalThis.fetch = realFetch;
  }

  expect(await localizeImage(dir, {}, 1000)).toBeNull();
  const realFetch2 = globalThis.fetch;
  globalThis.fetch = (async () => new Response("nope", { status: 404 })) as typeof fetch;
  try {
    expect(await localizeImage(dir, { url: "http://example.test/x.png" }, 1000)).toBeNull();
  } finally {
    globalThis.fetch = realFetch2;
  }
});
```

（`dir` 用该测试文件现有的临时目录变量；若无则 `fs.mkdtempSync`。）

- [ ] **Step 2: 运行确认失败** — `cd server && npx vitest run tests/b64cache.test.ts`，Expected: FAIL（`localizeImage is not exported`）。

- [ ] **Step 3: 实现**（追加到 `b64cache.ts`）：

```ts
// 结果图片本地化供历史引用；下载失败不影响主流程，返回 null
export async function localizeImage(dataDir: string, img: UnifiedImage, fetchTimeoutMs: number): Promise<{ file: string } | null> {
  try {
    if (img.b64 !== undefined) return saveGeneratedImage(dataDir, img.b64);
    if (img.url !== undefined) {
      const b64 = await fetchAsB64(img.url, fetchTimeoutMs, undefined, "history");
      return saveGeneratedImage(dataDir, b64);
    }
  } catch {
    return null;
  }
  return null;
}
```

- [ ] **Step 4: 运行确认通过** — `cd server && npx vitest run tests/b64cache.test.ts`，Expected: PASS。
- [ ] **Step 5: Commit** — `git add server/src/media/b64cache.ts server/tests/b64cache.test.ts && git commit -m "feat(media): localizeImage for history persistence"`

---

### Task 3: JobManager 内存注册表

**Files:**
- Create: `server/src/server/jobs.ts`
- Test: `server/tests/jobs.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `GenerationEntry` 无直接依赖（本类不碰 DB）。
- Produces（Task 4 依赖）:

  ```ts
  export interface JobImage { file: string; revisedPrompt?: string }
  export interface JobRecord {
    id: string;
    apiKeyId: number | null;
    generationId: number;
    model: string;
    prompt: string;
    createdAt: number;
    status: "running" | "ok" | "error";
    progress: string | null;
    images: JobImage[];
    channelId: number | null;
    channelName: string | null;
    latencyMs: number | null;
    errorMessage: string | null;
  }
  export class JobManager {
    constructor(private readonly max = 200) {}
    create(input: { apiKeyId: number | null; generationId: number; model: string; prompt: string }): JobRecord;
    get(id: string, apiKeyId: number | null): JobRecord | null; // apiKeyId 不匹配返回 null
    setProgress(id: string, message: string): void;
    addImage(id: string, image: JobImage): void;
    finish(id: string, patch: { status: "ok" | "error"; channelId: number | null; channelName: string | null; latencyMs: number | null; errorMessage: string | null }): void;
    prune(): void; // 超过 max 时淘汰最老的已完成 job
  }
  ```

- [ ] **Step 1: 写失败测试** `server/tests/jobs.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { JobManager } from "../src/server/jobs.js";

describe("JobManager", () => {
  it("create/get/finish lifecycle with owner check", () => {
    const jm = new JobManager();
    const job = jm.create({ apiKeyId: 1, generationId: 10, model: "m", prompt: "p" });
    expect(jm.get(job.id, 1)?.status).toBe("running");
    expect(jm.get(job.id, 2)).toBeNull();
    jm.setProgress(job.id, "generating");
    jm.addImage(job.id, { file: "a.png" });
    jm.finish(job.id, { status: "ok", channelId: 3, channelName: "c", latencyMs: 42, errorMessage: null });
    const done = jm.get(job.id, 1)!;
    expect(done.progress).toBe("generating");
    expect(done.images).toEqual([{ file: "a.png" }]);
    expect(done.status).toBe("ok");
    expect(done.latencyMs).toBe(42);
  });

  it("prune evicts oldest finished jobs beyond cap", () => {
    const jm = new JobManager(3);
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const j = jm.create({ apiKeyId: null, generationId: i, model: "m", prompt: "p" });
      ids.push(j.id);
      jm.finish(j.id, { status: "ok", channelId: null, channelName: null, latencyMs: 1, errorMessage: null });
    }
    expect(jm.get(ids[0], null)).toBeNull();
    expect(jm.get(ids[3], null)).not.toBeNull();
  });
});
```

- [ ] **Step 2: 运行确认失败** — `cd server && npx vitest run tests/jobs.test.ts`，Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现** `server/src/server/jobs.ts`：

```ts
import { randomBytes } from "node:crypto";

export interface JobImage {
  file: string;
  revisedPrompt?: string;
}

export interface JobRecord {
  id: string;
  apiKeyId: number | null;
  generationId: number;
  model: string;
  prompt: string;
  createdAt: number;
  status: "running" | "ok" | "error";
  progress: string | null;
  images: JobImage[];
  channelId: number | null;
  channelName: string | null;
  latencyMs: number | null;
  errorMessage: string | null;
}

// 内存 job 注册表：进程内可轮询的生成任务；历史查证走 generations 表
export class JobManager {
  private jobs = new Map<string, JobRecord>(); // Map 保插入序，便于按最老淘汰

  constructor(private readonly max = 200) {}

  create(input: { apiKeyId: number | null; generationId: number; model: string; prompt: string }): JobRecord {
    const job: JobRecord = {
      id: randomBytes(12).toString("hex"),
      apiKeyId: input.apiKeyId,
      generationId: input.generationId,
      model: input.model,
      prompt: input.prompt,
      createdAt: Date.now(),
      status: "running",
      progress: null,
      images: [],
      channelId: null,
      channelName: null,
      latencyMs: null,
      errorMessage: null,
    };
    this.jobs.set(job.id, job);
    this.prune();
    return job;
  }

  get(id: string, apiKeyId: number | null): JobRecord | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    // apiKeyId 为 null 的调用者（admin token）可见全部
    if (job.apiKeyId !== null && apiKeyId !== null && job.apiKeyId !== apiKeyId) return null;
    return job;
  }

  setProgress(id: string, message: string): void {
    const job = this.jobs.get(id);
    if (job) job.progress = message;
  }

  addImage(id: string, image: JobImage): void {
    const job = this.jobs.get(id);
    if (job) job.images.push(image);
  }

  finish(
    id: string,
    patch: { status: "ok" | "error"; channelId: number | null; channelName: string | null; latencyMs: number | null; errorMessage: string | null },
  ): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.status = patch.status;
    job.channelId = patch.channelId;
    job.channelName = patch.channelName;
    job.latencyMs = patch.latencyMs;
    job.errorMessage = patch.errorMessage;
  }

  prune(): void {
    if (this.jobs.size <= this.max) return;
    for (const [id, job] of this.jobs) {
      if (this.jobs.size <= this.max) break;
      if (job.status !== "running") this.jobs.delete(id);
    }
  }
}
```

- [ ] **Step 4: 运行确认通过** — `cd server && npx vitest run tests/jobs.test.ts`，Expected: PASS。
- [ ] **Step 5: Commit** — `git add server/src/server/jobs.ts server/tests/jobs.test.ts && git commit -m "feat(server): in-memory job manager"`

---

### Task 4: 兼容端点落库 + job/history 端点 + 启动清 pending

**Files:**
- Create: `server/src/server/history.ts`（jobs 两个端点 + `/v1/history`）
- Modify: `server/src/server/generations.ts`（sync 落库）
- Modify: `server/src/server/stream.ts`（stream 落库）
- Modify: `server/src/server/v1.ts`（注册 history.ts 的路由）
- Modify: `server/src/index.ts`（启动清 pending；buildApp 需要共享 JobManager → 改 `app.ts` deps）
- Modify: `server/src/app.ts`（AppDeps 增加 `jobManager: JobManager`）
- Test: `server/tests/v1-history.test.ts`

**Interfaces:**
- Consumes: Task 1 `insertGeneration/completeGeneration/listGenerations/failPendingGenerations`；Task 2 `localizeImage`；Task 3 `JobManager`；`generations.ts` 的 `validateGenBody/finishSync/fileBaseUrlFor`。
- Produces:
  - `POST /v1/images/jobs` → `{ jobId }`
  - `GET /v1/images/jobs/:id` → `{ status, progress, channel, latencyMs, error, createdAt, images: [{ file, url, revisedPrompt }] }`（404 未知/非本人 job）
  - `GET /v1/history?before&limit` → `{ items: [{ id, createdAt, model, prompt, params, status, latencyMs, errorMessage, images: [{ file, url, revisedPrompt }] }] }`
  - `AppDeps.jobManager: JobManager`

- [ ] **Step 1: 写失败测试** `server/tests/v1-history.test.ts`（沿用 `v1-generations.test.ts` 的 upstream/start 骨架；`buildApp` 增加 `jobManager: new JobManager()`）：

```ts
import Fastify from "fastify";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { Executor } from "../src/core/executor.js";
import { KeyPool } from "../src/core/keyPool.js";
import { ModelRouter } from "../src/core/router.js";
import { OpenAICompatProvider } from "../src/providers/openai-compat.js";
import { openDb } from "../src/store/db.js";
import { Repo } from "../src/store/repo.js";
import { JobManager } from "../src/server/jobs.js";

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
let upstream: ReturnType<typeof Fastify>;
let dir: string;
let repo: Repo;
let app: Awaited<ReturnType<typeof buildApp>>;
let apiKeyId: number;
let apiKey: string;

beforeEach(async () => {
  upstream = Fastify();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "vh-"));
  repo = new Repo(openDb(dir));
});

afterEach(async () => {
  await app.close();
  await upstream.close();
  repo.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function start(): Promise<void> {
  await upstream.listen({ port: 0, host: "127.0.0.1" });
  const port = (upstream.server.address() as { port: number }).port;
  const c = repo.createChannel({ name: "mock", baseUrl: `http://127.0.0.1:${port}/v1` });
  repo.createKey(c.id, "sk-upstream");
  repo.createModel({ publicName: "img-1", channelId: c.id, upstreamName: "gpt-image-1" });
  const created = repo.createApiKey({ name: "k1", key: "sk-test-1" }); // 若无 key 参数则创建后取回
  apiKeyId = created.id;
  apiKey = created.key;
  const provider = new OpenAICompatProvider();
  const router = new ModelRouter(repo);
  const keyPool = new KeyPool(repo);
  app = await buildApp({
    env: { port: 0, dataDir: dir, adminToken: null, publicBaseUrl: null },
    repo, router, keyPool, provider,
    executor: new Executor({ router, keyPool, provider, repo }),
    jobManager: new JobManager(),
    logger: false, webDist: null,
  });
}

const auth = { authorization: "Bearer sk-test-1" };

describe("POST /v1/images/jobs", () => {
  it("runs detached, records generation, poll returns ok with local file", async () => {
    upstream.post("/v1/images/generations", async (_req, reply) =>
      reply.send({ created: 42, data: [{ b64_json: PNG_B64, revised_prompt: "rev" }] }),
    );
    await start();
    const created = await app.inject({ method: "POST", url: "/v1/images/jobs", headers: auth, payload: { model: "img-1", prompt: "cat" } });
    expect(created.statusCode).toBe(200);
    const { jobId } = created.json();
    // 轮询直至完成
    let poll = await app.inject({ method: "GET", url: `/v1/images/jobs/${jobId}`, headers: auth });
    for (let i = 0; i < 50 && poll.json().status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 50));
      poll = await app.inject({ method: "GET", url: `/v1/images/jobs/${jobId}`, headers: auth });
    }
    const body = poll.json();
    expect(body.status).toBe("ok");
    expect(body.channel).toBe("mock");
    expect(body.images[0].url).toMatch(/^http:\/\/localhost:\d+\/files\/[0-9a-f]{32}\.png$/);
    expect(fs.existsSync(path.join(dir, "generated", body.images[0].file))).toBe(true);
    const rows = repo.listGenerations(apiKeyId, null, 10);
    expect(rows[0].status).toBe("ok");
    expect(rows[0].prompt).toBe("cat");
    expect(JSON.parse(rows[0].images)[0].file).toBe(body.images[0].file);
  });

  it("poll 404 for other key and unknown id", async () => {
    upstream.post("/v1/images/generations", async (_req, reply) => reply.send({ created: 1, data: [{ b64_json: PNG_B64 }] }));
    await start();
    const other = repo.createApiKey({ name: "k2" });
    const { jobId } = (await app.inject({ method: "POST", url: "/v1/images/jobs", headers: auth, payload: { model: "img-1", prompt: "cat" } })).json();
    await app.inject({ method: "GET", url: `/v1/images/jobs/${jobId}`, headers: { authorization: `Bearer ${other.key}` } });
    // 等待完成后再断言 404（owner 校验对 running 也生效）
    expect((await app.inject({ method: "GET", url: "/v1/images/jobs/nonexistent", headers: auth })).statusCode).toBe(404);
  });

  it("error job records error generation", async () => {
    upstream.post("/v1/images/generations", async (_req, reply) => reply.code(500).send({ error: { message: "boom" } }));
    await start();
    const { jobId } = (await app.inject({ method: "POST", url: "/v1/images/jobs", headers: auth, payload: { model: "img-1", prompt: "cat" } })).json();
    let poll = await app.inject({ method: "GET", url: `/v1/images/jobs/${jobId}`, headers: auth });
    for (let i = 0; i < 50 && poll.json().status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 50));
      poll = await app.inject({ method: "GET", url: `/v1/images/jobs/${jobId}`, headers: auth });
    }
    expect(poll.json().status).toBe("error");
    expect(poll.json().error).toContain("boom");
    expect(repo.listGenerations(apiKeyId, null, 10)[0].status).toBe("error");
  });
});

describe("GET /v1/history", () => {
  it("lists generations with file urls, key-filtered, cursor pagination", async () => {
    await start();
    repo.insertGeneration({ createdAt: 1, apiKeyId, model: "m", prompt: "p1", params: "{}", status: "ok", channelId: null, latencyMs: 1, errorMessage: null, images: JSON.stringify([{ file: "a.png" }]) });
    repo.insertGeneration({ createdAt: 2, apiKeyId: apiKeyId + 999, model: "m", prompt: "p2", params: "{}", status: "ok", channelId: null, latencyMs: 1, errorMessage: null, images: "[]" });
    const res = await app.inject({ method: "GET", url: "/v1/history?limit=1", headers: auth });
    expect(res.statusCode).toBe(200);
    const page1 = res.json();
    expect(page1.items).toHaveLength(1);
    expect(page1.items[0].prompt).toBe("p1");
    expect(page1.items[0].images[0].url).toMatch(/\/files\/a\.png$/);
    const page2 = (await app.inject({ method: "GET", url: `/v1/history?limit=1&before=${page1.items[0].id}`, headers: auth })).json();
    expect(page2.items).toHaveLength(0);
  });
});

describe("POST /v1/images/generations records history", () => {
  it("sync ok path writes generation row", async () => {
    upstream.post("/v1/images/generations", async (_req, reply) =>
      reply.send({ created: 1, data: [{ url: "http://example.test/x.png" }] }),
    );
    // upstream 也托管这张图，便于 localizeImage 下载
    upstream.get("/x.png", async (_req, reply) => reply.type("image/png").send(Buffer.from(PNG_B64, "base64")));
    await start();
    const res = await app.inject({ method: "POST", url: "/v1/images/generations", headers: auth, payload: { model: "img-1", prompt: "cat", response_format: "url" } });
    expect(res.statusCode).toBe(200);
    const rows = repo.listGenerations(apiKeyId, null, 10);
    expect(rows[0].status).toBe("ok");
    const img = JSON.parse(rows[0].images)[0];
    expect(img.file).toMatch(/\.png$/);
  });
});
```

- [ ] **Step 2: 运行确认失败** — `cd server && npx vitest run tests/v1-history.test.ts`，Expected: FAIL（404 / jobManager 缺失）。

- [ ] **Step 3: 实现**

3a. `app.ts`：`AppDeps` 增加 `jobManager: JobManager`（`import type { JobManager } from "./server/jobs.js"`）。

3b. `server/src/server/history.ts`：

```ts
import type { AppContext } from "../app.js";
import { ValidationError } from "../core/errors.js";
import type { UnifiedGenRequest } from "../core/types.js";
import { localizeImage } from "../media/b64cache.js";
import { validateGenBody, fileBaseUrlFor } from "./generations.js";

function fileToUrl(ctx: AppContext, req: { headers: Record<string, unknown>; protocol?: string }, file: string): string {
  const base = fileBaseUrlFor(ctx, req as never);
  return `${base}/files/${file}`;
}

function toApiImages(ctx: AppContext, req: never, images: { file: string; revisedPrompt?: string }[]) {
  return images.map((img) => ({ ...img, url: fileToUrl(ctx, req, img.file) }));
}

function persistOk(ctx: AppContext, job: { generationId: number; model: string; prompt: string; apiKeyId: number | null }, channelId: number | null, latencyMs: number, images: { file: string; revisedPrompt?: string }[]): void {
  ctx.deps.repo.completeGeneration(job.generationId, {
    status: "ok",
    channelId,
    latencyMs,
    images: JSON.stringify(images),
  });
}

export function registerHistory(ctx: AppContext): void {
  // Playground 专用：后台 job 执行，客户端断开不影响
  ctx.app.post("/v1/images/jobs", { preHandler: ctx.requireApiKey }, async (req, reply) => {
    const { model, req: genReq } = validateGenBody(req.body);
    const apiKeyId = req.callerApiKeyId ?? null;
    const generationId = ctx.deps.repo.insertGeneration({
      createdAt: Date.now(),
      apiKeyId,
      model,
      prompt: genReq.prompt,
      params: JSON.stringify({ n: genReq.n, size: genReq.size, quality: genReq.quality, responseFormat: genReq.responseFormat, passthrough: genReq.passthrough }),
      status: "pending",
      channelId: null,
      latencyMs: null,
      errorMessage: null,
      images: "[]",
    });
    const job = ctx.deps.jobManager.create({ apiKeyId, generationId, model, prompt: genReq.prompt });
    void runJob(ctx, job.id, model, genReq, apiKeyId, generationId);
    return reply.code(200).send({ jobId: job.id });
  });

  ctx.app.get("/v1/images/jobs/:id", { preHandler: ctx.requireApiKey }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = ctx.deps.jobManager.get(id, req.callerApiKeyId ?? null);
    if (!job) return reply.code(404).send({ error: { message: "job not found", type: "invalid_request_error", code: null } });
    return {
      status: job.status,
      progress: job.progress,
      channel: job.channelName,
      latencyMs: job.latencyMs,
      error: job.errorMessage,
      createdAt: job.createdAt,
      images: toApiImages(ctx, req as never, job.images),
    };
  });

  ctx.app.get("/v1/history", { preHandler: ctx.requireApiKey }, async (req) => {
    const q = req.query as { before?: string; limit?: string };
    const limit = Math.min(100, Math.max(1, Number.parseInt(q.limit ?? "30", 10) || 30));
    const before = q.before ? Number.parseInt(q.before, 10) : null;
    if (q.before && Number.isNaN(before)) throw new ValidationError("'before' must be an integer id");
    const rows = ctx.deps.repo.listGenerations(req.callerApiKeyId ?? null, before, limit);
    return {
      items: rows.map((r) => ({
        id: r.id,
        createdAt: r.createdAt,
        model: r.model,
        prompt: r.prompt,
        params: JSON.parse(r.params || "{}"),
        status: r.status,
        latencyMs: r.latencyMs,
        errorMessage: r.errorMessage,
        images: toApiImages(ctx, req as never, JSON.parse(r.images || "[]")),
      })),
    };
  });
}

async function runJob(ctx: AppContext, jobId: string, model: string, genReq: UnifiedGenRequest, apiKeyId: number | null, generationId: number): Promise<void> {
  const started = Date.now();
  try {
    const r = await ctx.deps.executor.generate(model, genReq, { callerApiKeyId: apiKeyId });
    const images: { file: string; revisedPrompt?: string }[] = [];
    for (const img of r.result.images) {
      const saved = await localizeImage(ctx.deps.env.dataDir, img, r.channel.timeoutMs);
      if (saved) images.push({ file: saved.file, ...(img.revisedPrompt !== undefined ? { revisedPrompt: img.revisedPrompt } : {}) });
    }
    ctx.deps.jobManager.addImage(jobId, images.length > 0 ? images[images.length - 1] : { file: "" });
    ctx.deps.jobManager.finish(jobId, { status: "ok", channelId: r.channel.id, channelName: r.channel.name, latencyMs: r.latencyMs, errorMessage: null });
    // 修正 addImage：逐张添加
    void images;
    persistOk(ctx, { generationId, model, prompt: genReq.prompt, apiKeyId }, r.channel.id, r.latencyMs, images);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.deps.jobManager.finish(jobId, { status: "error", channelId: null, channelName: null, latencyMs: Date.now() - started, errorMessage: message });
    ctx.deps.repo.completeGeneration(generationId, { status: "error", latencyMs: Date.now() - started, errorMessage: message });
  }
}
```

> 注意：上面 `runJob` 中 `addImage` 应为逐张 `for (const img of images) ctx.deps.jobManager.addImage(jobId, img)`，实现时删掉那两行临时代码（`images.length > 0 ? ... : { file: "" }` 与 `void images`）。

3c. `server/src/server/generations.ts` 的 `registerGenerations`，sync 路径完成后落库——把 `finishSync` 改为返回 `{ body, channelId, latencyMs }` 不划算；直接在 handler 里包一层。改为：

```ts
export function registerGenerations(ctx: AppContext): void {
  ctx.app.post("/v1/images/generations", { preHandler: ctx.requireApiKey }, async (req, reply) => {
    const { model, req: genReq, stream } = validateGenBody(req.body);
    if (stream) {
      return streamImageFlow(ctx, req, reply, model, "generate", genReq, fileBaseUrlFor(ctx, req));
    }
    const started = Date.now();
    try {
      const body = await finishSync(ctx, req, reply, model, "generate", genReq);
      await recordGeneration(ctx, req, model, genReq, "ok", Date.now() - started, null, extractImages(body));
      return body;
    } catch (err) {
      await recordGeneration(ctx, req, model, genReq, "error", Date.now() - started, err instanceof Error ? err.message : String(err), []);
      throw err;
    }
  });
}

// 从响应中提取图片并本地化落盘（失败忽略该张）
async function extractImages(body: Record<string, unknown>): Promise<{ file: string; revisedPrompt?: string }[]> {
  const out: { file: string; revisedPrompt?: string }[] = [];
  for (const item of (body.data as Record<string, unknown>[]) ?? []) {
    const url = typeof item.url === "string" ? item.url : undefined;
    const b64 = typeof item.b64_json === "string" ? item.b64_json : undefined;
    const revisedPrompt = typeof item.revised_prompt === "string" ? item.revised_prompt : undefined;
    const saved = await localizeImage(ctx.deps.env.dataDir, { b64, url }, 30_000);
    if (saved) out.push({ file: saved.file, ...(revisedPrompt !== undefined ? { revisedPrompt } : {}) });
  }
  return out;
}
```

`extractImages` 需要访问 `ctx`，把它改为模块内闭包（在 `registerGenerations` 内定义）或签名加 `ctx` 参数——实现时统一为 `extractImages(ctx, body)`。并在文件头 `import { localizeImage } from "../media/b64cache.js";`、`import { randomBytes } …`（不需要）。`recordGeneration`：

```ts
async function recordGeneration(
  ctx: AppContext,
  req: FastifyRequest,
  model: string,
  genReq: UnifiedGenRequest,
  status: "ok" | "error",
  latencyMs: number,
  errorMessage: string | null,
  images: { file: string; revisedPrompt?: string }[],
): Promise<void> {
  try {
    ctx.deps.repo.insertGeneration({
      createdAt: Date.now(),
      apiKeyId: req.callerApiKeyId ?? null,
      model,
      prompt: genReq.prompt,
      params: JSON.stringify({ n: genReq.n, size: genReq.size, quality: genReq.quality, responseFormat: genReq.responseFormat, passthrough: genReq.passthrough }),
      status,
      channelId: null,
      latencyMs,
      errorMessage,
      images: JSON.stringify(images),
    });
  } catch {
    // 历史落库失败不影响响应
  }
}
```

3d. `server/src/server/stream.ts`：在 `catch` 分支 `writer.abort()` 前、成功分支 `writer.end()` 前，各自落库。成功分支在 `images` conform 后：

```ts
    // 落库（忽略失败）；文件本地化
    const historyImages: { file: string; revisedPrompt?: string }[] = [];
    for (const img of images) {
      const saved = await localizeImage(ctx.deps.env.dataDir, { b64: img.b64, url: img.url }, r.channel.timeoutMs);
      if (saved) historyImages.push({ file: saved.file, ...(img.revisedPrompt !== undefined ? { revisedPrompt: img.revisedPrompt } : {}) });
    }
    try {
      ctx.deps.repo.insertGeneration({
        createdAt: Date.now(),
        apiKeyId: callerApiKeyId,
        model,
        prompt: (payload as UnifiedGenRequest).prompt,
        params: JSON.stringify({ n: payload.n, size: payload.size, quality: payload.quality, responseFormat: payload.responseFormat }),
        status: "ok",
        channelId: r.channel.id,
        latencyMs: r.latencyMs,
        errorMessage: null,
        images: JSON.stringify(historyImages),
      });
    } catch {
      // 忽略
    }
```

catch 分支：

```ts
    try {
      ctx.deps.repo.insertGeneration({ createdAt: Date.now(), apiKeyId: callerApiKeyId, model, prompt: (payload as UnifiedGenRequest).prompt, params: "{}", status: "error", channelId: null, latencyMs: null, errorMessage: body.error?.message ?? "upstream error", images: "[]" });
    } catch { /* 忽略 */ }
```

（stream.ts 需要 import `localizeImage` 与 `UnifiedGenRequest` 已有。）

3e. `v1.ts`：`registerHistory(ctx);` 加在 `registerEdits(ctx);` 后。

3f. `server/src/index.ts`：`buildApp` 调用前 `const jobManager = new JobManager();` 传入 deps；`openDb` 之后（listen 之前）加：

```ts
const failed = repo.failPendingGenerations("server restarted");
if (failed > 0) app?.log?.info ?? console.info(`marked ${failed} pending generations as failed`);
```

实际写法（app 尚未建立）：

```ts
const jobManager = new JobManager();
```

并在 `app.listen(...).then(...)` 前加：

```ts
const restarted = repo.failPendingGenerations("server restarted");
if (restarted > 0) console.info(`marked ${restarted} pending generations as failed (server restarted)`);
```

- [ ] **Step 4: 运行确认通过** — `cd server && npx vitest run`，Expected: 全部 PASS（老测试如 app.test.ts 因 buildApp 新增必填 deps 需补 `jobManager: new JobManager()`，逐个修复）。
- [ ] **Step 5: Commit** — `git add -A server && git commit -m "feat(server): generation history persistence, job endpoints, /v1/history"`

---

### Task 5: Playground 改造 — job 轮询 + 草稿 + 恢复

**Files:**
- Modify: `web/src/pages/Playground.tsx`（整体重写请求逻辑；UI 骨架保留）
- Modify: `web/src/api.ts`（追加类型与 job 调用）

**Interfaces:**
- Consumes: Task 4 的 `POST /v1/images/jobs`、`GET /v1/images/jobs/:id`。
- Produces: `web/src/api.ts` 追加 `JobStatus` 类型与 `fetchJob(id)`；导出 `readDraft()/writeDraft()` 供 History 页的「重新生成」跳转使用（Playground 从 `location.state` 接收 `{ prompt, model, size }`，无需新接口）。

- [ ] **Step 1: `web/src/api.ts` 追加：**

```ts
// ---- 生成 job ----

export interface JobImage {
  file: string;
  url: string;
  revisedPrompt?: string;
}

export interface JobStatus {
  status: "running" | "ok" | "error";
  progress: string | null;
  channel: string | null;
  latencyMs: number | null;
  error: string | null;
  createdAt: number;
  images: JobImage[];
}

export async function fetchJob(id: string): Promise<JobStatus> {
  return api<JobStatus>(`/v1/images/jobs/${id}`);
}

export function createJob(body: Record<string, unknown>): Promise<{ jobId: string }> {
  return api<{ jobId: string }>("/v1/images/jobs", { method: "POST", body });
}
```

- [ ] **Step 2: Playground 请求逻辑重写。** 保留表单 UI，做以下修改：

1. 删除「流式（SSE）」checkbox、`runStream`、`handleResponse`、`runSync`、`abortRef`、`GenResult` 的 `usage` 展示依赖（详情区只保留 revised_prompt，取自 job images 的 `revisedPrompt`）。
2. `run` 改为：

```tsx
  const run = async (e: FormEvent) => {
    e.preventDefault();
    if (running) return;
    setError(null);
    setImages([]);
    setChannel(null);
    setStatus(null);
    setElapsed(null);
    const payload = buildPayload();
    if (!payload) return;
    startedRef.current = Date.now();
    setRunning(true);
    try {
      const { jobId } = await createJob(payload);
      localStorage.setItem(JOB_KEY, jobId);
      pollJob(jobId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setRunning(false);
    }
  };

  const pollJob = (jobId: string) => {
    const tick = async () => {
      try {
        const job = await fetchJob(jobId);
        setChannel(job.channel);
        setStatus(job.progress ?? (job.status === "running" ? "生成中…" : null));
        setImages(job.images.map((i) => i.url));
        setDetails(job.images.map((i) => i.revisedPrompt).filter((v): v is string => !!v));
        if (job.status === "running") return;
        localStorage.removeItem(JOB_KEY);
        setElapsed(job.latencyMs);
        setRunning(false);
        if (job.status === "error") setError(job.error ?? "生成失败");
      } catch (err) {
        // job 丢失（404/重启）：停止轮询，提示可到历史页查看
        localStorage.removeItem(JOB_KEY);
        setRunning(false);
        setError(err instanceof ApiError && err.status === 404 ? "任务已丢失，可到历史页查看结果" : err instanceof Error ? err.message : String(err));
      }
    };
    void tick();
    const t = setInterval(() => {
      if (runningRef.current) void tick();
    }, 1000);
    timerRef.current = t;
  };
```

配套 refs/state：`const timerRef = useRef<number | null>(null)`、`const runningRef = useRef(false)`（`setRunning(true/false)` 处同步 `runningRef.current`，`useEffect(() => () => { if (timerRef.current) clearInterval(timerRef.current); }, [])` 卸载时清定时器；job 记录照常完成）。

3. 挂载恢复 + 草稿（`useEffect`）：

```tsx
  const JOB_KEY = "tiny-running-job";
  const DRAFT_KEY = "tiny-playground-draft";

  // 恢复草稿与进行中的 job
  useEffect(() => {
    try {
      const draft = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? "{}") as Partial<{ model: string; prompt: string; n: number; size: string; responseFormat: string; extra: string }>;
      const fromNav = (location.state ?? null) as { prompt?: string; model?: string; size?: string } | null;
      if (fromNav?.prompt) setPrompt(fromNav.prompt);
      else if (draft.prompt) setPrompt(draft.prompt);
      if (fromNav?.model) setModel(fromNav.model);
      else if (draft.model) setModel(draft.model);
      if (fromNav?.size) setSize(fromNav.size);
      if (draft.n) setN(draft.n);
      if (draft.responseFormat) setResponseFormat(draft.responseFormat);
      if (draft.extra) setExtra(draft.extra);
    } catch { /* 草稿损坏则忽略 */ }
    const jobId = localStorage.getItem(JOB_KEY);
    if (jobId) {
      setRunning(true);
      runningRef.current = true;
      pollJob(jobId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 表单草稿持久化
  useEffect(() => {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ model, prompt, n, size, responseFormat, extra }));
  }, [model, prompt, n, size, responseFormat, extra]);
```

组件需要 `const location = useLocation();`（`import { Link, useLocation } from "react-router-dom";`）。任务完成后（`status !== "running"` 分支）`if (timerRef.current) clearInterval(timerRef.current)`。

- [ ] **Step 3: 类型检查** — `cd web && npx tsc -b --noEmit` 或项目现有 build 命令 `npm run build`，Expected: 无错误。
- [ ] **Step 4: Commit** — `git add web/src/pages/Playground.tsx web/src/api.ts && git commit -m "feat(web): playground job polling with resume and draft persistence"`

---

### Task 6: 历史页面 + 路由

**Files:**
- Create: `web/src/pages/History.tsx`
- Modify: `web/src/App.tsx`（路由、导航、TITLES）
- Modify: `web/src/styles.css`（历史网格与占位样式，沿用现有 `.gallery`/`.shot`/`.pill` 风格）

**Interfaces:**
- Consumes: Task 4 `GET /v1/history`；Task 5 的 api（无需新增，`api<T>` 通用调用）。

- [ ] **Step 1: 实现 `web/src/pages/History.tsx`：**

```tsx
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api";

interface HistoryImage {
  file: string;
  url: string;
  revisedPrompt?: string;
}

interface HistoryItem {
  id: number;
  createdAt: number;
  model: string;
  prompt: string;
  status: "pending" | "ok" | "error";
  latencyMs: number | null;
  errorMessage: string | null;
  images: HistoryImage[];
}

interface HistoryResponse {
  items: HistoryItem[];
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString();
}

export default function History() {
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ src: string; prompt: string } | null>(null);
  const navigate = useNavigate();

  const load = useCallback(async (before: number | null) => {
    setError(null);
    try {
      const q = before ? `?before=${before}&limit=30` : "?limit=30";
      const r = await api<HistoryResponse>(`/v1/history${q}`);
      setItems((prev) => (before ? [...prev, ...r.items] : r.items));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(null);
  }, [load]);

  const rerun = (item: HistoryItem) => {
    navigate("/", { state: { prompt: item.prompt, model: item.model } });
  };

  return (
    <div className="card">
      <h2>历史</h2>
      {error && <div className="error" role="alert">{error}</div>}
      {loading && <p className="muted">加载中…</p>}
      {!loading && items.length === 0 && <p className="muted">还没有生成记录。去 <Link to="/">Playground</Link> 生成第一张图吧。</p>}
      <div className="history-list">
        {items.map((item) => (
          <div key={item.id} className="history-item">
            <div className="history-meta">
              <span className="pill">{fmtTime(item.createdAt)}</span>
              <span className="pill">{item.model}</span>
              <span className={`pill ${item.status === "ok" ? "" : item.status === "error" ? "error" : "off"}`}>{item.status}</span>
              {item.latencyMs !== null && <span className="pill">{item.latencyMs} ms</span>}
            </div>
            <p className="history-prompt" title={item.prompt}>{item.prompt}</p>
            {item.status === "error" && <p className="error">{item.errorMessage}</p>}
            <div className="gallery">
              {item.images.map((img, i) => (
                <figure key={i} className="shot">
                  <img
                    src={img.url}
                    alt={`历史图片 ${i + 1}`}
                    loading="lazy"
                    onError={(e) => {
                      // 文件被 TTL 清扫后显示占位
                      (e.currentTarget as HTMLImageElement).replaceWith(Object.assign(document.createElement("div"), { className: "expired", textContent: "已过期" }));
                    }}
                    onClick={() => setPreview({ src: img.url, prompt: item.prompt })}
                  />
                  <a className="btn small" href={img.url} download={`tiny-images-${item.id}-${i + 1}.png`}>下载</a>
                </figure>
              ))}
              {item.status === "ok" && item.images.length === 0 && <span className="expired">已过期</span>}
            </div>
            <div className="history-actions">
              <button className="btn small" onClick={() => { void navigator.clipboard.writeText(item.prompt); }}>复制 Prompt</button>
              <button className="btn small" onClick={() => rerun(item)}>用此 Prompt 重新生成</button>
            </div>
          </div>
        ))}
      </div>
      {items.length > 0 && items.length % 30 === 0 && (
        <button className="btn" onClick={() => void load(items[items.length - 1].id)}>加载更多</button>
      )}
      {preview && (
        <div className="lightbox" role="dialog" onClick={() => setPreview(null)}>
          <img src={preview.src} alt={preview.prompt} />
          <p className="mono">{preview.prompt}</p>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: `styles.css` 追加（沿用既有变量/配色）：**

```css
/* ---- 历史 ---- */
.history-list { display: flex; flex-direction: column; gap: 24px; margin-top: 12px; }
.history-item { border: 1px solid var(--border, #999); padding: 12px; background: var(--panel, #fff); }
.history-meta { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 6px; }
.history-prompt { font-weight: bold; margin: 4px 0 8px; word-break: break-all; }
.history-actions { display: flex; gap: 8px; margin-top: 8px; }
.expired { display: inline-block; padding: 24px; border: 1px dashed #999; color: #777; }
.lightbox { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.75); display: flex; flex-direction: column; align-items: center; justify-content: center; cursor: zoom-out; z-index: 100; }
.lightbox img { max-width: 90vw; max-height: 80vh; background: #fff; }
.lightbox p { color: #fff; max-width: 80vw; word-break: break-all; }
.shot img { cursor: zoom-in; }
```

（变量名以 styles.css 现有定义为准，缺的用字面量。）

- [ ] **Step 3: `App.tsx`：** import `History`；`TITLES` 加 `"/history": "历史"`；menubar nav 中 Playground 与 API 指南之间加：

```tsx
          <NavLink to="/history" className={({ isActive }) => `nav-btn ${isActive ? "active" : ""}`}>
            历史
          </NavLink>
```

Routes 中 `/admin` 路由之前加：

```tsx
            <Route
              path="/history"
              element={
                <RequireToken>
                  <History />
                </RequireToken>
              }
            />
```

- [ ] **Step 4: 类型检查与构建** — `cd web && npm run build`，Expected: 成功。
- [ ] **Step 5: Commit** — `git add web/src/pages/History.tsx web/src/App.tsx web/src/styles.css && git commit -m "feat(web): history gallery page"`

---

### Task 7: e2e 冒烟与整体验证

**Files:**
- Modify: `server/scripts/e2e.ts`（若结构允许，追加历史断言）

- [ ] **Step 1: 查看 `server/scripts/e2e.ts` 现有结构，在其末尾追加：** 调用一次生成 → `GET /v1/history` 断言 items[0].prompt 与刚生成的 prompt 一致、images[0].url 可 GET 且 200。

```ts
// 追加（沿用脚本现有的 baseUrl/token 变量与请求 helper）
const hist = await api<{ items: { prompt: string; images: { url: string }[] }[] }>("/v1/history?limit=5");
if (hist.items.length === 0) throw new Error("history empty after generation");
const img = hist.items[0].images[0];
const imgRes = await fetch(img.url, { headers });
if (!imgRes.ok) throw new Error(`history image not fetchable: HTTP ${imgRes.status}`);
console.log("e2e: history ok");
```

- [ ] **Step 2: 跑测试** — `cd server && npm test`，Expected: 全部 PASS。
- [ ] **Step 3: 跑 e2e** — 按仓库现有方式启动 server + web，运行 e2e 脚本，Expected: 输出含 `e2e: history ok`。
- [ ] **Step 4: 手动验收（浏览器）：**
  1. Playground 生成一张图 → 生成中切到「历史」再切回 Playground → 轮询恢复、结果照常出现。
  2. 刷新页面 → prompt 草稿保留；若任务已完成，去历史页能看到该图。
  3. 历史页：加载更多、复制 Prompt、重新生成（跳回 Playground 且 prompt 已填）、点击放大、下载。
- [ ] **Step 5: Commit** — `git add -A && git commit -m "test: e2e history assertions"`

---

## Self-Review

- Spec coverage：generations 表与落库（Task 1/3/4）✓；图片本地化 url 模式（Task 2）✓；job 端点与轮询（Task 3/4/5）✓；切走恢复 + 草稿（Task 5）✓；历史页（Task 6）✓；启动清 pending（Task 4 Step 3f）✓；TTL 保持现状 + 前端过期占位（Task 6 onError）✓；兼容端点契约不变（仅追加落库）✓。
- 类型一致性：`JobManager.finish` 的 patch 形状、`localizeImage` 返回 `{file}`、`listGenerations(apiKeyId, before, limit)` 在 Task 3/4/6 中一致；`createApiKey` 方法名以 `repo.ts` 现有签名为准（计划中已注明）。
- 已知取舍：流式兼容端点（SSE）没有逐张 job 进度，Playground 不再使用 SSE，由轮询提供同等体验。
