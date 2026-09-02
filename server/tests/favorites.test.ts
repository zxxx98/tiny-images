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

let dir: string;
let repo: Repo;
let app: Awaited<ReturnType<typeof buildApp>>;
let H: { authorization: string };
let H2: { authorization: string };

async function login(email: string, password: string): Promise<{ authorization: string }> {
  const res = await app.inject({ method: "POST", url: "/admin/auth/login", payload: { email, password } });
  return { authorization: `Bearer ${(res.json() as { token: string }).token}` };
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fav-"));
  repo = new Repo(openDb(dir));
  repo.createUser({ email: "admin@local", passwordHash: hashPassword("admin-pass"), role: "admin", quotaTotal: null });
  repo.createUser({ email: "user@local", passwordHash: hashPassword("user-pass"), role: "user", quotaTotal: 100 });
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
  H = await login("admin@local", "admin-pass");
  H2 = await login("user@local", "user-pass");
});

afterEach(async () => {
  await app.close();
  repo.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("prompt favorites", () => {
  it("requires authentication", async () => {
    const list = await app.inject({ url: "/v1/prompt-favorites" });
    expect(list.statusCode).toBe(401);
    const create = await app.inject({ method: "POST", url: "/v1/prompt-favorites", payload: { prompt: "x" } });
    expect(create.statusCode).toBe(401);
  });

  it("creates, lists and deletes favorites", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/v1/prompt-favorites",
      headers: H,
      payload: { prompt: "  a white cat, cinematic  " },
    });
    expect(created.statusCode).toBe(201);
    const row = created.json() as { id: number; content: string };
    expect(row.content).toBe("a white cat, cinematic");

    await app.inject({ method: "POST", url: "/v1/prompt-favorites", headers: H, payload: { prompt: "second" } });
    const list = await app.inject({ url: "/v1/prompt-favorites", headers: H });
    const rows = list.json() as { id: number; content: string }[];
    expect(rows.map((r) => r.content)).toEqual(["second", "a white cat, cinematic"]);

    const del = await app.inject({ method: "DELETE", url: `/v1/prompt-favorites/${rows[0].id}`, headers: H });
    expect(del.statusCode).toBe(204);
    const after = await app.inject({ url: "/v1/prompt-favorites", headers: H });
    expect((after.json() as { content: string }[]).map((r) => r.content)).toEqual(["a white cat, cinematic"]);
  });

  it("rejects an empty or oversized prompt", async () => {
    const empty = await app.inject({ method: "POST", url: "/v1/prompt-favorites", headers: H, payload: { prompt: "   " } });
    expect(empty.statusCode).toBe(400);
    const big = await app.inject({ method: "POST", url: "/v1/prompt-favorites", headers: H, payload: { prompt: "x".repeat(4001) } });
    expect(big.statusCode).toBe(400);
  });

  it("isolates favorites per user", async () => {
    const created = await app.inject({ method: "POST", url: "/v1/prompt-favorites", headers: H, payload: { prompt: "admin only" } });
    const id = (created.json() as { id: number }).id;

    const other = await app.inject({ url: "/v1/prompt-favorites", headers: H2 });
    expect(other.json()).toEqual([]);

    const crossDelete = await app.inject({ method: "DELETE", url: `/v1/prompt-favorites/${id}`, headers: H2 });
    expect(crossDelete.statusCode).toBe(404);

    const del = await app.inject({ method: "DELETE", url: `/v1/prompt-favorites/${id}`, headers: H });
    expect(del.statusCode).toBe(204);
  });

  it("400 on unknown favorite id", async () => {
    const res = await app.inject({ method: "DELETE", url: "/v1/prompt-favorites/999", headers: H });
    expect(res.statusCode).toBe(404);
  });
});
