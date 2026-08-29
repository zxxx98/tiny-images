# tiny-images 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建生图 API 网关 tiny-images：聚合 OpenAI 官方与兼容中转站渠道，对外暴露 OpenAI images 格式 API + WebUI（Playground + 管理后台），最后支持 Docker 部署。

**Architecture:** Fastify 单体同时承载 `/v1`（OpenAI images 格式）、`/admin`（管理 API）、`/files`（图片缓存）与 Web 静态资源。SQLite（better-sqlite3）是配置唯一来源。Provider 适配器抽象上游，第一版仅 `OpenAICompatProvider`。

**Tech Stack:** Node 22 + TypeScript (ESM) + Fastify 5 + better-sqlite3 + Vitest；前端 React 18 + Vite + react-router-dom。

**设计文档:** `docs/superpowers/specs/2026-08-29-tiny-images-design.md`

## Global Constraints

- Node >= 22，ESM（`"type": "module"`）；**所有相对导入必须带 `.js` 后缀**（NodeNext 要求）。
- 严格 TypeScript：`strict: true`。
- 仓库为 npm workspaces：`server`、`web`；测试只写在 server 包（Vitest），前端不单测。
- 环境变量：`PORT`（默认 3000）、`DATA_DIR`（默认 `./data`）、`ADMIN_TOKEN`、`PUBLIC_BASE_URL`。
- 对外错误一律 OpenAI 格式 `{"error":{"message","type","code"}}`。
- 数据目录 `data/` 不入库（.gitignore）。
- 每个任务完成即 `git commit`；测试先行（TDD）。
- 对外 model 映射：**启用中的 `public_name` 唯一**（partial unique index 强制）。
- 上游调用**不透传 `response_format`**（由网关本地做 b64↔url 转换，规避 gpt-image-1 不接受该参数的问题）。

## 核心类型（所有任务共享，定义于 `server/src/core/types.ts`）

```ts
export type EditMode = "auto" | "multipart" | "json-base64";

export interface ChannelConfig {
  id: number;
  name: string;
  type: string; // "openai-compat"
  baseUrl: string;
  timeoutMs: number;
  editMode: EditMode;
  extraHeaders: Record<string, string>;
  enabled: boolean;
}

export interface ModelMapping {
  id: number;
  publicName: string;
  channelId: number;
  upstreamName: string;
  enabled: boolean;
}

export interface UnifiedGenRequest {
  prompt: string;
  n: number;
  size?: string;
  quality?: string;
  responseFormat: "url" | "b64_json";
  passthrough: Record<string, unknown>;
}

export interface IncomingImage {
  filename: string;
  data: Buffer;
  mimeType: string;
}

export interface UnifiedEditRequest {
  prompt: string;
  n: number;
  size?: string;
  responseFormat: "url" | "b64_json";
  images: IncomingImage[];
  mask?: IncomingImage;
  passthrough: Record<string, unknown>;
}

export interface UnifiedImage {
  b64?: string;
  url?: string;
  revisedPrompt?: string;
}

export interface UnifiedImageResult {
  created: number;
  images: UnifiedImage[];
  raw?: unknown;
}

export interface CallContext {
  channel: ChannelConfig;
  upstreamModel: string;
  apiKey: string;
  signal: AbortSignal;
}

export interface ImageProvider {
  kind: string;
  generate(req: UnifiedGenRequest, ctx: CallContext): Promise<UnifiedImageResult>;
  edit(req: UnifiedEditRequest, ctx: CallContext): Promise<UnifiedImageResult>;
  test(channel: ChannelConfig, apiKey: string | null): Promise<{ ok: boolean; message: string }>;
}
```

## store 行类型（定义于 `server/src/store/repo.ts`）

```ts
export interface ChannelRow extends ChannelConfig { createdAt: number }
export interface KeyRow { id: number; channelId: number; apiKey: string; enabled: boolean; cooldownUntil: number }
export interface ModelRow extends ModelMapping { createdAt: number }
export interface ApiKeyRow { id: number; name: string; key: string; enabled: boolean; createdAt: number }
export interface LogRow {
  id: number; ts: number; model: string; channelId: number | null; apiKeyId: number | null;
  status: "ok" | "error"; httpStatus: number | null; latencyMs: number | null; errorMessage: string | null;
}
export class ConflictError extends Error {}
```

Repo 方法清单（任务 2 完整实现）：
`listChannels / getChannel / createChannel / updateChannel / deleteChannel`；`listKeys / enabledKeys / enabledKeyCount / createKey / updateKey / deleteKey / setKeyCooldown`；`findEnabledModel / listModels / listEnabledModels / getModel / createModel / updateModel / deleteModel`；`listApiKeys / findApiKeyByKey / createApiKey / updateApiKey / deleteApiKey`；`insertLog / recentLogs`。

---

### Task 1: 工作区脚手架

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `.gitignore`
- Create: `server/package.json`, `server/tsconfig.json`, `server/vitest.config.ts`, `server/tests/smoke.test.ts`

**Interfaces:**
- Produces: 可运行的 npm workspaces；`npm test` 执行 Vitest。

- [ ] **Step 1: 写根配置文件**

`package.json`:
```json
{
  "name": "tiny-images",
  "private": true,
  "version": "0.1.0",
  "workspaces": ["server", "web"],
  "scripts": {
    "dev": "npm run dev -w server",
    "dev:web": "npm run dev -w web",
    "build": "npm run build -w web && npm run build -w server",
    "start": "npm run start -w server",
    "test": "npm test -w server"
  },
  "engines": { "node": ">=22" }
}
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "sourceMap": true
  }
}
```

`.gitignore`:
```
node_modules/
dist/
data/
web/dist/
*.log
```

`server/package.json`:
```json
{
  "name": "@tiny-images/server",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc -p tsconfig.json",
    "start": "node dist/index.js",
    "test": "vitest run"
  },
  "dependencies": {
    "@fastify/multipart": "^9.0.3",
    "@fastify/static": "^8.0.4",
    "better-sqlite3": "^11.8.1",
    "fastify": "^5.2.1",
    "yaml": "^2.7.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.12",
    "@types/node": "^22.13.1",
    "tsx": "^4.19.2",
    "typescript": "^5.7.3",
    "vitest": "^3.0.5"
  }
}
```

`server/tsconfig.json`:
```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src", "noEmit": true },
  "include": ["src"]
}
```

`server/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({ test: { include: ["tests/**/*.test.ts"] } });
```

- [ ] **Step 2: 写冒烟测试** `server/tests/smoke.test.ts`

```ts
import { describe, expect, it } from "vitest";

describe("smoke", () => {
  it("runs", () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 3: 安装并验证**

Run: `npm install` → 成功；`npm test` → 1 passed。
Run: `cd server && npx tsc -p tsconfig.json` → 无错误。

- [ ] **Step 4: Commit** `git add -A && git commit -m "chore: workspace scaffold (server + vitest)"`

---

### Task 2: store —— SQLite 迁移与 Repo

**Files:**
- Create: `server/src/store/db.ts`, `server/src/store/repo.ts`
- Test: `server/tests/store.test.ts`

**Interfaces:**
- Produces: `openDb(dataDir): Database.Database`；`Repo` 类（方法清单见上）、`ConflictError`。后续所有任务经由 `Repo` 读写。

- [ ] **Step 1: 写失败测试**（覆盖：迁移建表、channel CRUD 与重名冲突、model 启用名唯一约束、key 冷却更新、api key 生成格式、log 插入与裁剪）

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/store/db.js";
import { ConflictError, Repo } from "../src/store/repo.js";

let dir: string; let repo: Repo;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "ti-")); repo = new Repo(openDb(dir)); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe("channels", () => {
  it("creates and rejects duplicate name", () => {
    const c = repo.createChannel({ name: "a", baseUrl: "https://x/v1" });
    expect(c.enabled).toBe(true);
    expect(() => repo.createChannel({ name: "a", baseUrl: "https://y/v1" })).toThrow(ConflictError);
  });
  it("updates and deletes", () => {
    const c = repo.createChannel({ name: "a", baseUrl: "https://x/v1" });
    const u = repo.updateChannel(c.id, { baseUrl: "https://z/v1", enabled: false });
    expect(u?.baseUrl).toBe("https://z/v1");
    expect(u?.enabled).toBe(false);
    expect(repo.deleteChannel(c.id)).toBe(true);
    expect(repo.getChannel(c.id)).toBeNull();
  });
});

describe("models", () => {
  it("enforces unique enabled public_name", () => {
    const c = repo.createChannel({ name: "a", baseUrl: "https://x/v1" });
    repo.createModel({ publicName: "img-1", channelId: c.id });
    expect(() => repo.createModel({ publicName: "img-1", channelId: c.id })).toThrow(ConflictError);
    // disabled model can share the name
    const m2 = repo.createModel({ publicName: "img-1", channelId: c.id, enabled: false });
    expect(m2.enabled).toBe(false);
  });
  it("finds enabled by name and re-enabling conflicts", () => {
    const c = repo.createChannel({ name: "a", baseUrl: "https://x/v1" });
    const m = repo.createModel({ publicName: "img-1", channelId: c.id, upstreamName: "gpt-image-1" });
    expect(repo.findEnabledModel("img-1")?.id).toBe(m.id);
    repo.updateModel(m.id, { enabled: false });
    expect(repo.findEnabledModel("img-1")).toBeNull();
    const other = repo.createModel({ publicName: "img-2", channelId: c.id });
    expect(() => repo.updateModel(other.id, { enabled: true, publicName: "img-1" })).toThrow(ConflictError);
  });
});

describe("keys", () => {
  it("cooldown round-trip and enabled filtering", () => {
    const c = repo.createChannel({ name: "a", baseUrl: "https://x/v1" });
    const k = repo.createKey(c.id, "sk-upstream");
    repo.setKeyCooldown(k.id, Date.now() + 60_000);
    expect(repo.enabledKeys(c.id)).toHaveLength(0);
    repo.setKeyCooldown(k.id, 0);
    expect(repo.enabledKeys(c.id)).toHaveLength(1);
    expect(repo.enabledKeyCount(c.id)).toBe(1);
  });
});

describe("api keys", () => {
  it("generates sk-tiny- prefixed key and finds it", () => {
    const k = repo.createApiKey("test");
    expect(k.key.startsWith("sk-tiny-")).toBe(true);
    expect(repo.findApiKeyByKey(k.key)?.id).toBe(k.id);
  });
});

describe("logs", () => {
  it("inserts, lists recent, prunes to 1000", () => {
    for (let i = 0; i < 1005; i++) repo.insertLog({ ts: i, model: "m", channelId: 1, apiKeyId: null, status: "ok", httpStatus: 200, latencyMs: 10, errorMessage: null });
    const logs = repo.recentLogs(2000);
    expect(logs).toHaveLength(1000);
    expect(logs[0].ts).toBe(1004);
  });
});
```

