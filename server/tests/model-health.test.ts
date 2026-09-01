import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { Executor } from "../src/core/executor.js";
import { KeyPool } from "../src/core/keyPool.js";
import { hashPassword } from "../src/core/password.js";
import { ModelRouter } from "../src/core/router.js";
import type { ImageProvider } from "../src/core/types.js";
import { openDb } from "../src/store/db.js";
import { Repo } from "../src/store/repo.js";

const provider: ImageProvider = {
  kind: "fake",
  async generate() {
    throw new Error("not used");
  },
  async edit() {
    throw new Error("not used");
  },
  async test() {
    return { ok: true, message: "" };
  },
};

let dir: string;
let repo: Repo;
let router: ModelRouter;
let app: Awaited<ReturnType<typeof buildApp>>;
let userId: number;
let userHeaders: { authorization: string };

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mh-"));
  repo = new Repo(openDb(dir));
  userId = repo.createUser({
    email: "health@x.com",
    passwordHash: hashPassword("user-pass"),
    role: "user",
    quotaTotal: null,
  }).id;
  router = new ModelRouter(repo);
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
  const login = await app.inject({
    method: "POST",
    url: "/admin/auth/login",
    payload: { email: "health@x.com", password: "user-pass" },
  });
  userHeaders = { authorization: `Bearer ${(login.json() as { token: string }).token}` };
});

afterEach(async () => {
  await app.close();
  repo.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function createRoute(
  model: string,
  channelName: string,
  options: { channelEnabled?: boolean; key?: boolean; supportsImageToImage?: boolean; supportsNsfw?: boolean; priority?: number } = {},
) {
  const channel = repo.createChannel({
    name: channelName,
    baseUrl: `https://${channelName}.secret.test/v1`,
    enabled: options.channelEnabled,
    extraHeaders: { Authorization: "secret-header" },
  });
  const key = options.key === false ? null : repo.createKey(channel.id, `sk-secret-${channelName}`);
  const mapping = repo.createModel({
    publicName: model,
    channelId: channel.id,
    upstreamName: `upstream-${channelName}`,
    priority: options.priority,
    supportsImageToImage: options.supportsImageToImage,
    supportsNsfw: options.supportsNsfw,
  });
  return { channel, key, mapping };
}

function insertLog(input: {
  ts: number;
  model: string;
  channelId: number;
  status: "ok" | "error";
  latencyMs: number | null;
  errorMessage?: string | null;
}) {
  repo.insertLog({
    ...input,
    apiKeyId: null,
    httpStatus: input.status === "ok" ? 200 : 500,
    errorMessage: input.errorMessage ?? null,
  });
}

async function getHealth() {
  return app.inject({ url: "/v1/model-health", headers: userHeaders });
}

describe("GET /v1/model-health authentication", () => {
  it("requires a logged-in user, accepts user JWT, and rejects API keys", async () => {
    createRoute("img", "auth-route");
    const apiKey = repo.createApiKey("client-key", userId);

    expect((await app.inject({ url: "/v1/model-health" })).statusCode).toBe(401);
    expect(
      (await app.inject({
        url: "/v1/model-health",
        headers: { authorization: `Bearer ${apiKey.key}` },
      })).statusCode,
    ).toBe(401);

    const accepted = await getHealth();
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ sampleLimit: 50 });
    expect(typeof accepted.json().generatedAt).toBe("number");
  });
});

