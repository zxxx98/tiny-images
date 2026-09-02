import Fastify from "fastify";
import multipart from "@fastify/multipart";
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
import type { ImageProvider } from "../src/core/types.js";

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG_BUF = Buffer.from(PNG_B64, "base64");
let upstream: ReturnType<typeof Fastify>;
let dir: string;
let repo: Repo;
let app: Awaited<ReturnType<typeof buildApp>>;
const seen = { calls: 0, fields: null as Record<string, unknown> | null, files: [] as string[] };

beforeEach(async () => {
  upstream = Fastify();
  await upstream.register(multipart);
  seen.calls = 0;
  seen.fields = null;
  seen.files = [];
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "vv-"));
  repo = new Repo(openDb(dir));
  upstream.post("/v1/images/variations", async (req) => {
    seen.calls++;
    const fields: Record<string, unknown> = {};
    const files: string[] = [];
    for await (const part of req.parts()) {
      if (part.type === "file") files.push(part.fieldname);
      else fields[part.fieldname] = part.value;
    }
    seen.fields = fields;
    seen.files = files;
    return { created: 7, data: [{ b64_json: PNG_B64 }] };
  });
  await upstream.listen({ port: 0, host: "127.0.0.1" });
  const c = repo.createChannel({ name: "mock", baseUrl: `http://127.0.0.1:${(upstream.server.address() as { port: number }).port}/v1` });
  repo.createKey(c.id, "sk-upstream");
  repo.createModel({ publicName: "img-1", channelId: c.id, upstreamName: "dall-e-2" });
  const provider = new OpenAICompatProvider();
  const horde: ImageProvider = {
    kind: "ai-horde",
    async generate() { throw new Error("not used"); },
    async edit() { throw new Error("not used"); },
    async test() { return { ok: true, message: "ok" }; },
  };
  const providers = new Map<string, ImageProvider>([["openai-compat", provider], ["ai-horde", horde]]);
  const router = new ModelRouter(repo);
  const keyPool = new KeyPool(repo);
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
});

afterEach(async () => {
  await app.close();
  await upstream.close();
  repo.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function makeForm(model = "img-1"): FormData {
  const fd = new FormData();
  fd.append("model", model);
  fd.append("n", "1");
  fd.append("image", new Blob([PNG_BUF], { type: "image/png" }), "a.png");
  return fd;
}

async function injectForm(fd: FormData) {
  const r = new Request("http://local/", { method: "POST", body: fd });
  return app.inject({
    method: "POST",
    url: "/v1/images/variations",
    payload: Buffer.from(await r.arrayBuffer()),
    headers: { "content-type": r.headers.get("content-type")! },
  });
}

describe("POST /v1/images/variations", () => {
  it("forwards a single image to the upstream variations endpoint", async () => {
    const res = await injectForm(makeForm());
    expect(res.statusCode).toBe(200);
    expect(res.json().created).toBe(7);
    expect(res.json().data[0].b64_json).toBe(PNG_B64);
    expect(seen.calls).toBe(1);
    expect(seen.files).toEqual(["image"]);
    expect(seen.fields!.model).toBe("dall-e-2");
    expect(seen.fields).not.toHaveProperty("prompt");
    expect(repo.recentLogs(1)[0].status).toBe("ok");
  });

  it("localizes results when response_format=url", async () => {
    const fd = makeForm();
    fd.append("response_format", "url");
    const res = await injectForm(fd);
    expect(res.statusCode).toBe(200);
    expect(res.json().data[0].url).toMatch(/\/files\/[0-9a-f]{32}\.png$/);
  });

  it("records history with empty prompt and variation marker", async () => {
    await injectForm(makeForm());
    const rows = repo.listGenerations({ admin: true, userId: null, apiKeyId: null }, null, 10);
    expect(rows.length).toBe(1);
    expect(rows[0].prompt).toBe("");
    const params = JSON.parse(rows[0].params) as Record<string, unknown>;
    expect(params.kind).toBe("variation");
    expect(JSON.parse(rows[0].images).length).toBe(1);
  });

  it("400 when image file missing", async () => {
    const fd = new FormData();
    fd.append("model", "img-1");
    const res = await injectForm(fd);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.type).toBe("invalid_request_error");
  });

  it("400 when more than one image is sent", async () => {
    const fd = makeForm();
    fd.append("image", new Blob([PNG_BUF], { type: "image/png" }), "b.png");
    const res = await injectForm(fd);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain("exactly one");
  });

  it("400 on non-multipart request", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/images/variations", payload: { model: "img-1" } });
    expect(res.statusCode).toBe(400);
  });

  it("400 with clear message for channels without variation support", async () => {
    const horde = repo.createChannel({ name: "horde", type: "ai-horde", baseUrl: "https://aihorde.net/api/v2" });
    repo.createKey(horde.id, "0000000000");
    repo.createModel({ publicName: "horde-model", channelId: horde.id, upstreamName: "stable_diffusion" });
    const fd = makeForm("horde-model");
    const res = await injectForm(fd);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain("does not support image variations");
  });

  it("400 for chat-mode openai-compat channels", async () => {
    const c = repo.listChannels()[0];
    repo.updateChannel(c.id, { generationMode: "chat" });
    const res = await injectForm(makeForm());
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain("does not support image variations");
    expect(seen.calls).toBe(0);
  });
});