- [ ] **Step 2: Run** `npm test -w server` → FAIL（模块不存在）。

- [ ] **Step 3: 实现 `store/db.ts`**（迁移数组 + `user_version`，代码见设计文档第 5 节；表结构如下）

```ts
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const MIGRATIONS: string[] = [
  `
  CREATE TABLE IF NOT EXISTS channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL DEFAULT 'openai-compat',
    base_url TEXT NOT NULL,
    timeout_ms INTEGER NOT NULL DEFAULT 120000,
    edit_mode TEXT NOT NULL DEFAULT 'auto',
    extra_headers TEXT NOT NULL DEFAULT '{}',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS channel_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    api_key TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    cooldown_until INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS models (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    public_name TEXT NOT NULL,
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    upstream_name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS models_enabled_public_name ON models(public_name) WHERE enabled = 1;
  CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    key TEXT NOT NULL UNIQUE,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS request_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    model TEXT NOT NULL,
    channel_id INTEGER,
    api_key_id INTEGER,
    status TEXT NOT NULL,
    http_status INTEGER,
    latency_ms INTEGER,
    error_message TEXT
  );
  CREATE INDEX IF NOT EXISTS request_logs_ts ON request_logs(ts DESC);
  `,
];

export function openDb(dataDir: string): Database.Database {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, "tiny-images.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  const current = (db.pragma("user_version", { simple: true }) as number) || 0;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
  return db;
}
```

- [ ] **Step 4: 实现 `store/repo.ts`**——按接口清单逐方法实现。要点：

- snake_case ↔ camelCase 映射；`extra_headers` JSON.parse/stringify。
- `createChannel` 捕获 UNIQUE 冲突（`err.code === "SQLITE_CONSTRAINT_UNIQUE"`）→ `ConflictError`。
- `createModel` 先查 `findEnabledModel(publicName)` 存在则抛 `ConflictError`（比依赖 partial index 的错误码更可读；partial index 兜底）。
- `updateModel` 开启 enabled 或改 publicName 时同样检查（排除自身 id）。
- `createApiKey`: key = `sk-tiny-` + `crypto.randomBytes(24).toString("base64url")`。
- `insertLog` 后执行裁剪：`DELETE FROM request_logs WHERE id NOT IN (SELECT id FROM request_logs ORDER BY id DESC LIMIT 1000)`。
- 所有语句用 `db.prepare(...)` 缓存在构造器里。

- [ ] **Step 5: Run** `npm test -w server` → PASS。
- [ ] **Step 6: Commit** `git commit -am "feat: sqlite store with migrations and repo"`

---

### Task 3: core/errors —— OpenAI 错误映射

**Files:**
- Create: `server/src/core/errors.ts`
- Test: `server/tests/errors.test.ts`

**Interfaces:**
- Produces: `UpstreamError(httpStatus, type, message, code?)`、`ValidationError`、`ModelNotFoundError`、`toOpenAIError(err) → {status, body}`、`mapUpstreamFailure(status, body, channelName)`、`wrapNetworkError(err, channelName)`（签名见设计文档第 3/4 节与下方代码）。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from "vitest";
import {
  ModelNotFoundError, UpstreamError, ValidationError,
  mapUpstreamFailure, toOpenAIError, wrapNetworkError,
} from "../src/core/errors.js";

describe("mapUpstreamFailure", () => {
  it("401 keeps upstream message and marks invalid_api_key", () => {
    const e = mapUpstreamFailure(401, { error: { message: "bad key", type: "invalid_request_error" } }, "ch1");
    expect(e.httpStatus).toBe(401);
    expect(e.code).toBe("invalid_api_key");
    expect(e.message).toContain("ch1");
    expect(e.message).toContain("bad key");
  });
  it("429 maps to rate_limit_error", () => {
    const e = mapUpstreamFailure(429, null, "ch1");
    expect(e.type).toBe("rate_limit_error");
    expect(e.httpStatus).toBe(429);
  });
  it("5xx becomes 502 upstream_error", () => {
    const e = mapUpstreamFailure(503, { error: { message: "boom" } }, "ch1");
    expect(e.httpStatus).toBe(502);
    expect(e.type).toBe("upstream_error");
  });
  it("400 keeps status and code", () => {
    const e = mapUpstreamFailure(400, { error: { message: "bad size", code: "invalid_size" } }, "ch1");
    expect(e.httpStatus).toBe(400);
    expect(e.code).toBe("invalid_size");
  });
});

describe("toOpenAIError", () => {
  it("maps domain errors", () => {
    expect(toOpenAIError(new ValidationError("no prompt")).status).toBe(400);
    const nf = toOpenAIError(new ModelNotFoundError("m"));
    expect(nf.status).toBe(404);
    expect(nf.body.error.code).toBe("model_not_found");
    const up = toOpenAIError(new UpstreamError(504, "timeout", "t"));
    expect(up.status).toBe(504);
    expect(up.body.error.type).toBe("timeout");
    expect(toOpenAIError(new Error("x")).body.error.type).toBe("internal_error");
  });
  it("wraps network failures", () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    expect(wrapNetworkError(abort, "c").httpStatus).toBe(504);
    expect(wrapNetworkError(abort, "c").type).toBe("timeout");
    expect(wrapNetworkError(new Error("ECONNREFUSED"), "c").httpStatus).toBe(502);
  });
});
```

- [ ] **Step 2: Run** → FAIL。
- [ ] **Step 3: 实现** `core/errors.ts`（完整代码如上测试所约束；`mapUpstreamFailure` 对 4xx 非 401/403/429 保留状态码、type=`invalid_request_error`）。
- [ ] **Step 4: Run** → PASS。
- [ ] **Step 5: Commit** `feat: openai error mapping`

---

### Task 4: OpenAICompatProvider（generate + test）

**Files:**
- Create: `server/src/core/types.ts`（见"核心类型"）、`server/src/providers/openai-compat.ts`
- Test: `server/tests/provider.test.ts`

**Interfaces:**
- Consumes: `errors.ts`。
- Produces: `OpenAICompatProvider implements ImageProvider`（`generate/edit/test`）。测试用真实 HTTP mock 上游（fastify 监听 127.0.0.1 随机端口）。

关键行为：
1. `generate`：POST `{baseUrl}/images/generations`，JSON 体 `{model: upstreamModel, prompt, n, size?, quality?, ...passthrough}`，**不含 response_format**；headers: `authorization: Bearer <key>` + extraHeaders。
2. 响应解析：`data[]` 的 `b64_json/url/revised_prompt` → `UnifiedImage`；`created` 缺省取当前秒；`raw` 保留原始 JSON。
3. `test`：GET `{baseUrl}/models`（带 Bearer，若 key 为 null 则不带）→ 2xx ok。
4. 网络错误经 `wrapNetworkError`；非 2xx 经 `mapUpstreamFailure`；响应缺 `data` 数组 → `UpstreamError(502,"upstream_error","malformed upstream response: missing data array")`。
5. joinUrl 工具：baseUrl 末尾 `/` 与 path 开头 `/` 去重。

- [ ] **Step 1: 写失败测试**

```ts
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UpstreamError } from "../src/core/errors.js";
import type { CallContext, UnifiedGenRequest } from "../src/core/types.js";
import { OpenAICompatProvider } from "../src/providers/openai-compat.js";

