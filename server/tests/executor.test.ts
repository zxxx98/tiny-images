import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { Executor } from "../src/core/executor.js";
import { KeyPool } from "../src/core/keyPool.js";
import { ModelRouter } from "../src/core/router.js";
import { UpstreamError } from "../src/core/errors.js";
import type { CallContext, ImageProvider, UnifiedEditRequest, UnifiedGenRequest, UnifiedImageResult } from "../src/core/types.js";
import { openDb } from "../src/store/db.js";
import { Repo } from "../src/store/repo.js";

const gen = (): UnifiedGenRequest => ({ prompt: "p", n: 1, responseFormat: "b64_json", passthrough: {} });
const ok: UnifiedImageResult = { created: 1, images: [{ b64: "AA" }] };

function fakeProvider(scripts: Array<(ctx: CallContext) => Promise<UnifiedImageResult>>): ImageProvider {
  let i = 0;
  return {
    kind: "fake",
    async generate(_r, ctx) {
      return scripts[Math.min(i++, scripts.length - 1)](ctx);
    },
    async edit() {
      return ok;
    },
    async test() {
      return { ok: true, message: "" };
    },
  };
}

let repo: Repo;
let channelId: number;
beforeEach(() => {
  repo = new Repo(openDb(fs.mkdtempSync(path.join(os.tmpdir(), "ex-"))));
  channelId = repo.createChannel({ name: "a", baseUrl: "https://x/v1" }).id;
  repo.createModel({ publicName: "img", channelId, upstreamName: "up" });
  repo.createKey(channelId, "sk-1");
  repo.createKey(channelId, "sk-2");
});
const build = (provider: ImageProvider) =>
  new Executor({ router: new ModelRouter(repo), keyPool: new KeyPool(repo), provider, repo });

describe("Executor", () => {
  it("succeeds on first key and logs ok", async () => {
    const ex = build(
      fakeProvider([
        async (ctx) => {
          expect(ctx.apiKey).toBe("sk-1");
          expect(ctx.upstreamModel).toBe("up");
          return ok;
        },
      ]),
    );
    const r = await ex.generate("img", gen(), { callerApiKeyId: 7 });
    expect(r.channel.name).toBe("a");
    expect(r.result.images).toEqual([{ b64: "AA" }]);
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
    const logs = repo.recentLogs(10);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ model: "img", status: "ok", httpStatus: 200, apiKeyId: 7, channelId });
  });

  it("rotates key on 401 then succeeds", async () => {
    const ex = build(
      fakeProvider([
        async (ctx) => {
          if (ctx.apiKey === "sk-1") throw new UpstreamError(401, "invalid_request_error", "bad key");
          return ok;
        },
      ]),
    );
    const r = await ex.generate("img", gen(), { callerApiKeyId: null });
    expect(r.result.images).toEqual([{ b64: "AA" }]);
    expect(repo.listKeys(channelId).find((k) => k.apiKey === "sk-1")!.cooldownUntil).toBeGreaterThan(Date.now());
  });

  it("gives up after exhausting keys and logs error", async () => {
    const ex = build(
      fakeProvider([
        async () => {
          throw new UpstreamError(429, "rate_limit_error", "slow down");
        },
      ]),
    );
    await expect(ex.generate("img", gen(), { callerApiKeyId: null })).rejects.toMatchObject({ httpStatus: 429 });
    const logs = repo.recentLogs(10);
    expect(logs[0]).toMatchObject({ status: "error", httpStatus: 429 });
    expect(logs[0].errorMessage).toContain("slow down");
  });

  it("does not rotate on non-auth errors", async () => {
    let calls = 0;
    const ex = build(
      fakeProvider([
        async () => {
          calls++;
          throw new UpstreamError(400, "invalid_request_error", "bad size");
        },
      ]),
    );
    await expect(ex.generate("img", gen(), { callerApiKeyId: null })).rejects.toMatchObject({ httpStatus: 400 });
    expect(calls).toBe(1);
  });

  it("prepends the global prompt without mutating the generation request", async () => {
    repo.updateAppSettings({ globalPrompt: "  shared style  ", announcement: "" });
    const request = gen();
    let upstreamPrompt = "";
    const provider: ImageProvider = {
      kind: "fake",
      async generate(req) {
        upstreamPrompt = req.prompt;
        return ok;
      },
      async edit() {
        return ok;
      },
      async test() {
        return { ok: true, message: "" };
      },
    };

    await build(provider).generate("img", request, { callerApiKeyId: null });

    expect(upstreamPrompt).toBe("  shared style  \np");
    expect(request.prompt).toBe("p");
  });

  it("prepends the global prompt to edits without copying or mutating images", async () => {
    repo.updateAppSettings({ globalPrompt: "edit policy", announcement: "" });
    const image = { filename: "source.png", data: Buffer.from("image"), mimeType: "image/png" };
    const request: UnifiedEditRequest = {
      prompt: "make it blue",
      n: 1,
      responseFormat: "b64_json",
      images: [image],
      passthrough: {},
    };
    let upstreamRequest: UnifiedEditRequest | null = null;
    const provider: ImageProvider = {
      kind: "fake",
      async generate() {
        return ok;
      },
      async edit(req) {
        upstreamRequest = req;
        return ok;
      },
      async test() {
        return { ok: true, message: "" };
      },
    };

    await build(provider).edit("img", request, { callerApiKeyId: null });

    expect(upstreamRequest?.prompt).toBe("edit policy\nmake it blue");
    expect(upstreamRequest?.images).toBe(request.images);
    expect(request.prompt).toBe("make it blue");
  });

  it("leaves prompts unchanged when the global prompt is blank", async () => {
    repo.updateAppSettings({ globalPrompt: "  \n ", announcement: "" });
    let upstreamPrompt = "";
    const provider: ImageProvider = {
      kind: "fake",
      async generate(req) {
        upstreamPrompt = req.prompt;
        return ok;
      },
      async edit() {
        return ok;
      },
      async test() {
        return { ok: true, message: "" };
      },
    };

    await build(provider).generate("img", gen(), { callerApiKeyId: null });

    expect(upstreamPrompt).toBe("p");
  });

  it("throws ModelNotFoundError for unknown model", async () => {
    await expect(build(fakeProvider([])).generate("nope", gen(), { callerApiKeyId: null })).rejects.toMatchObject({
      name: "ModelNotFoundError",
    });
    expect(repo.recentLogs(10)).toHaveLength(0);
  });
});
