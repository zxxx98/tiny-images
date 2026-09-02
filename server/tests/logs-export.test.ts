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
import { hashPassword } from "../src/core/password.js";
import type { LogEntry } from "../src/store/repo.js";

let dir: string;
let repo: Repo;
let app: Awaited<ReturnType<typeof buildApp>>;
let H: { authorization: string };

function entry(overrides: Partial<LogEntry>): LogEntry {
  return {
    ts: 1700000000000,
    model: "img-1",
    channelId: 1,
    apiKeyId: 1,
    status: "ok",
    httpStatus: 200,
    latencyMs: 123,
    errorMessage: null,
    ...overrides,
  };
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lg-"));
  repo = new Repo(openDb(dir));
  repo.createUser({ email: "admin@local", passwordHash: hashPassword("admin-pass"), role: "admin", quotaTotal: null });
  const provider = new OpenAICompatProvider();
  const router = new ModelRouter(repo);
  const keyPool = new KeyPool(repo);
  const providers = new Map([["openai-compat", provider]]);
  app = await buildApp({
    env: { port: 0, dataDir: dir, publicBaseUrl: null },
    repo,
    router,
    keyPool,
    providers,
    executor: new Executor({ router, keyPool, providers, repo }),
    logger: false,
    webDist: null,
  });
  const login = await app.inject({ method: "POST", url: "/admin/auth/login", payload: { email: "admin@local", password: "admin-pass" } });
  H = { authorization: `Bearer ${(login.json() as { token: string }).token}` };

  repo.insertLog(entry({ model: "img-1", channelId: 1, status: "ok" }));
  repo.insertLog(entry({ model: "img-2", channelId: 2, status: "error", httpStatus: 500, errorMessage: 'boom, "upstream" failed\nline2' }));
  repo.insertLog(entry({ model: "fast", channelId: 1, status: "ok", latencyMs: 42 }));
});

afterEach(async () => {
  await app.close();
  repo.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("GET /admin/logs", () => {
  it("requires admin", async () => {
    const res = await app.inject({ url: "/admin/logs" });
    expect(res.statusCode).toBe(401);
  });

  it("filters by status, model substring, channel and search text", async () => {
    const all = await app.inject({ url: "/admin/logs", headers: H });
    expect((all.json() as unknown[]).length).toBe(3);

    const errors = await app.inject({ url: "/admin/logs?status=error", headers: H });
    expect((errors.json() as { model: string }[]).map((r) => r.model)).toEqual(["img-2"]);

    const byModel = await app.inject({ url: "/admin/logs?model=IMG", headers: H });
    expect((byModel.json() as unknown[]).length).toBe(2);

    const byChannel = await app.inject({ url: "/admin/logs?channelId=2", headers: H });
    expect((byChannel.json() as { model: string }[]).map((r) => r.model)).toEqual(["img-2"]);

    const byQ = await app.inject({ url: "/admin/logs?q=boom", headers: H });
    expect((byQ.json() as { model: string }[]).map((r) => r.model)).toEqual(["img-2"]);

    const combined = await app.inject({ url: "/admin/logs?channelId=1&status=error", headers: H });
    expect(combined.json()).toEqual([]);
  });

  it("rejects invalid filters", async () => {
    const status = await app.inject({ url: "/admin/logs?status=weird", headers: H });
    expect(status.statusCode).toBe(400);
    const channel = await app.inject({ url: "/admin/logs?channelId=abc", headers: H });
    expect(channel.statusCode).toBe(400);
    const limit = await app.inject({ url: "/admin/logs?limit=0", headers: H });
    expect(limit.statusCode).toBe(400);
  });
});

describe("GET /admin/logs/export", () => {
  it("requires admin", async () => {
    const res = await app.inject({ url: "/admin/logs/export" });
    expect(res.statusCode).toBe(401);
  });

  it("exports a CSV with header, BOM and proper escaping", async () => {
    const res = await app.inject({ url: "/admin/logs/export", headers: H });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toContain("attachment");

    const text = res.body;
    expect(text.charCodeAt(0)).toBe(0xfeff);
    const lines = text.replace(/^\uFEFF/, "").trimEnd().split("\r\n");
    expect(lines[0]).toBe("id,ts,model,channel_id,api_key_id,status,http_status,latency_ms,error_message");
    expect(lines.length).toBe(4);
    // 含逗号、引号与换行的错误信息必须整体加引号并转义内部引号
    expect(lines[2]).toContain('"boom, ""upstream"" failed\nline2"');
  });

  it("applies the same filters as the JSON endpoint", async () => {
    const res = await app.inject({ url: "/admin/logs/export?status=ok&channelId=1", headers: H });
    const lines = res.body.replace(/^\uFEFF/, "").trimEnd().split("\r\n");
    expect(lines.length).toBe(3);
    expect(lines[1]).toContain(",ok,");
  });
});