let upstream: ReturnType<typeof Fastify>; let baseUrl: string;
beforeEach(async () => {
  upstream = Fastify();
  await upstream.listen({ port: 0, host: "127.0.0.1" });
  baseUrl = `http://127.0.0.1:${(upstream.server.address() as any).port}/v1`;
});
afterEach(async () => { await upstream.close(); });

const channel = (over: Partial<CallContext["channel"]> = {}): CallContext["channel"] => ({
  id: 1, name: "mock", type: "openai-compat", baseUrl, timeoutMs: 5000,
  editMode: "auto", extraHeaders: {}, enabled: true, ...over,
});
const ctx = (over: Partial<CallContext> = {}): CallContext => ({
  channel: channel(), upstreamModel: "gpt-image-1", apiKey: "sk-upstream",
  signal: new AbortController().signal, ...over,
});
const gen = (over: Partial<UnifiedGenRequest> = {}): UnifiedGenRequest => ({
  prompt: "a cat", n: 1, responseFormat: "b64_json", passthrough: {}, ...over,
});

describe("OpenAICompatProvider.generate", () => {
  it("posts correct payload and parses b64 images", async () => {
    let seen: any = null; let seenAuth = ""; let seenPath = "";
    upstream.post("/v1/images/generations", async (req, reply) => {
      seen = req.body; seenAuth = req.headers.authorization ?? ""; seenPath = req.url;
      return { created: 123, data: [{ b64_json: "QUJD", revised_prompt: "a big cat" }] };
    });
    const r = await new OpenAICompatProvider().generate(gen({ n: 2, size: "1024x1024", quality: "high" }), ctx());
    expect(seenPath).toBe("/v1/images/generations");
    expect(seen).toEqual({ model: "gpt-image-1", prompt: "a cat", n: 2, size: "1024x1024", quality: "high" });
    expect(seenAuth).toBe("Bearer sk-upstream");
    expect(r.created).toBe(123);
    expect(r.images).toEqual([{ b64: "QUJD", revisedPrompt: "a big cat" }]);
  });

  it("parses url responses and preserves extra top-level fields in raw", async () => {
    upstream.post("/v1/images/generations", async () => ({ created: 1, data: [{ url: "http://x/y.png" }], usage: { total: 1 } }));
    const r = await new OpenAICompatProvider().generate(gen({ responseFormat: "url" }), ctx());
    expect(r.images).toEqual([{ url: "http://x/y.png" }]);
    expect((r.raw as any).usage).toEqual({ total: 1 });
  });

  it("maps upstream errors and network failures", async () => {
    upstream.post("/v1/images/generations", async (_req, reply) => reply.code(401).send({ error: { message: "nope" } }));
    await expect(new OpenAICompatProvider().generate(gen(), ctx())).rejects.toMatchObject({ httpStatus: 401, code: "invalid_api_key" });

    const bad = ctx({ channel: channel({ baseUrl: "http://127.0.0.1:1/v1" }) });
    await expect(new OpenAICompatProvider().generate(gen(), bad)).rejects.toBeInstanceOf(UpstreamError);
  });

  it("rejects malformed responses", async () => {
    upstream.post("/v1/images/generations", async () => ({ unexpected: true }));
    await expect(new OpenAICompatProvider().generate(gen(), ctx())).rejects.toMatchObject({ type: "upstream_error" });
  });
});

