import Fastify from "fastify";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { Executor } from "../src/core/executor.js";
import { KeyPool } from "../src/core/keyPool.js";
import { ModelRouter } from "../src/core/router.js";
import { AIHordeProvider } from "../src/providers/ai-horde.js";
import { OpenAICompatProvider } from "../src/providers/openai-compat.js";
import { createProviderRegistry } from "../src/providers/registry.js";
import { JobManager } from "../src/server/jobs.js";
import { openDb } from "../src/store/db.js";
import { Repo } from "../src/store/repo.js";

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG_BUF = Buffer.from(PNG_B64, "base64");
let upstream: ReturnType<typeof Fastify>;
let app: Awaited<ReturnType<typeof buildApp>>;
let repo: Repo;
let dir: string;
let submitBodies: Record<string, unknown>[];

beforeEach(async () => {
  upstream = Fastify();
  submitBodies = [];
  let task = 0;
  upstream.post("/api/v2/generate/async", async (request) => {
    submitBodies.push(request.body as Record<string, unknown>);
    task++;
    return { id: `task-${task}` };
  });
  upstream.get("/api/v2/generate/check/:id", async () => ({ done: true, is_possible: true }));
  upstream.get("/api/v2/generate/status/:id", async () => ({
    generations: [{
      img: `http://127.0.0.1:${(upstream.server.address() as { port: number }).port}/image.png`,
      seed: "77",
      model: "Pony Diffusion",
      censored: false,
    }],
  }));
  upstream.get("/image.png", async (_request, reply) => reply.type("image/png").send(PNG_BUF));
  await upstream.listen({ port: 0, host: "127.0.0.1" });

  dir = fs.mkdtempSync(path.join(os.tmpdir(), "vh-"));
  repo = new Repo(openDb(dir));
  const channel = repo.createChannel({
    name: "horde",
    type: "ai-horde",
    baseUrl: `http://127.0.0.1:${(upstream.server.address() as { port: number }).port}/api/v2`,
    timeoutMs: 5000,
  });
  repo.createKey(channel.id, "0000000000");
  repo.createModel({ publicName: "pony", channelId: channel.id, upstreamName: "Pony Diffusion" });
  const providers = createProviderRegistry(new OpenAICompatProvider(), new AIHordeProvider({ pollIntervalMs: 1 }));
  const router = new ModelRouter(repo);
  const keyPool = new KeyPool(repo);
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
  await upstream.close();
  repo.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function parseEvents(body: string): { events: Record<string, unknown>[]; hasDone: boolean } {
  const frames = body.split("\n\n").filter((frame) => frame.startsWith("data: "));
  return {
    hasDone: frames.includes("data: [DONE]"),
    events: frames.filter((frame) => frame !== "data: [DONE]").map((frame) => JSON.parse(frame.slice(6)) as Record<string, unknown>),
  };
}

async function injectForm(url: string, form: FormData) {
  const request = new Request("http://local/", { method: "POST", body: form });
  return app.inject({
    method: "POST",
    url,
    payload: Buffer.from(await request.arrayBuffer()),
    headers: { "content-type": request.headers.get("content-type")! },
  });
}

function editForm(mask = false): FormData {
  const form = new FormData();
  form.append("model", "pony");
  form.append("prompt", "paint it blue");
  form.append("horde", JSON.stringify({ shared: false }));
  form.append("image", new Blob([PNG_BUF], { type: "image/png" }), "source.png");
  if (mask) form.append("mask", new Blob([PNG_BUF], { type: "image/png" }), "mask.png");
  return form;
}

async function waitJob(jobId: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const response = await app.inject({ url: `/v1/images/jobs/${jobId}` });
    const body = response.json() as Record<string, unknown>;
    if (body.status !== "running") return body;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`job ${jobId} did not finish`);
}

describe("AI Horde OpenAI-compatible endpoints", () => {
  it("serves synchronous generations without leaking Horde status fields", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/images/generations",
      payload: { model: "pony", prompt: "cat", n: 2, size: "1024x768", horde: { nsfw: true, params: { steps: 12 } } },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data[0].url).toContain("/image.png");
    expect(response.json()).not.toHaveProperty("generations");
    expect(submitBodies[0]).toMatchObject({ models: ["Pony Diffusion"], nsfw: true, params: { n: 2, width: 1024, height: 768, steps: 12 } });
  });

  it("supports SSE and detached generation jobs", async () => {
    const stream = await app.inject({ method: "POST", url: "/v1/images/generations", payload: { model: "pony", prompt: "cat", stream: true } });
    const events = parseEvents(stream.body);
    expect(events.hasDone).toBe(true);
    expect(events.events.some((event) => event.type === "completed")).toBe(true);

    const created = await app.inject({ method: "POST", url: "/v1/images/jobs", payload: { model: "pony", prompt: "cat", horde: { params: { steps: 9 } } } });
    const job = await waitJob(created.json().jobId);
    expect(job.status).toBe("ok");
    expect((job.images as unknown[])).toHaveLength(1);
    expect(submitBodies.at(-1)?.params).toMatchObject({ steps: 9 });
  });

  it("supports synchronous img2img and detached inpainting jobs", async () => {
    const img2img = await injectForm("/v1/images/edits", editForm(false));
    expect(img2img.statusCode).toBe(200);
    expect(submitBodies.at(-1)).toMatchObject({ source_processing: "img2img", shared: false });

    const inpainting = await injectForm("/v1/images/edit-jobs", editForm(true));
    expect(inpainting.statusCode).toBe(200);
    const job = await waitJob(inpainting.json().jobId);
    expect(job.status).toBe("ok");
    expect(submitBodies.at(-1)).toMatchObject({ source_processing: "inpainting" });
  });
});
