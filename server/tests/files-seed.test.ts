import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { seedIfEmpty } from "../src/store/seed.js";
import { buildApp } from "../src/app.js";
import { Executor } from "../src/core/executor.js";
import { KeyPool } from "../src/core/keyPool.js";
import { ModelRouter } from "../src/core/router.js";
import type { ImageProvider } from "../src/core/types.js";
import { saveGeneratedImage } from "../src/media/b64cache.js";
import { openDb } from "../src/store/db.js";
import { Repo } from "../src/store/repo.js";

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
let dir: string;
let repo: Repo;
const provider: ImageProvider = {
  kind: "fake",
  async generate() {
    throw new Error("x");
  },
  async edit() {
    throw new Error("x");
  },
  async test() {
    return { ok: true, message: "" };
  },
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-"));
  repo = new Repo(openDb(dir));
});

describe("seedIfEmpty", () => {
  it("imports config.yaml when db empty", () => {
    fs.writeFileSync(
      path.join(dir, "config.yaml"),
      `
channels:
  - name: openai
    baseUrl: https://api.openai.com/v1
    keys: [sk-a, sk-b]
    timeoutMs: 90000
models:
  - name: gpt-image-1
    channel: openai
`,
    );
    seedIfEmpty(dir, repo);
    const c = repo.listChannels()[0];
    expect(c.name).toBe("openai");
    expect(c.timeoutMs).toBe(90000);
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
    const router = new ModelRouter(repo);
    const keyPool = new KeyPool(repo);
    const app = await buildApp({
      env: { port: 0, dataDir: dir, adminToken: null, publicBaseUrl: null },
      repo,
      router,
      keyPool,
      provider,
      executor: new Executor({ router, keyPool, provider, repo }),
      logger: false,
      webDist: null,
    });
    const { fileName } = saveGeneratedImage(dir, PNG_B64);
    const ok = await app.inject({ url: `/files/${fileName}` });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["content-type"]).toBe("image/png");
    expect(ok.rawPayload).toEqual(Buffer.from(PNG_B64, "base64"));
    expect((await app.inject({ url: "/files/../secret" })).statusCode).toBe(404);
    expect((await app.inject({ url: "/files/zzz.png" })).statusCode).toBe(404);
    await app.close();
  });
});
