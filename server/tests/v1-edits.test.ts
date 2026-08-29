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

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG_BUF = Buffer.from(PNG_B64, "base64");
let upstream: ReturnType<typeof Fastify>;
let dir: string;
let repo: Repo;
let app: Awaited<ReturnType<typeof buildApp>>;
const seen = { multipart: 0, json: 0, lastFields: null as Record<string, unknown> | null, lastFiles: [] as string[] };

let upstreamMode: "accept-both" | "json-only" = "accept-both";

beforeEach(async () => {
  upstream = Fastify();
  await upstream.register(multipart);
  upstreamMode = "accept-both";
  seen.multipart = 0;
  seen.json = 0;
  seen.lastFields = null;
  seen.lastFiles = [];
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ve-"));
  repo = new Repo(openDb(dir));
  upstream.post("/v1/images/edits", async (req, reply) => {
    const ct = String(req.headers["content-type"] ?? "");
    if (ct.includes("multipart/form-data")) {
      if (upstreamMode === "json-only") return reply.code(415).send({ error: { message: "json only" } });
      seen.multipart++;
      const fields: Record<string, unknown> = {};
      const files: string[] = [];
      for await (const part of req.parts()) {
        if (part.type === "file") files.push(part.fieldname);
        else fields[part.fieldname] = part.value;
      }
      seen.lastFields = fields;
      seen.lastFiles = files;
      return reply.send({ created: 7, data: [{ b64_json: PNG_B64 }] });
    }
    seen.json++;
    const body = req.body as Record<string, unknown> | null;
    if (!body?.image) return reply.code(400).send({ error: { message: "image required", type: "invalid_request_error" } });
    seen.lastFields = body;
    return reply.send({ created: 7, data: [{ b64_json: PNG_B64 }] });
  });
  await upstream.listen({ port: 0, host: "127.0.0.1" });
  const c = repo.createChannel({ name: "mock", baseUrl: `http://127.0.0.1:${(upstream.server.address() as { port: number }).port}/v1` });
  repo.createKey(c.id, "sk-upstream");
  repo.createModel({ publicName: "img-1", channelId: c.id, upstreamName: "gpt-image-1" });
  const provider = new OpenAICompatProvider();
  const router = new ModelRouter(repo);
  const keyPool = new KeyPool(repo);
  app = await buildApp({
    env: { port: 0, dataDir: dir, adminToken: null, publicBaseUrl: null },
    repo,
    router,
    keyPool,
    provider,
    executor: new Executor({ router, keyPool, provider, repo }),
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
  fd.append("prompt", "make it blue");
  fd.append("n", "1");
  fd.append("image", new Blob([PNG_BUF], { type: "image/png" }), "a.png");
  return fd;
}

async function injectForm(fd: FormData) {
  const r = new Request("http://local/", { method: "POST", body: fd });
  return app.inject({
    method: "POST",
    url: "/v1/images/edits",
    payload: Buffer.from(await r.arrayBuffer()),
    headers: { "content-type": r.headers.get("content-type")! },
  });
}

describe("POST /v1/images/edits", () => {
  it("auto mode: multipart works and returns openai shape", async () => {
    const res = await injectForm(makeForm());
    expect(res.statusCode).toBe(200);
    expect(res.json().created).toBe(7);
    expect(res.json().data[0].b64_json).toBe(PNG_B64);
    expect(seen.multipart).toBe(1);
    expect(seen.lastFiles).toEqual(["image"]);
    expect(seen.lastFields!.prompt).toBe("make it blue");
    expect(repo.recentLogs(1)[0].status).toBe("ok");
  });

  it("auto mode: falls back to json-base64 when upstream rejects multipart", async () => {
    upstreamMode = "json-only";
    const res = await injectForm(makeForm());
    expect(res.statusCode).toBe(200);
    expect(seen.json).toBe(1);
    expect(String(seen.lastFields!.image)).toMatch(/^data:image\/png;base64,/);
  });

  it("multipart forced mode keeps failing upstream status", async () => {
    const c = repo.listChannels()[0];
    repo.updateChannel(c.id, { editMode: "multipart" });
    upstreamMode = "json-only";
    const res = await injectForm(makeForm());
    expect(res.statusCode).toBe(415);
  });

  it("json-base64 forced mode sends json directly", async () => {
    const c = repo.listChannels()[0];
    repo.updateChannel(c.id, { editMode: "json-base64" });
    const res = await injectForm(makeForm());
    expect(res.statusCode).toBe(200);
    expect(seen.multipart).toBe(0);
    expect(seen.json).toBe(1);
    expect(seen.lastFields!.model).toBe("gpt-image-1");
  });

  it("400 when image file missing", async () => {
    const fd = new FormData();
    fd.append("model", "img-1");
    fd.append("prompt", "x");
    const res = await injectForm(fd);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.type).toBe("invalid_request_error");
  });

  it("400 on non-multipart request", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/images/edits", payload: { model: "img-1", prompt: "x" } });
    expect(res.statusCode).toBe(400);
  });
});