describe("GET /v1/model-health visibility and aggregation", () => {
  it("hides NSFW mappings until the user is explicitly allowed", async () => {
    createRoute("safe", "safe-route");
    createRoute("adult", "adult-route", { supportsNsfw: true });
    expect((await getHealth()).json().models.map((model: { model: string }) => model.model)).toEqual(["safe"]);

    repo.updateUser(userId, { allowNsfw: true });
    expect((await getHealth()).json().models.map((model: { model: string }) => model.model)).toEqual(["safe", "adult"]);
  });
  it("filters mappings and logs by allowedChannelIds", async () => {
    const visible = createRoute("shared", "visible");
    const hidden = createRoute("shared", "hidden");
    const hiddenOnly = createRoute("hidden-only", "hidden-only");
    const group = repo.createGroup("visible-group");
    repo.setGroupChannels(group.id, [visible.channel.id]);
    repo.setUserGroups(userId, [group.id]);

    insertLog({ ts: 100, model: "shared", channelId: visible.channel.id, status: "ok", latencyMs: 20 });
    insertLog({
      ts: 200,
      model: "shared",
      channelId: hidden.channel.id,
      status: "error",
      latencyMs: 900,
      errorMessage: "hidden failure",
    });
    insertLog({ ts: 300, model: "hidden-only", channelId: hiddenOnly.channel.id, status: "ok", latencyMs: 10 });
    insertLog({ ts: 400, model: "shared", channelId: 999, status: "error", latencyMs: 800, errorMessage: "orphan failure" });
    insertLog({ ts: 500, model: "shared", channelId: hiddenOnly.channel.id, status: "error", latencyMs: 700, errorMessage: "different model route" });

    const body = (await getHealth()).json();
    expect(body.models).toHaveLength(1);
    expect(body.models[0]).toMatchObject({
      model: "shared",
      status: "healthy",
      routes: { total: 1, available: 1 },
      requests: {
        sampleSize: 1,
        successful: 1,
        failed: 0,
        successRate: 1,
        averageLatencyMs: 20,
        lastRequestAt: 100,
      },
      recent: [{ ts: 100, status: "ok", latencyMs: 20 }],
    });
    expect(JSON.stringify(body)).not.toContain("hidden-only");
    expect(JSON.stringify(body)).not.toContain("hidden failure");
  });

  it("aggregates enabled mappings with the same public name", async () => {
    const first = createRoute("multi", "multi-a", { supportsImageToImage: false, priority: 0 });
    const second = createRoute("multi", "multi-b", { supportsImageToImage: true, priority: 10 });
    repo.createModel({ publicName: "multi", channelId: first.channel.id, upstreamName: "upstream-multi-a-backup", priority: 20 });
    insertLog({ ts: 10, model: "multi", channelId: first.channel.id, status: "ok", latencyMs: 100 });
    insertLog({ ts: 20, model: "multi", channelId: second.channel.id, status: "ok", latencyMs: 300 });

    const model = (await getHealth()).json().models[0];
    expect(model).toEqual({
      model: "multi",
      status: "healthy",
      supportsImageToImage: true,
      routes: { total: 3, available: 3 },
      requests: {
        sampleSize: 1,
        successful: 1,
        failed: 0,
        successRate: 1,
        averageLatencyMs: 100,
        lastRequestAt: 10,
      },
      recent: [{ ts: 10, status: "ok", latencyMs: 100 }],
    });
  });
});

