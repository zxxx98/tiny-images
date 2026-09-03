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

const PNG_BUF = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
let dir: string;
let repo: Repo;
let app: Awaited<ReturnType<typeof buildApp>>;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "plaza-"));
  repo = new Repo(openDb(dir));
});

afterEach(async () => {
  await app.close();
  repo.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function start(opts: { apiKey?: boolean } = {}): Promise<void> {
  const c = repo.createChannel({ name: "mock", baseUrl: "http://127.0.0.1:1/v1" });
  repo.createKey(c.id, "sk-upstream");
  repo.createModel({ publicName: "img-1", channelId: c.id, upstreamName: "gpt-image-1" });
  if (opts.apiKey !== false) repo.createApiKey("k1");
  const provider = new OpenAICompatProvider();
  app = await buildApp({
    env: { port: 0, dataDir: dir, publicBaseUrl: null },
    repo,
    router: new ModelRouter(repo),
    keyPool: new KeyPool(repo),
    providers: new Map([["openai-compat", provider]]),
    executor: new Executor({ router: new ModelRouter(repo), keyPool: new KeyPool(repo), providers: new Map([["openai-compat", provider]]), repo }),
    jobManager: new JobManager(),
    logger: false,
    webDist: null,
  });
}

interface User {
  id: number;
  auth: { authorization: string };
}

async function createUser(email: string, role: "admin" | "user" = "user"): Promise<User> {
  const hash = (await import("../src/core/password.js")).hashPassword;
  const u = repo.createUser({ email, passwordHash: hash("pw-123456"), role, quotaTotal: 100 });
  const login = await app.inject({ method: "POST", url: "/admin/auth/login", payload: { email, password: "pw-123456" } });
  return { id: u.id, auth: { authorization: `Bearer ${(login.json() as { token: string }).token}` } };
}

// 造一条属于给定用户的成功生成记录，并把图片文件写入 generated/
function seedGeneration(user: User | null, file: string, opts?: { images?: object[] }): number {
  fs.mkdirSync(path.join(dir, "generated"), { recursive: true });
  fs.writeFileSync(path.join(dir, "generated", file), PNG_BUF);
  return repo.insertGeneration({
    createdAt: 1,
    apiKeyId: null,
    userId: user?.id ?? null,
    model: "img-1",
    prompt: "a cat",
    params: "{}",
    status: "ok",
    channelId: null,
    latencyMs: 1,
    errorMessage: null,
    images: JSON.stringify(opts?.images ?? [{ file, width: 1, height: 1 }]),
  });
}

describe("POST /v1/plaza", () => {
  it("copies the file to plaza dir, snapshots info, and lists with author", async () => {
    await start();
    const u1 = await createUser("u1@x.com");
    const file = `${"a".repeat(32)}.png`;
    const genId = seedGeneration(u1, file);

    const res = await app.inject({ method: "POST", url: "/v1/plaza", headers: u1.auth, payload: { generationId: genId } });
    expect(res.statusCode).toBe(200);
    const share = res.json();
    expect(share.url).toMatch(new RegExp(`/files/plaza/${file}$`));
    expect(share).toMatchObject({ prompt: "a cat", model: "img-1", width: 1, height: 1, mine: true, canDelete: true });
    expect(fs.existsSync(path.join(dir, "plaza", file))).toBe(true);

    const served = await app.inject({ method: "GET", url: `/files/plaza/${file}` });
    expect(served.statusCode).toBe(200);
    expect(served.headers["content-type"]).toBe("image/png");

    const list = (await app.inject({ method: "GET", url: "/v1/plaza", headers: u1.auth })).json();
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ id: share.id, author: "u1@x.com", url: share.url });
  });

  it("is idempotent for the same user and file", async () => {
    await start();
    const u1 = await createUser("u1@x.com");
    const genId = seedGeneration(u1, `${"b".repeat(32)}.png`);
    const first = await app.inject({ method: "POST", url: "/v1/plaza", headers: u1.auth, payload: { generationId: genId } });
    const second = await app.inject({ method: "POST", url: "/v1/plaza", headers: u1.auth, payload: { generationId: genId } });
    expect(second.statusCode).toBe(200);
    expect(second.json().id).toBe(first.json().id);
    const list = (await app.inject({ method: "GET", url: "/v1/plaza", headers: u1.auth })).json();
    expect(list.items).toHaveLength(1);
  });

  it("answers 404 for others' records, 403 for anonymous keys, 400 for bad input", async () => {
    await start();
    const u1 = await createUser("u1@x.com");
    const u2 = await createUser("u2@x.com");
    const genId = seedGeneration(u1, `${"c".repeat(32)}.png`);
    const apiKey = { authorization: `Bearer ${repo.listApiKeys().find((k) => k.userId === null)!.key}` };

    expect((await app.inject({ method: "POST", url: "/v1/plaza", headers: u2.auth, payload: { generationId: genId } })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/v1/plaza", headers: apiKey, payload: { generationId: genId } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/v1/plaza", headers: u1.auth, payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/v1/plaza", headers: u1.auth, payload: { generationId: 999999 } })).statusCode).toBe(404);
  });

  it("rejects sharing when the source image file has expired", async () => {
    await start();
    const u1 = await createUser("u1@x.com");
    const file = `${"d".repeat(32)}.png`;
    const genId = repo.insertGeneration({
      createdAt: 1,
      apiKeyId: null,
      userId: u1.id,
      model: "img-1",
      prompt: "a cat",
      params: "{}",
      status: "ok",
      channelId: null,
      latencyMs: 1,
      errorMessage: null,
      images: JSON.stringify([{ file, width: 1, height: 1 }]),
    });
    const res = await app.inject({ method: "POST", url: "/v1/plaza", headers: u1.auth, payload: { generationId: genId } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain("过期");
  });
});

describe("GET /v1/plaza", () => {
  it("rejects fully anonymous callers on deployments without api keys", async () => {
    await start({ apiKey: false });
    const res = await app.inject({ method: "GET", url: "/v1/plaza" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.message).toContain("登录");
  });

  it("supports cursor pagination and mine filter", async () => {
    await start();
    const u1 = await createUser("u1@x.com");
    const u2 = await createUser("u2@x.com");
    const g1 = seedGeneration(u1, `${"1".repeat(32)}.png`);
    const g2 = seedGeneration(u1, `${"2".repeat(32)}.png`);
    const g3 = seedGeneration(u2, `${"3".repeat(32)}.png`);
    for (const g of [g1, g2, g3]) {
      await app.inject({ method: "POST", url: "/v1/plaza", headers: g === g3 ? u2.auth : u1.auth, payload: { generationId: g } });
    }

    const page1 = (await app.inject({ method: "GET", url: "/v1/plaza?limit=2", headers: u1.auth })).json();
    expect(page1.items.map((i: { id: number }) => i.id)).toEqual([g3, g2]);
    const page2 = (await app.inject({ method: "GET", url: `/v1/plaza?limit=2&before=${page1.items[1].id}`, headers: u1.auth })).json();
    expect(page2.items.map((i: { id: number }) => i.id)).toEqual([g1]);

    const mine = (await app.inject({ method: "GET", url: "/v1/plaza?mine=1", headers: u1.auth })).json();
    expect(mine.items).toHaveLength(2);
    expect(mine.items.every((i: { userId: number }) => i.userId === u1.id)).toBe(true);
  });
});

describe("DELETE /v1/plaza/:id", () => {
  it("lets the owner delete, removes the plaza file, and answers 204", async () => {
    await start();
    const u1 = await createUser("u1@x.com");
    const file = `${"e".repeat(32)}.png`;
    const genId = seedGeneration(u1, file);
    const share = (
      await app.inject({ method: "POST", url: "/v1/plaza", headers: u1.auth, payload: { generationId: genId } })
    ).json();

    const res = await app.inject({ method: "DELETE", url: `/v1/plaza/${share.id}`, headers: u1.auth });
    expect(res.statusCode).toBe(204);
    expect(fs.existsSync(path.join(dir, "plaza", file))).toBe(false);
    expect((await app.inject({ method: "GET", url: "/v1/plaza", headers: u1.auth })).json().items).toHaveLength(0);
  });

  it("answers 404 for others' shares but lets admin delete any", async () => {
    await start();
    const u1 = await createUser("u1@x.com");
    const admin = await createUser("admin@x.com", "admin");
    const genId = seedGeneration(u1, `${"f".repeat(32)}.png`);
    const share = (
      await app.inject({ method: "POST", url: "/v1/plaza", headers: u1.auth, payload: { generationId: genId } })
    ).json();
    const u2 = await createUser("u2@x.com");

    expect((await app.inject({ method: "DELETE", url: `/v1/plaza/${share.id}`, headers: u2.auth })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: `/v1/plaza/abc`, headers: u1.auth })).statusCode).toBe(400);
    expect((await app.inject({ method: "DELETE", url: `/v1/plaza/${share.id}`, headers: admin.auth })).statusCode).toBe(204);
    expect(repo.listPlazaShares(null, 10)).toHaveLength(0);
  });
});