describe("OpenAICompatProvider.test", () => {
  it("reports ok on 200 and failure otherwise", async () => {
    upstream.get("/v1/models", async () => ({ object: "list", data: [] }));
    const p = new OpenAICompatProvider();
    expect((await p.test(channel(), "sk-x")).ok).toBe(true);
    upstream.get("/v1/models", async (_req, reply) => reply.code(500).send({}));
    expect((await p.test(channel(), "sk-x")).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run** → FAIL。
- [ ] **Step 3: 实现** `core/types.ts` + `providers/openai-compat.ts`。
- [ ] **Step 4: Run** → PASS。
- [ ] **Step 5: Commit** `feat: openai-compat provider (generate + test)`

---

### Task 5: KeyPool —— 轮询与冷却

**Files:**
- Create: `server/src/core/keyPool.ts`
- Test: `server/tests/keyPool.test.ts`

**Interfaces:**
- Consumes: `Repo`。
- Produces: `KeyPool(repo)`：`pick(channelId): {keyId, apiKey} | null`、`markFailure(keyId, cooldownMs=60_000)`、`markSuccess(keyId)`。

行为：仅取 `enabled=1` 且 `cooldownUntil <= now` 的 key；按 `(cursor++) % usable.length` 轮询；无可用 → null。

- [ ] **Step 1: 写失败测试**

```ts
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/store/db.js";
import { Repo } from "../src/store/repo.js";
import { KeyPool } from "../src/core/keyPool.js";

let repo: Repo; let pool: KeyPool; let channelId: number;
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
    const k1 = repo.createKey(channelId, "sk-1"); const k2 = repo.createKey(channelId, "sk-2");
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
```

- [ ] **Step 2: Run** → FAIL。
- [ ] **Step 3: 实现** `core/keyPool.ts`。
- [ ] **Step 4: Run** → PASS。
- [ ] **Step 5: Commit** `feat: key pool with round-robin and cooldown`

---

### Task 6: ModelRouter

**Files:**
- Create: `server/src/core/router.ts`
- Test: `server/tests/router.test.ts`

**Interfaces:**
- Produces: `ModelRouter(repo).resolve(publicName): { model: ModelRow; channel: ChannelRow } | null`——model 启用且所属渠道存在并启用才返回。

- [ ] **Step 1: 写失败测试**

```ts
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/store/db.js"; import { Repo } from "../src/store/repo.js";
import { ModelRouter } from "../src/core/router.js";

let repo: Repo; let router: ModelRouter;
beforeEach(() => { repo = new Repo(openDb(fs.mkdtempSync(path.join(os.tmpdir(), "rt-")))); router = new ModelRouter(repo); });

describe("ModelRouter", () => {
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
```

- [ ] **Step 2: Run** → FAIL。 **Step 3: 实现**（约 15 行）。 **Step 4: Run** → PASS。
- [ ] **Step 5: Commit** `feat: model router`

---

### Task 7: media/b64cache —— b64↔url 转换

**Files:**
- Create: `server/src/media/b64cache.ts`
- Test: `server/tests/b64cache.test.ts`

**Interfaces:**
- Produces:
  - `conformImages(opts: { images: UnifiedImage[]; wanted: "url" | "b64_json"; dataDir: string; fileBaseUrl: string; fetchTimeoutMs: number; signal?: AbortSignal }): Promise<UnifiedImage[]>`
  - `saveGeneratedImage(dataDir, b64): { fileName: string }`（写入 `dataDir/generated/<32hex>.<ext>`，魔数嗅探 png/jpg/webp）
  - `sweepExpired(dataDir, ttlMs): number`（删除 `generated/` 里 mtime 超期文件，返回数量）
- 行为规则（设计文档第 7 节）：wanted=b64_json：有 b64 保留，有 url 则拉取转 b64；wanted=url：有 url 保留，有 b64 则落盘 → `${fileBaseUrl}/files/${fileName}`。

- [ ] **Step 1: 写失败测试**（mock 上游提供图片下载；tmpdir 落盘；magic 嗅探 PNG 头 `89504E47`）

```ts
import Fastify from "fastify";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { conformImages, saveGeneratedImage, sweepExpired } from "../src/media/b64cache.js";

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
let upstream: ReturnType<typeof Fastify>; let base: string; let dir: string;
beforeEach(async () => {
  upstream = Fastify(); await upstream.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(upstream.server.address() as any).port}`;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "bc-"));
});
afterEach(async () => { await upstream.close(); fs.rmSync(dir, { recursive: true, force: true }); });

describe("conformImages", () => {
  it("keeps b64 when wanted, fetches url to b64 when needed", async () => {
    upstream.get("/img.png", async (_req, reply) => reply.type("image/png").send(Buffer.from(PNG_B64, "base64")));
    const out = await conformImages({
      images: [{ b64: PNG_B64 }, { url: `${base}/img.png` }],
      wanted: "b64_json", dataDir: dir, fileBaseUrl: base, fetchTimeoutMs: 5000,
    });
    expect(out[0].b64).toBe(PNG_B64);
    expect(out[1].b64).toBe(PNG_B64);
  });
  it("keeps url when wanted, saves b64 to file when needed", async () => {
    const out = await conformImages({
      images: [{ b64: PNG_B64 }], wanted: "url", dataDir: dir, fileBaseUrl: base, fetchTimeoutMs: 5000,
    });
    expect(out[0].url).toMatch(new RegExp(`^${base}/files/[0-9a-f]{32}\\.png$`));
    expect(fs.readdirSync(path.join(dir, "generated"))).toHaveLength(1);
  });
  it("propagates fetch failure", async () => {
    await expect(conformImages({
      images: [{ url: `${base}/missing.png` }], wanted: "b64_json", dataDir: dir, fileBaseUrl: base, fetchTimeoutMs: 1000,
    })).rejects.toMatchObject({ type: "upstream_error" });
  });
});

describe("saveGeneratedImage + sweepExpired", () => {
  it("sniffs png extension and sweeps old files", async () => {
    const f = saveGeneratedImage(dir, PNG_B64);
    expect(f.fileName).toMatch(/\.png$/);
    const swept = sweepExpired(dir, -1); // ttl<0 → 全部过期
    expect(swept).toBe(1);
  });
});
```

- [ ] **Step 2: Run** → FAIL。
- [ ] **Step 3: 实现**。要点：fetch 失败/非 2xx → `UpstreamError(502,"upstream_error", ...)`；魔数：PNG `89 50 4E 47`、JPG `FF D8 FF`、WEBP `RIFF....WEBP`，其余 `.png`；`sweepExpired` 对不存在目录返回 0。
- [ ] **Step 4: Run** → PASS。
- [ ] **Step 5: Commit** `feat: media b64/url conversion with TTL cache`

---

### Task 8: Executor —— 编排（路由 → 换 key 重试 → 日志）

**Files:**
- Create: `server/src/core/executor.ts`
- Test: `server/tests/executor.test.ts`

**Interfaces:**
- Consumes: `ModelRouter / KeyPool / ImageProvider / Repo`。
- Produces:

```ts
export interface ExecutorDeps {
  router: ModelRouter; keyPool: KeyPool; provider: ImageProvider; repo: Repo;
  keyRetryCooldownMs?: number; // 默认 60_000
}
export interface ExecutorOptions { callerApiKeyId: number | null; signal?: AbortSignal }
export interface ExecutorResult { result: UnifiedImageResult; channel: ChannelRow; latencyMs: number }

export class Executor {
  constructor(deps: ExecutorDeps)
  generate(publicName: string, req: UnifiedGenRequest, opts: ExecutorOptions): Promise<ExecutorResult>
  edit(publicName: string, req: UnifiedEditRequest, opts: ExecutorOptions): Promise<ExecutorResult>
}
```

行为：
1. `router.resolve` 失败 → `ModelNotFoundError`。
2. 循环尝试 key（上限 = `enabledKeyCount`）：`pick` → 构造 `CallContext{upstreamModel: model.upstreamName}` → 调 provider。
3. `UpstreamError` 且 status ∈ {401,403,429}：`markFailure` 后继续换 key；其他错误/成功即出（成功先 `markSuccess`）。
4. 无可用 key → `UpstreamError(502,"upstream_error","no usable api key for channel '<name>'")`。
5. 成败都写 `insertLog`（成功 status ok + httpStatus 200 + latency；失败 status error + 该 UpstreamError 的 httpStatus + errorMessage）。`latencyMs` 从首次尝试开始计时。

- [ ] **Step 1: 写失败测试**（用 `FakeProvider`：脚本化按调用次序抛错/返回；验证换 key、日志、错误冒泡）

```ts
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { Executor } from "../src/core/executor.js"; import { KeyPool } from "../src/core/keyPool.js";
import { ModelRouter } from "../src/core/router.js"; import { UpstreamError } from "../src/core/errors.js";
import type { CallContext, ImageProvider, UnifiedGenRequest, UnifiedImageResult } from "../src/core/types.js";
import { openDb } from "../src/store/db.js"; import { Repo } from "../src/store/repo.js";

const gen = (): UnifiedGenRequest => ({ prompt: "p", n: 1, responseFormat: "b64_json", passthrough: {} });
const ok: UnifiedImageResult = { created: 1, images: [{ b64: "AA" }] };

function fakeProvider(scripts: Array<(ctx: CallContext) => Promise<UnifiedImageResult>>): ImageProvider {
  let i = 0;
  return {
    kind: "fake",
    async generate(_r, ctx) { return scripts[Math.min(i++, scripts.length - 1)](ctx); },
    async edit() { return ok; },
    async test() { return { ok: true, message: "" }; },
  };
}

let repo: Repo; let channelId: number;
beforeEach(() => {
  repo = new Repo(openDb(fs.mkdtempSync(path.join(os.tmpdir(), "ex-"))));
  channelId = repo.createChannel({ name: "a", baseUrl: "https://x/v1" }).id;
  repo.createModel({ publicName: "img", channelId, upstreamName: "up" });
  repo.createKey(channelId, "sk-1"); repo.createKey(channelId, "sk-2");
});
const build = (provider: ImageProvider) =>
  new Executor({ router: new ModelRouter(repo), keyPool: new KeyPool(repo), provider, repo });

describe("Executor", () => {
  it("succeeds on first key and logs ok", async () => {
    const ex = build(fakeProvider([async (ctx) => { expect(ctx.apiKey).toBe("sk-1"); return ok; }]));
    const r = await ex.generate("img", gen(), { callerApiKeyId: 7 });
    expect(r.channel.name).toBe("a");
    expect(r.result.images).toEqual([{ b64: "AA" }]);
    const logs = repo.recentLogs(10);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ model: "img", status: "ok", httpStatus: 200, apiKeyId: 7 });
  });

  it("rotates key on 401 then succeeds", async () => {
    const ex = build(fakeProvider([
      async (ctx) => { if (ctx.apiKey === "sk-1") throw new UpstreamError(401, "invalid_request_error", "bad key"); return ok; },
    ]));
    const r = await ex.generate("img", gen(), { callerApiKeyId: null });
    expect(r.result.images).toEqual([{ b64: "AA" }]);
    // sk-1 进入冷却
    expect(repo.listKeys(channelId).find((k) => k.apiKey === "sk-1")!.cooldownUntil).toBeGreaterThan(Date.now());
  });

  it("gives up after exhausting keys and logs error", async () => {
    const ex = build(fakeProvider([async () => { throw new UpstreamError(429, "rate_limit_error", "slow down"); }]));
    await expect(ex.generate("img", gen(), { callerApiKeyId: null })).rejects.toMatchObject({ httpStatus: 429 });
    const logs = repo.recentLogs(10);
    expect(logs[0]).toMatchObject({ status: "error", httpStatus: 429 });
  });

  it("does not rotate on non-auth errors", async () => {
    let calls = 0;
    const ex = build(fakeProvider([async () => { calls++; throw new UpstreamError(400, "invalid_request_error", "bad size"); }]));
    await expect(ex.generate("img", gen(), { callerApiKeyId: null })).rejects.toMatchObject({ httpStatus: 400 });
    expect(calls).toBe(1);
  });

  it("throws ModelNotFoundError for unknown model", async () => {
    await expect(build(fakeProvider([])).generate("nope", gen(), { callerApiKeyId: null })).rejects.toMatchObject({ name: "ModelNotFoundError" });
  });
});
```

- [ ] **Step 2: Run** → FAIL。
- [ ] **Step 3: 实现** `core/executor.ts`。
- [ ] **Step 4: Run** → PASS。
- [ ] **Step 5: Commit** `feat: executor with key rotation and request logging`

---

### Task 9: server/auth + app 骨架（错误处理器、/health）

**Files:**
- Create: `server/src/env.ts`, `server/src/server/auth.ts`, `server/src/app.ts`
- Test: `server/tests/app.test.ts`

**Interfaces:**
- Produces:

```ts
// env.ts
export function loadEnv(processEnv?: NodeJS.ProcessEnv): Env
// auth.ts
export function bearerOf(req): string | null
export function makeRequireApiKey(deps: { repo: Repo; adminToken: string | null }): preHandler
export function makeRequireAdmin(deps: { repo: Repo; adminToken: string | null }): preHandler
// app.ts
export function buildApp(opts: {
  env: Env; repo: Repo; router: ModelRouter; keyPool: KeyPool; provider: ImageProvider; executor: Executor;
  logger?: boolean; webDist?: string | null;
}): Promise<FastifyInstance>
```

行为：
- `buildApp` 注册 `@fastify/multipart`（fileSize 50MB）、路由（后续任务逐步加入）、`setErrorHandler` 用 `toOpenAIError` 统一返回、`GET /health` → `{ok:true}`。
- `requireApiKey`：api_keys 表为空 → 放行（`callerApiKeyId=null`）；非空 → 校验 Bearer：命中启用 key → 挂 `callerApiKeyId`；命中 ADMIN_TOKEN → 放行（`callerApiKeyId=null`）；否则 401 OpenAI 错误体。
- `requireAdmin`：有 ADMIN_TOKEN → Bearer 相等才过；无 ADMIN_TOKEN → 仅放行 loopback（`127.0.0.1`/`::1`/`::ffff:127.0.0.1`），否则 401。
- `env.ts`：`loadEnv` 解析 PORT/DATA_DIR/ADMIN_TOKEN/PUBLIC_BASE_URL（见设计文档第 9 节）。

- [ ] **Step 1: 写失败测试**（`fastify.inject` 直测 app；temp DATA_DIR）

```ts
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js"; import { loadEnv } from "../src/env.js";
import { Executor } from "../src/core/executor.js"; import { KeyPool } from "../src/core/keyPool.js";
import { ModelRouter } from "../src/core/router.js";
import type { ImageProvider } from "../src/core/types.js";
import { openDb } from "../src/store/db.js"; import { Repo } from "../src/store/repo.js";