describe("GET /v1/model-health statuses", () => {
  it("reports healthy, degraded, unavailable, and unknown", async () => {
    const healthy = createRoute("healthy", "healthy-route");
    insertLog({ ts: 10, model: "healthy", channelId: healthy.channel.id, status: "ok", latencyMs: 50 });

    const degradedByFailure = createRoute("degraded-failure", "degraded-failure-route");
    insertLog({ ts: 20, model: "degraded-failure", channelId: degradedByFailure.channel.id, status: "error", latencyMs: 60 });

    const degradedByCircuitAvailable = createRoute("degraded-circuit", "degraded-circuit-open", { priority: 10 });
    const degradedByCircuitBackup = createRoute("degraded-circuit", "degraded-circuit-backup", { priority: 0 });
    router.markFailure(degradedByCircuitAvailable.channel.id);
    router.markFailure(degradedByCircuitAvailable.channel.id);
    router.markFailure(degradedByCircuitAvailable.channel.id);
    insertLog({ ts: 25, model: "degraded-circuit", channelId: degradedByCircuitAvailable.channel.id, status: "error", latencyMs: 90 });
    insertLog({ ts: 30, model: "degraded-circuit", channelId: degradedByCircuitBackup.channel.id, status: "ok", latencyMs: 70 });

    createRoute("unavailable", "unavailable-route", { key: false });
    createRoute("unknown", "unknown-route");

    const models = (await getHealth()).json().models as Array<Record<string, unknown>>;
    const byName = new Map(models.map((model) => [model.model, model]));
    expect(byName.get("healthy")).toMatchObject({ status: "healthy", routes: { total: 1, available: 1 } });
    expect(byName.get("degraded-failure")).toMatchObject({ status: "degraded", requests: { failed: 1 } });
    expect(byName.get("degraded-circuit")).toMatchObject({
      status: "healthy",
      routes: { total: 2, available: 1 },
      requests: { sampleSize: 1, successful: 1, failed: 0, averageLatencyMs: 70 },
    });
    expect(byName.get("unavailable")).toMatchObject({ status: "unavailable", routes: { total: 1, available: 0 } });
    expect(byName.get("unknown")).toMatchObject({
      status: "unknown",
      routes: { total: 1, available: 1 },
      requests: { sampleSize: 0, successRate: null, averageLatencyMs: null, lastRequestAt: null },
      recent: [],
    });
  });

  it("treats disabled channels and cooling keys as unavailable, but reports circuit fallback as degraded", async () => {
    createRoute("disabled", "disabled-route", { channelEnabled: false });
    const coolingKey = createRoute("key-cooling", "key-cooling-route");
    repo.setKeyCooldown(coolingKey.key!.id, Date.now() + 60_000);
    const circuit = createRoute("circuit-only", "circuit-only-route");
    router.markFailure(circuit.channel.id);
    router.markFailure(circuit.channel.id);
    router.markFailure(circuit.channel.id);

    const models = (await getHealth()).json().models as Array<Record<string, unknown>>;
    for (const name of ["disabled", "key-cooling"]) {
      expect(models.find((model) => model.model === name)).toMatchObject({
        status: "unavailable",
        routes: { total: 1, available: 0 },
      });
    }
    expect(models.find((model) => model.model === "circuit-only")).toMatchObject({
      status: "degraded",
      routes: { total: 1, available: 1 },
    });
  });
});

describe("GET /v1/model-health sampling, redaction, and side effects", () => {
  it("uses the latest global 50 real calls, exposes at most 10 recent entries, and redacts internals", async () => {
    const route = createRoute("sampled", "secret-channel");
    for (let i = 1; i <= 55; i += 1) {
      insertLog({
        ts: i,
        model: "sampled",
        channelId: route.channel.id,
        status: i === 5 ? "error" : "ok",
        latencyMs: i,
        errorMessage: i === 5 ? "https://secret.error.test key=sk-top-secret" : null,
      });
    }

    const body = (await getHealth()).json();
    const model = body.models[0];
    expect(body.sampleLimit).toBe(50);
    expect(model.status).toBe("healthy");
    expect(model.requests).toMatchObject({
      sampleSize: 50,
      successful: 50,
      failed: 0,
      successRate: 1,
      averageLatencyMs: 31,
      lastRequestAt: 55,
    });
    expect(model.recent).toHaveLength(10);
    expect(model.recent[0]).toEqual({ ts: 55, status: "ok", latencyMs: 55 });
    expect(Object.keys(model.recent[0]).sort()).toEqual(["latencyMs", "status", "ts"]);

    const serialized = JSON.stringify(body);
    for (const secret of [
      "secret-channel",
      "sk-secret-secret-channel",
      "https://secret-channel.secret.test/v1",
      "secret-header",
      "https://secret.error.test",
      "sk-top-secret",
      "upstream-secret-channel",
      "channelId",
      "apiKeyId",
      "errorMessage",
      "httpStatus",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("does not call router.resolve or advance round-robin polling", async () => {
    const first = createRoute("polling", "polling-a");
    const second = createRoute("polling", "polling-b");
    const resolveSpy = vi.spyOn(router, "resolve");

    await getHealth();

    expect(resolveSpy).not.toHaveBeenCalled();
    expect(router.resolve("polling")!.channel.id).toBe(first.channel.id);
    expect(router.resolve("polling")!.channel.id).toBe(second.channel.id);
  });

  it("leaves /health unchanged", async () => {
    expect((await app.inject({ url: "/health" })).json()).toEqual({ ok: true });
    await getHealth();
    expect((await app.inject({ url: "/health" })).json()).toEqual({ ok: true });
  });
});
