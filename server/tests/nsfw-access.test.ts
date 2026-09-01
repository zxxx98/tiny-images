import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { Executor } from "../src/core/executor.js";
import { KeyPool } from "../src/core/keyPool.js";
import { hashPassword } from "../src/core/password.js";
import { ModelRouter } from "../src/core/router.js";
import type { ImageProvider } from "../src/core/types.js";
import { openDb } from "../src/store/db.js";
import { Repo } from "../src/store/repo.js";
import { JobManager } from "../src/server/jobs.js";

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

let dir: string;
let repo: Repo;
let app: Awaited<ReturnType<typeof buildApp>>;
let calls: { generate: number; edit: number };
let deniedKey: string;
let allowedKey: string;
let unboundKey: string;

const auth = (key: string) => ({ authorization: `Bearer ${key}` });

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "nsfw-"));
  repo = new Repo(openDb(dir));
  calls = { generate: 0, edit: 0 };
  const channel = repo.createChannel({ name: "mock", baseUrl: "https://upstream.test/v1" });
  repo.createKey(channel.id, "sk-upstream");
  repo.createModel({ publicName: "safe", channelId: channel.id });
  repo.createModel({ publicName: "adult", channelId: channel.id, supportsNsfw: true });

  const denied = repo.createUser({ email: "denied@x.com", passwordHash: hashPassword("password"), role: "user", quotaTotal: 100 });
  const allowed = repo.createUser({ email: "allowed@x.com", passwordHash: hashPassword("password"), role: "user", quotaTotal: 100, allowNsfw: true });
  deniedKey = repo.createApiKey("denied", denied.id).key;
  allowedKey = repo.createApiKey("allowed", allowed.id).key;
  unboundKey = repo.createApiKey("unbound").key;

  const provider: ImageProvider = {
    kind: "openai-compat",
    async generate() {
      calls.generate += 1;
      return { created: 1, images: [{ b64: PNG_B64 }] };
    },
    async edit() {
      calls.edit += 1;
      return { created: 1, images: [{ b64: PNG_B64 }] };
    },
    async test() {
      return { ok: true, message: "ok" };
    },
  };
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
    jobManager: new JobManager(),
    logger: false,
    webDist: null,
  });
});

afterEach(async () => {
  await app.close();
  repo.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function models(key?: string): Promise<string[]> {
  const response = await app.inject({ url: "/v1/models", ...(key ? { headers: auth(key) } : {}) });
  expect(response.statusCode).toBe(200);
  return response.json().data.map((model: { id: string }) => model.id);
}

async function waitForJob(key: string, jobId: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await app.inject({ url: `/v1/images/jobs/${jobId}`, headers: auth(key) });
    const body = response.json() as Record<string, unknown>;
    if (body.status !== "running") return body;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("job did not finish");
}

describe("NSFW model access", () => {
  it("hides and rejects restricted models unless the bound user is allowed", async () => {
    expect(await models(deniedKey)).toEqual(["safe"]);
    expect(await models(unboundKey)).toEqual(["safe"]);
    expect(await models(allowedKey)).toEqual(["safe", "adult"]);

    const denied = await app.inject({
      method: "POST", url: "/v1/images/generations", headers: auth(deniedKey),
      payload: { model: "adult", prompt: "x" },
    });
    const unbound = await app.inject({
      method: "POST", url: "/v1/images/generations", headers: auth(unboundKey),
      payload: { model: "adult", prompt: "x" },
    });
    const allowed = await app.inject({
      method: "POST", url: "/v1/images/generations", headers: auth(allowedKey),
      payload: { model: "adult", prompt: "x" },
    });
    expect(denied.statusCode).toBe(404);
    expect(unbound.statusCode).toBe(404);
    expect(allowed.statusCode).toBe(200);
    expect(calls.generate).toBe(1);
  });

  it("denies restricted models in open mode", async () => {
    for (const key of repo.listApiKeys()) repo.deleteApiKey(key.id);
    expect(await models()).toEqual(["safe"]);
    const response = await app.inject({
      method: "POST", url: "/v1/images/generations",
      payload: { model: "adult", prompt: "x" },
    });
    expect(response.statusCode).toBe(404);
    expect(calls.generate).toBe(0);
  });

  it("checks policy before starting a stream or edit", async () => {
    const stream = await app.inject({
      method: "POST", url: "/v1/images/generations", headers: auth(deniedKey),
      payload: { model: "adult", prompt: "x", stream: true },
    });
    expect(stream.statusCode).toBe(404);
    expect(stream.headers["content-type"]).toContain("application/json");

    const form = new FormData();
    form.append("model", "adult");
    form.append("prompt", "x");
    form.append("image", new Blob([Buffer.from(PNG_B64, "base64")], { type: "image/png" }), "x.png");
    const request = new Request("http://local/", { method: "POST", body: form });
    const edit = await app.inject({
      method: "POST", url: "/v1/images/edits",
      headers: { ...auth(deniedKey), "content-type": request.headers.get("content-type")! },
      payload: Buffer.from(await request.arrayBuffer()),
    });
    expect(edit.statusCode).toBe(404);
    expect(calls).toEqual({ generate: 0, edit: 0 });
  });

  it("applies policy to background generation jobs", async () => {
    const denied = await app.inject({
      method: "POST", url: "/v1/images/jobs", headers: auth(deniedKey),
      payload: { model: "adult", prompt: "x" },
    });
    expect(denied.statusCode).toBe(200);
    const deniedJob = await waitForJob(deniedKey, denied.json().jobId);
    expect(deniedJob.status).toBe("error");

    const allowed = await app.inject({
      method: "POST", url: "/v1/images/jobs", headers: auth(allowedKey),
      payload: { model: "adult", prompt: "x" },
    });
    const allowedJob = await waitForJob(allowedKey, allowed.json().jobId);
    expect(allowedJob.status).toBe("ok");
    expect(calls.generate).toBe(1);
  });
});