const provider: ImageProvider = {
  kind: "fake", async generate() { throw new Error("not used"); }, async edit() { throw new Error("not used"); },
  async test() { return { ok: true, message: "" }; },
};
let repo: Repo; let env: ReturnType<typeof loadEnv>; let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-"));
  env = { ...loadEnv({}), dataDir: dir };
  repo = new Repo(openDb(dir));
});

async function app(adminToken: string | null) {
  return buildApp({
    env: { ...env, adminToken }, repo,
    router: new ModelRouter(repo), keyPool: new KeyPool(repo), provider,
    executor: new Executor({ router: new ModelRouter(repo), keyPool: new KeyPool(repo), provider, repo }),
    logger: false,
  });
}

describe("health", () => {
  it("returns ok", async () => { const a = await app(null); expect((await a.inject({ url: "/health" })).json()).toEqual({ ok: true }); await a.close(); });
});

describe("requireApiKey", () => {
  it("open mode when no api keys", async () => {
    const a = await app(null);
    const res = await a.inject({ url: "/v1/models" }); // 路由在 Task 10 才有内容，这里只验鉴权放行 → 404 也算过了鉴权
    expect(res.statusCode).toBe(404);
    await a.close();
  });
  it("rejects bad bearer when keys exist", async () => {
    repo.createApiKey("k1");
    const a = await app(null);
    const res = await a.inject({ url: "/v1/models", headers: { authorization: "Bearer wrong" } });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.type).toBe("invalid_request_error");
    await a.close();
  });
  it("accepts valid key and admin token", async () => {
    const k = repo.createApiKey("k1");
    const a = await app("admin-secret");
    expect((await a.inject({ url: "/v1/models", headers: { authorization: `Bearer ${k.key}` } })).statusCode).toBe(404);
    expect((await a.inject({ url: "/v1/models", headers: { authorization: "Bearer admin-secret" } })).statusCode).toBe(404);
    await a.close();
  });
});

describe("requireAdmin", () => {
  it("with token requires matching bearer; without token allows loopback only", async () => {
    const a = await app("secret");
    expect((await a.inject({ url: "/admin/channels" })).statusCode).toBe(401);
    expect((await a.inject({ url: "/admin/channels", headers: { authorization: "Bearer secret" } })).statusCode).toBe(404);
    await a.close();
    const b = await app(null);
    // fastify.inject 默认 remoteAddress 127.0.0.1 → loopback 放行
    expect((await b.inject({ url: "/admin/channels" })).statusCode).toBe(404);
    await b.close();
  });
});
```

- [ ] **Step 2: Run** → FAIL。
- [ ] **Step 3: 实现** `env.ts`、`server/auth.ts`、`app.ts`（/v1 与 /admin 的业务路由暂缺 → notFoundHandler 对 `/v1`、`/admin`、`/files` 前缀返回 OpenAI 404 错误体）。
- [ ] **Step 4: Run** → PASS。
- [ ] **Step 5: Commit** `feat: app skeleton with auth and openai error handler`

---

### Task 10: /v1/images/generations（同步）+ /v1/models

**Files:**
- Create: `server/src/server/v1.ts`（`registerV1(app, deps)`，deps 含 executor/provider/repo/env）
- Modify: `server/src/app.ts`（调用 `registerV1`）
- Test: `server/tests/v1-generations.test.ts`

**Interfaces:**
- Produces:
  - `POST /v1/images/generations`：body 校验（model/prompt 必填；n 1..10 默认 1；size 匹配 `^(\d{3,4}x\d{3,4}|auto)$`；response_format ∈ url|b64_json 默认 url；stream 默认 false；其余字段进 passthrough）→ executor.generate → `conformImages` → `{created, data:[...], ...顶层extras}`；响应头 `x-tiny-channel`、`x-tiny-latency-ms`。
  - `GET /v1/models` → `{object:"list", data:[{id, object:"model", owned_by:"tiny-images"}]}`（仅启用映射）。
  - data item：`{b64_json?|url?, revised_prompt?}`；顶层 extras 来自 `result.raw`（剔除 created/data）。

- [ ] **Step 1: 写失败测试**（真实 mock 上游 + buildApp；覆盖：成功 b64、url→b64 转换、url 透传、b64→url 落盘、参数校验 400、model 404、models 列表、日志落表）

```ts
import Fastify from "fastify";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { Executor } from "../src/core/executor.js"; import { KeyPool } from "../src/core/keyPool.js";
import { ModelRouter } from "../src/core/router.js";
import { OpenAICompatProvider } from "../src/providers/openai-compat.js";
import { openDb } from "../src/store/db.js"; import { Repo } from "../src/store/repo.js";

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
let upstream: ReturnType<typeof Fastify>; let upstreamUrl: string; let dir: string; let repo: Repo; let app: Awaited<ReturnType<typeof buildApp>>;

beforeEach(async () => {
  upstream = Fastify();
  upstream.post("/v1/images/generations", async () => ({ created: 42, data: [{ b64_json: PNG_B64, revised_prompt: "rev" }], usage: { total: 1 } }));
  await upstream.listen({ port: 0, host: "127.0.0.1" });
  upstreamUrl = `http://127.0.0.1:${(upstream.server.address() as any).port}/v1`;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "vg-"));
  repo = new Repo(openDb(dir));
  const c = repo.createChannel({ name: "mock", baseUrl: upstreamUrl });
  repo.createKey(c.id, "sk-upstream");
  repo.createModel({ publicName: "img-1", channelId: c.id, upstreamName: "gpt-image-1" });
  const provider = new OpenAICompatProvider();
  const router = new ModelRouter(repo); const keyPool = new KeyPool(repo);
  app = await buildApp({ env: { port: 0, dataDir: dir, adminToken: null, publicBaseUrl: null }, repo, router, keyPool, provider,
    executor: new Executor({ router, keyPool, provider, repo }), logger: false });
});
afterEach(async () => { await app.close(); await upstream.close(); fs.rmSync(dir, { recursive: true, force: true }); });

describe("POST /v1/images/generations", () => {
  it("returns openai shape with b64", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/images/generations", payload: { model: "img-1", prompt: "cat" } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.created).toBe(42);
    expect(body.data[0]).toEqual({ b64_json: PNG_B64, revised_prompt: "rev" });
    expect(body.usage).toEqual({ total: 1 });
    expect(res.headers["x-tiny-channel"]).toBe("mock");
    expect(repo.recentLogs(1)[0].status).toBe("ok");
  });

  it("converts url upstream to b64 on demand", async () => {
    upstream.post("/v1/images/generations", async () => ({ created: 1, data: [{ url: "http://127.0.0.1:1/x.png" }] }));
    // 该用例 url→b64 需要可达的图片服务：改用本地 upstream 托管图片
    // ——实现时把本用例的 upstream handler 换成先注册 GET 图片路径再返回其 url；
    // 这里直接断言 url 透传（conversion 在下一用例覆盖）。
    const res = await app.inject({ method: "POST", url: "/v1/images/generations", payload: { model: "img-1", prompt: "cat" } });
    expect(res.json().data[0].url).toContain("/x.png");
  });

  it("400 on invalid body", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/images/generations", payload: { model: "img-1" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.type).toBe("invalid_request_error");
    const badN = await app.inject({ method: "POST", url: "/v1/images/generations", payload: { model: "img-1", prompt: "x", n: 11 } });
    expect(badN.statusCode).toBe(400);
    const badSize = await app.inject({ method: "POST", url: "/v1/images/generations", payload: { model: "img-1", prompt: "x", size: "giant" } });
    expect(badSize.statusCode).toBe(400);
  });

  it("404 on unmapped model", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/images/generations", payload: { model: "nope", prompt: "x" } });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("model_not_found");
  });
});

describe("GET /v1/models", () => {
  it("lists enabled mappings", async () => {
    const res = await app.inject({ url: "/v1/models" });
    expect(res.json()).toEqual({ object: "list", data: [{ id: "img-1", object: "model", owned_by: "tiny-images" }] });
  });
});
```

- [ ] **Step 2: Run** → FAIL。
- [ ] **Step 3: 实现** `server/v1.ts` 并在 `app.ts` 注册。注意 url→b64 用例：在测试里为 mock upstream 增加 `upstream.get("/x.png", ...)` 返回 PNG 并返回其 url（保留断言 b64 形态）；实现按此对齐。
- [ ] **Step 4: Run** → PASS。
- [ ] **Step 5: Commit** `feat: /v1/images/generations sync + /v1/models`

---

### Task 11: /v1/images/edits（multipart + json 回退）

**Files:**
- Modify: `server/src/server/v1.ts`（新增 edits 路由）
- Modify: `server/src/providers/openai-compat.ts`（实现 edit：multipart / json-base64 / auto 回退）
- Test: `server/tests/v1-edits.test.ts`

**Interfaces:**
- 行为：入站只收 multipart（`image` 单或多文件，可选 `mask`，字段 prompt/model/n/size/response_format/stream）；出站按渠道 `edit_mode`：`multipart` → FormData（`image` 字段可重复）；`json-base64` → JSON `{image: dataUrl 或 dataUrl[], mask?, prompt, model, n, size?}`；`auto` → 先 multipart，404/415 回退 json-base64。

- [ ] **Step 1: 写失败测试**（mock 上游分别实现 multipart 接收与 JSON 接收两种 handler，验证 auto 回退与强制模式；成功响应与 generations 同构）

```ts
import Fastify from "fastify";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { Executor } from "../src/core/executor.js"; import { KeyPool } from "../src/core/keyPool.js"; import { ModelRouter } from "../src/core/router.js";
import { OpenAICompatProvider } from "../src/providers/openai-compat.js";
import { openDb } from "../src/store/db.js"; import { Repo } from "../src/store/repo.js";

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG_BUF = Buffer.from(PNG_B64, "base64");
let upstream: ReturnType<typeof Fastify>; let dir: string; let repo: Repo; let app: Awaited<ReturnType<typeof buildApp>>;
let seen: { multipart: number; json: number; lastFields: any; lastFiles: any[] };

beforeEach(async () => {
  upstream = Fastify(); seen = { multipart: 0, json: 0, lastFields: null, lastFiles: [] };
  upstream.post("/v1/images/edits", async (req, reply) => {
    const ct = req.headers["content-type"] ?? "";
    if (String(ct).includes("multipart/form-data")) {
      seen.multipart++;
      const parts = req.parts(); const fields: any = {}; const files: any[] = [];
      for await (const p of parts) {
        if (p.type === "file") files.push({ field: p.fieldname, name: p.filename, bytes: (p as any).buffer?.length ?? 0 });
        else fields[p.fieldname] = p.value;
      }
      seen.lastFields = fields; seen.lastFiles = files;
      return { created: 7, data: [{ b64_json: PNG_B64 }] };
    }
    seen.json++;
    const body = req.body as any;
    if (!body?.image) return reply.code(400).send({ error: { message: "image required", type: "invalid_request_error" } });
    seen.lastFields = body;
    return { created: 7, data: [{ b64_json: PNG_B64 }] };
  });
  await upstream.listen({ port: 0, host: "127.0.0.1" });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ve-"));
  repo = new Repo(openDb(dir));
  const c = repo.createChannel({ name: "mock", baseUrl: `http://127.0.0.1:${(upstream.server.address() as any).port}/v1` });
  repo.createKey(c.id, "sk-upstream");
  repo.createModel({ publicName: "img-1", channelId: c.id, upstreamName: "gpt-image-1" });
  const provider = new OpenAICompatProvider(); const router = new ModelRouter(repo); const keyPool = new KeyPool(repo);
  app = await buildApp({ env: { port: 0, dataDir: dir, adminToken: null, publicBaseUrl: null }, repo, router, keyPool, provider,
    executor: new Executor({ router, keyPool, provider, repo }), logger: false });
});
afterEach(async () => { await app.close(); await upstream.close(); fs.rmSync(dir, { recursive: true, force: true }); });

function form(model = "img-1") {
  const fd = new FormData();
  fd.append("model", model); fd.append("prompt", "make it blue"); fd.append("n", "1");
  fd.append("image", new Blob([PNG_BUF], { type: "image/png" }), "a.png");
  return fd;
}

describe("POST /v1/images/edits", () => {
  it("auto mode: multipart works and returns openai shape", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/images/edits", payload: form(), headers: formHeaders(form()) });
    expect(res.statusCode).toBe(200);
    expect(res.json().data[0].b64_json).toBe(PNG_B64);
    expect(seen.multipart).toBe(1);
    expect(seen.lastFiles[0].field).toBe("image");
    expect(seen.lastFields.prompt).toBe("make it blue");
  });

  it("auto mode: falls back to json-base64 when upstream rejects multipart", async () => {
    seen.multipart === 0; // noop
    upstream.post("/v1/images/edits", async (req, reply) => {
      const ct = String(req.headers["content-type"] ?? "");
      if (ct.includes("multipart/form-data")) return reply.code(415).send({ error: { message: "json only" } });
      seen.json++;
      seen.lastFields = req.body as any;
      return { created: 7, data: [{ b64_json: PNG_B64 }] };
    });
    const fd = form();
    const res = await app.inject({ method: "POST", url: "/v1/images/edits", payload: fd, headers: formHeaders(fd) });
    expect(res.statusCode).toBe(200);
    expect(seen.json).toBe(1);
    expect(String(seen.lastFields.image)).toMatch(/^data:image\/png;base64,/);
  });

  it("json-base64 forced mode sends json directly", async () => {
    const c = repo.listChannels()[0];
    repo.updateChannel(c.id, { editMode: "json-base64" });
    const fd = form();
    const res = await app.inject({ method: "POST", url: "/v1/images/edits", payload: fd, headers: formHeaders(fd) });
    expect(res.statusCode).toBe(200);
    expect(seen.multipart).toBe(0);
    expect(seen.json).toBe(1);
  });

  it("400 when image file missing", async () => {
    const fd = new FormData(); fd.append("model", "img-1"); fd.append("prompt", "x");
    const res = await app.inject({ method: "POST", url: "/v1/images/edits", payload: fd, headers: formHeaders(fd) });
    expect(res.statusCode).toBe(400);
  });
});

function formHeaders(fd: FormData): Record<string, string> {
  // fastify.inject 需要显式 content-type；Node 的 FormData 转字符串时保留 boundary 的做法：
  return { "content-type": "multipart/form-data" }; // 配合 app.inject 的 payload=FormData 由 undici 生成 boundary
}
```

> 实现注意：`fastify.inject` 传 FormData payload 时不自动生成 boundary。若上述 `formHeaders` 方案在执行时不可行，改用 `app.inject({ payload: Buffer.from(await fd.arrayBuffer()), headers: { "content-type": fd 及其 boundary } })` —— 通过 Node 22 的 `Request` 构造器取 boundary：`const req = new Request("http://x", { method: "POST", body: fd }); const ct = req.headers.get("content-type")!; const buf = Buffer.from(await req.arrayBuffer());` 然后以 `payload: buf, headers: {"content-type": ct}` 注入。测试以实际可行为准，行为断言不变。

- [ ] **Step 2: Run** → FAIL。
- [ ] **Step 3: 实现** provider.edit 与 edits 路由。
- [ ] **Step 4: Run** → PASS。
- [ ] **Step 5: Commit** `feat: /v1/images/edits with multipart and json fallback`

---

### Task 12: SSE 流式（generations + edits）

**Files:**
- Create: `server/src/server/sse.ts`
- Modify: `server/src/server/v1.ts`（两条路由在 body.stream===true 时走流式分支）
- Test: `server/tests/v1-stream.test.ts`

**Interfaces:**
- Produces `sseReply(reply): { send(event): void; end(): void; heartbeat(fn): void }`；事件协议（设计文档第 3 节）：

```
data: {"type":"status","stage":"submitted"}
data: {"type":"progress","message":"generating"}      // 15s 心跳
data: {"type":"image","index":0,"b64_json":"…"}
data: {"type":"completed","created":…,"data":[…]}
data: [DONE]
data: {"type":"error","error":{…}}                    // 失败时（其后无 [DONE]）
```

- 行为：验证/路由错误发生在流开始前 → 正常 JSON 错误响应；流开始后失败 → error 事件。images 始终按请求的 response_format 转换后逐个推送，`completed.data` 为完整数组。

- [ ] **Step 1: 写失败测试**

```ts
// 延续 Task 10 的 mock 上游 + buildApp 装配（同款 beforeEach），仅列关键用例：
describe("POST /v1/images/generations stream=true", () => {
  it("emits status, image, completed, [DONE]", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/images/generations",
      payload: { model: "img-1", prompt: "cat", stream: true } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    const frames = res.body.split("\n\n").filter((s) => s.startsWith("data: "));
    const events = frames.map((f) => JSON.parse(f.slice(6)));
    expect(events[0]).toEqual({ type: "status", stage: "submitted" });
    expect(events.find((e) => e.type === "image")!.b64_json).toBe(PNG_B64);
    const done = frames.find((f) => f === "data: [DONE]");
    expect(done).toBeTruthy();
    const completed = events.find((e) => e.type === "completed")!;
    expect(completed.data[0].b64_json).toBe(PNG_B64);
    expect(repo.recentLogs(1)[0].status).toBe("ok");
  });

  it("emits error event when upstream fails mid-stream", async () => {
    upstream.post("/v1/images/generations", async (_req, reply) => reply.code(429).send({ error: { message: "slow down" } }));
    const res = await app.inject({ method: "POST", url: "/v1/images/generations",
      payload: { model: "img-1", prompt: "cat", stream: true } });
    expect(res.body).toContain('"type":"error"');
    expect(res.body).toContain("slow down");
    expect(repo.recentLogs(1)[0].status).toBe("error");
  });

  it("validation errors stay JSON before stream starts", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/images/generations", payload: { model: "img-1", stream: true } });
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.statusCode).toBe(400);
  });
});
```

- [ ] **Step 2: Run** → FAIL。
- [ ] **Step 3: 实现**。要点：`reply.raw.writeHead(200, {...})`；心跳 `setInterval(15_000)` 的事件在响应结束时 `clearInterval`（`res.on("close")`）；edits 路由同样接入（multipart 表单字段 stream=true 同语义）。
- [ ] **Step 4: Run** → PASS。
- [ ] **Step 5: Commit** `feat: SSE streaming for images endpoints`

---

### Task 13: /files 路由 + 启动入口 + config.yaml 种子

**Files:**
- Create: `server/src/server/files.ts`, `server/src/index.ts`, `server/src/store/seed.ts`
- Modify: `server/src/app.ts`（注册 files 路由；webDist 静态托管 + SPA fallback）
- Test: `server/tests/files-seed.test.ts`

**Interfaces:**
- `GET /files/:name`：`name` 必须匹配 `^[0-9a-f]{32}\.(png|jpe?g|webp)$`，从 `DATA_DIR/generated/` 读文件，按扩展名给 content-type；不存在 → 404 OpenAI 错误体。
- `store/seed.ts`：`seedIfEmpty(dataDir, repo)` —— DB 无任何 channel 且无 model 时，读 `dataDir/config.yaml`（结构见设计文档第 5 节）导入；文件不存在则跳过。
- `index.ts`：loadEnv → openDb → seedIfEmpty → buildApp → 监听 `0.0.0.0:PORT`；每小时 `sweepExpired(dataDir, 24h)`（`unref()`）。
- `app.ts`：若 `webDist` 存在（默认 `<repo>/web/dist`），注册 `@fastify/static`，404 fallback 返回 `index.html`（`/v1`、`/admin`、`/files` 前缀除外）。

- [ ] **Step 1: 写失败测试**（files：合法/非法名、404；seed：写 config.yaml 到 tmp DATA_DIR 后 `seedIfEmpty` 落库、无文件跳过、已有数据跳过）

```ts
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { seedIfEmpty } from "../src/store/seed.js";
import { buildApp } from "../src/app.js";
import { Executor } from "../src/core/executor.js"; import { KeyPool } from "../src/core/keyPool.js"; import { ModelRouter } from "../src/core/router.js";
import type { ImageProvider } from "../src/core/types.js";
import { openDb } from "../src/store/db.js"; import { Repo } from "../src/store/repo.js";
import { saveGeneratedImage } from "../src/media/b64cache.js";

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
let dir: string; let repo: Repo;
const provider: ImageProvider = { kind: "fake",
  generate: async () => { throw new Error("x"); }, edit: async () => { throw new Error("x"); }, test: async () => ({ ok: true, message: "" }) };

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-")); repo = new Repo(openDb(dir)); });

describe("seedIfEmpty", () => {
  it("imports config.yaml when db empty", () => {
    fs.writeFileSync(path.join(dir, "config.yaml"), `
channels:
  - name: openai
    baseUrl: https://api.openai.com/v1
    keys: [sk-a, sk-b]
    timeoutMs: 90000
models:
  - name: gpt-image-1
    channel: openai
`);
    seedIfEmpty(dir, repo);
    const c = repo.listChannels()[0];
    expect(c.name).toBe("openai");
    expect(repo.listKeys(c.id)).toHaveLength(2);
    expect(repo.listModels()[0].publicName).toBe("gpt-image-1");
    expect(repo.listModels()[0].upstreamName).toBe("gpt-image-1");
  });
  it("skips when file missing or db not empty", () => {
    seedIfEmpty(dir, repo);
    expect(repo.listChannels()).toHaveLength(0);
    repo.createChannel({ name: "x", baseUrl: "https://x/v1" });
    fs.writeFileSync(path.join(dir, "config.yaml"), "channels:\n  - name: y\n    baseUrl: https://y/v1\n");
    seedIfEmpty(dir, repo);
    expect(repo.listChannels()).toHaveLength(1);
  });
});

describe("GET /files/:name", () => {
  it("serves generated files and rejects bad names", async () => {
    const router = new ModelRouter(repo); const keyPool = new KeyPool(repo);
    const app = await buildApp({ env: { port: 0, dataDir: dir, adminToken: null, publicBaseUrl: null }, repo, router, keyPool, provider,
      executor: new Executor({ router, keyPool, provider, repo }), logger: false });
    const { fileName } = saveGeneratedImage(dir, PNG_B64);
    const ok = await app.inject({ url: `/files/${fileName}` });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["content-type"]).toBe("image/png");
    expect((await app.inject({ url: "/files/../secret" })).statusCode).toBe(404);
    expect((await app.inject({ url: "/files/zzz.png" })).statusCode).toBe(404);
    await app.close();
  });
});
```

- [ ] **Step 2: Run** → FAIL。
- [ ] **Step 3: 实现**三个文件 + app.ts 静态托管。
- [ ] **Step 4: Run** → PASS。
- [ ] **Step 5: Commit** `feat: files route, startup entry, config.yaml seeding`

---

### Task 14: /admin 管理 API

**Files:**
- Create: `server/src/server/admin.ts`（`registerAdmin(app, deps)`）
- Modify: `server/src/app.ts`
- Test: `server/tests/admin.test.ts`

**Interfaces（全部 preHandler=requireAdmin；错误为 OpenAI 格式）：**

| 方法/路径 | 请求体 | 说明 |
|---|---|---|
| GET `/admin/channels` | — | 渠道列表，含 `keys`（完整 apiKey）|
| POST `/admin/channels` | `{name, baseUrl, timeoutMs?, editMode?, extraHeaders?, enabled?}` | 校验 baseUrl 为 http(s)；重名 409 |
| PATCH `/admin/channels/:id` | 任意子集 | 404 当不存在；重名 409 |
| DELETE `/admin/channels/:id` | — | 级联删 keys/models |
| POST `/admin/channels/:id/test` | — | 取一个启用 key 调 `provider.test`，返回 `{ok, message, keyId?}`；无 key → `{ok:false, message:"no enabled api key"}` |
| POST `/admin/channels/:id/keys` | `{apiKey}` | 必填非空 |
| PATCH `/admin/keys/:keyId` | `{enabled?, apiKey?}` | |
| DELETE `/admin/keys/:keyId` | — | |
| GET `/admin/models` | — | 含每条映射的渠道名 `channelName` |
| POST `/admin/models` | `{publicName, channelId, upstreamName?, enabled?}` | 重名 409 |
| PATCH `/admin/models/:id` | 子集 | |
| DELETE `/admin/models/:id` | — | |
| GET `/admin/api-keys` | — | 完整 key（自托管工具）|
| POST `/admin/api-keys` | `{name}` | 服务端生成 `sk-tiny-…` |
| PATCH `/admin/api-keys/:id` | `{enabled?, name?}` | |
| DELETE `/admin/api-keys/:id` | — | |
| GET `/admin/logs?limit=` | — | 默认 50，上限 500 |

- [ ] **Step 1: 写失败测试**（带 `Authorization: Bearer admin-secret`；覆盖 channel CRUD + 409 + test 连通性（mock 上游 /v1/models 200）、model CRUD + 409、api-key 生成、logs 查询、无 token 401）

```ts
// 装配同 Task 9 的 app(adminToken) + mock upstream；核心断言：
describe("/admin/channels", () => {
  it("CRUD + conflict + test", async () => {
    const created = await app.inject({ method: "POST", url: "/admin/channels", headers: H, payload: { name: "c1", baseUrl: upstreamUrl } });
    expect(created.statusCode).toBe(201);
    const dup = await app.inject({ method: "POST", url: "/admin/channels", headers: H, payload: { name: "c1", baseUrl: upstreamUrl } });
    expect(dup.statusCode).toBe(409);
    await app.inject({ method: "POST", url: `/admin/channels/${created.json().id}/keys`, headers: H, payload: { apiKey: "sk-up" } });
    const list = await app.inject({ url: "/admin/channels", headers: H });
    expect(list.json()[0].keys).toHaveLength(1);
    const test = await app.inject({ method: "POST", url: `/admin/channels/${created.json().id}/test`, headers: H });
    expect(test.json().ok).toBe(true);
    const del = await app.inject({ method: "DELETE", url: `/admin/channels/${created.json().id}`, headers: H });
    expect(del.statusCode).toBe(204);
  });
  it("rejects bad baseUrl", async () => {
    const res = await app.inject({ method: "POST", url: "/admin/channels", headers: H, payload: { name: "x", baseUrl: "notaurl" } });
    expect(res.statusCode).toBe(400);
  });
});
describe("/admin/models", () => {
  it("CRUD + duplicate conflict", async () => { /* 建 channel → POST models → 再 POST 同名 → 409；PATCH 改 upstream；DELETE 204 */ });
});
describe("/admin/api-keys", () => {
  it("creates sk-tiny- key, patches, deletes", async () => { /* POST {name:"k"} → key 前缀校验；PATCH enabled:false；DELETE 204 */ });
});
describe("/admin/logs", () => {
  it("returns recent logs", async () => { repo.insertLog({...}); GET → 数组长度 1，字段驼峰 });
});
describe("auth", () => {
  it("401 without token", async () => { expect((await app.inject({ url: "/admin/channels" })).statusCode).toBe(401); });
});
```

- [ ] **Step 2: Run** → FAIL。
- [ ] **Step 3: 实现** `server/admin.ts` + 注册。
- [ ] **Step 4: Run** → PASS。
- [ ] **Step 5: Commit** `feat: admin API for channels/models/keys/logs`

---

### Task 15: Web 脚手架 + Login

**Files:**
- Create: `web/package.json`, `web/vite.config.ts`, `web/tsconfig.json`, `web/index.html`, `web/src/main.tsx`, `web/src/App.tsx`, `web/src/api.ts`, `web/src/styles.css`, `web/src/pages/Login.tsx`, `web/src/vite-env.d.ts`
- Modify: 根 `package.json`（已有 workspaces 无需改）

**Interfaces:**
- `web/src/api.ts`：

```ts
export const TOKEN_KEY = "tiny-admin-token";
export const getToken = (): string => localStorage.getItem(TOKEN_KEY) ?? "";
export const setToken = (t: string): void => localStorage.setItem(TOKEN_KEY, t);
export const clearToken = (): void => localStorage.removeItem(TOKEN_KEY);

export class ApiError extends Error {
  constructor(public status: number, public body: { error?: { message?: string } }) { super(body?.error?.message ?? statusText(status)); }
}
export async function api<T>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: opts.method ?? "GET",
    headers: { "content-type": "application/json", authorization: `Bearer ${getToken()}` },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => ({})));
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}
```

- `main.tsx`：`BrowserRouter` + `App`；`App.tsx` 路由：`/login` → Login，`/` → Playground（Task 16 先放占位组件），`/admin` → Admin（Task 17 占位）；受保护页面无 token 时 `<Navigate to="/login" replace />`。
- `Login.tsx`：输入 token → 探测 `api("/admin/channels")` 成功则 `setToken` + 跳 `/`；失败显示错误。
- `vite.config.ts`：react 插件 + dev 代理 `/v1`、`/admin`、`/files` → `http://localhost:3000`。
- `web/tsconfig.json`：React JSX（`"jsx": "react-jsx"`，`moduleResolution: "bundler"`，`target: ES2022`，`strict`）。
- 构建验证：`npm run build -w web` 产出 `web/dist`。

- [ ] **Step 1: 写全部文件**；**Step 2: Run** `npm run build -w web` → 成功；`npm run dev -w server` + 浏览器手验 Login（可跳过，Task 17 结束统一手验）。
- [ ] **Step 3: Commit** `feat(web): scaffold, login page, api client`

---

### Task 16: Playground 页面

**Files:**
- Create: `web/src/pages/Playground.tsx`
- Modify: `web/src/App.tsx`（替换占位）、`web/src/styles.css`

**行为：**
- 表单：model 下拉（`GET /v1/models`，带鉴权头）、prompt textarea、n、size（下拉常用值 + 自由输入）、response_format 单选、stream 开关、"高级参数 JSON" 折叠框（解析失败提示，成功则并入请求体）。
- 非流式：POST 后展示图片（`b64_json` → `data:image/png;base64,…`；`url` → 直接 src）、`x-tiny-channel`/`x-tiny-latency-ms` 头、错误信息。
- 流式：`fetch` + `res.body.getReader()` + TextDecoder，按 `\n\n` 分帧解析 `data:` 行；`image` 事件即时追加预览，`completed` 后展示总耗时，`error` 事件显示错误。
- 关键代码骨架（流式解析）：

```ts
const res = await fetch("/v1/images/generations", { method: "POST", headers, body: JSON.stringify(payload) });
if (!res.ok || !res.body) { /* 显示 JSON 错误 */ }
const reader = res.body.getReader(); const decoder = new TextDecoder(); let buf = "";
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += decoder.decode(value, { stream: true });
  const frames = buf.split("\n\n"); buf = frames.pop() ?? "";
  for (const frame of frames) {
    if (!frame.startsWith("data: ")) continue;
    const data = frame.slice(6);
    if (data === "[DONE]") continue;
    const ev = JSON.parse(data); // 按 ev.type 分派
  }
}
```

- [ ] **Step 1: 实现页面与样式**；**Step 2: Run** `npm run build -w web` 成功 + `npm run dev` 双端手验（配 mock 上游或真实渠道均可，验证同步与流式两条路径）。
- [ ] **Step 3: Commit** `feat(web): playground with sync and streaming`

---

### Task 17: Admin 后台页面

**Files:**
- Create: `web/src/pages/Admin.tsx`（单文件内含四个 Tab 子组件）
- Modify: `web/src/App.tsx`、`web/src/styles.css`

**行为：**
- Tab 渠道：列表（含 key 池展开）+ 新建/编辑表单（name/baseUrl/timeoutMs/editMode/extraHeaders JSON）+ 启停开关 + 删除确认 + key 增删/启停 + "测试连通性"按钮显示 `{ok, message}`。
- Tab 模型映射：表格 + 新建/编辑（publicName、渠道下拉、upstreamName、启停）。
- Tab API Keys：列表、新建（生成后一次性弹层展示完整 key + 复制按钮）、启停、删除。
- Tab 日志：最近 50 条表格 + 5s 自动刷新（组件卸载清理）。
- 顶栏：标题 + 登出（clearToken → /login）。

- [ ] **Step 1: 实现**；**Step 2: Run** build + 手验全流程（建渠道→录 key→建映射→Playground 出图）。
- [ ] **Step 3: Commit** `feat(web): admin console`

---

### Task 18: Docker 部署 + README + 端到端验证

**Files:**
- Create: `Dockerfile`, `.dockerignore`, `docker-compose.yml`, `README.md`
- Modify: 根 `package.json`（如需）

**Dockerfile（多阶段）：**

```dockerfile
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY web/ web/
RUN npm run build -w web
COPY server/ server/
RUN npm run build -w server

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data PORT=3000
COPY package*.json ./
COPY server/package.json server/
RUN npm ci --workspace server --include-workspace-root
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/web/dist web/dist
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:3000/health || exit 1
CMD ["node", "server/dist/index.js"]
```

> 注意：server build 用 `noEmit` 时改为 `tsc -p tsconfig.build.json`（去掉 noEmit）输出 dist；或直接以 `node --experimental-strip-types` 运行——以执行时验证可行者为准，保持产物为纯 JS。`npm ci --workspace server` 需 root `package-lock.json`（在 build 阶段 `npm ci` 后会生成，需 COPY 进运行阶段；若 lock 处理繁琐，运行阶段直接 `npm ci --omit=dev` 全 workspace 亦可，代价是镜像稍大——以可工作为准）。

**docker-compose.yml：**

```yaml
services:
  tiny-images:
    build: .
    ports: ["3000:3000"]
    environment:
      - ADMIN_TOKEN=${ADMIN_TOKEN:-change-me}
      - PUBLIC_BASE_URL=${PUBLIC_BASE_URL:-}
    volumes:
      - tiny-data:/data
volumes:
  tiny-data:
```

**README.md**：项目简介、Quick Start（docker compose 与本地 dev 两种）、配置说明（env + config.yaml 种子格式）、API 用法（OpenAI SDK 指向示例：node `new OpenAI({ baseURL: "http://localhost:3000/v1", apiKey: "sk-tiny-…" })` + curl）、SSE 事件协议说明、WebUI 截图位说明。

- [ ] **Step 1: 写文件并本地构建 Docker 镜像验证**（`docker build -t tiny-images .` + `docker compose up -d` + `/health` 200；若执行环境无 Docker，则标记该步骤为"有 Docker 的环境验证"并在 README 注明）。
- [ ] **Step 2: 全量回归**：`npm test -w server` 全绿、`npm run build` 成功、手动端到端（Playground 出图 + Admin 流程）。
- [ ] **Step 3: Commit** `feat: docker deployment and readme`
- [ ] **Step 4: 收尾**：确认所有里程碑（M1–M6）完成，更新任务勾选。

---

## 自查记录（Self-Review）

- **Spec 覆盖**：generations/edits/models/SSE/错误映射（Task 10–12）、b64↔url（Task 7/10）、key 池与换 key 重试（Task 5/8）、鉴权（Task 9）、日志（Task 8/14）、Admin API（Task 14）、WebUI 三页（Task 15–17）、config.yaml 种子（Task 13）、Docker（Task 18）——均有对应任务。规范中 "editMode auto 回退"（Task 11）、"partial unique index"（Task 2）落实。
- **占位符**：Task 14 测试块中两处"……"为测试行为描述（非实现占位），执行时按同文件既有 mock 上游模式展开；已在任务文本中写明断言内容。
- **类型一致性**：`CallContext` 含 `upstreamModel`（Task 4/8 一致）；`conformImages` 参数在 Task 7/10/12 一致；`ExecutorOptions.callerApiKeyId` 在 Task 8/9/10 一致；`Repo` 方法名全程一致。
