import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
  new Executor({ router: new ModelRouter(repo), keyPool: new KeyPool(repo), providers: new Map([["openai-compat", provider]]), repo });

describe("Executor", () => {
  it("limits concurrent provider calls for the same channel", async () => {
    repo.updateChannel(channelId, { concurrency: 2 });
    const releases: Array<() => void> = [];
    let entered = 0;
    let active = 0;
    let maximumActive = 0;
    const provider = fakeProvider([
      async () => {
        entered++;
        active++;
        maximumActive = Math.max(maximumActive, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active--;
        return ok;
      },
    ]);
    const ex = build(provider);
    const calls = [
      ex.generate("img", gen(), { callerApiKeyId: null }),
      ex.generate("img", gen(), { callerApiKeyId: null }),
      ex.generate("img", gen(), { callerApiKeyId: null }),
    ];

    await vi.waitFor(() => expect(entered).toBe(2));
    expect(maximumActive).toBe(2);
    releases.shift()?.();
    await vi.waitFor(() => expect(entered).toBe(3));
    for (const release of releases) release();
    await Promise.all(calls);
    expect(maximumActive).toBe(2);
  });

  it("selects the provider from channel.type", async () => {
    repo.updateChannel(channelId, { type: "ai-horde" });
    let openaiCalls = 0;
    let hordeCalls = 0;
    const openai = fakeProvider([async () => { openaiCalls++; return ok; }]);
    const horde = { ...fakeProvider([async () => { hordeCalls++; return ok; }]), kind: "ai-horde" };
    const providers = new Map<string, ImageProvider>([["openai-compat", openai], ["ai-horde", horde]]);
    const ex = new Executor({ router: new ModelRouter(repo), keyPool: new KeyPool(repo), providers, repo } as never);

    await ex.generate("img", gen(), { callerApiKeyId: null });

    expect(hordeCalls).toBe(1);
    expect(openaiCalls).toBe(0);
  });

  it("rejects an unregistered channel type without fallback", async () => {
    repo.updateChannel(channelId, { type: "ai-horde" });
    const openai = { ...fakeProvider([async () => ok]), kind: "openai-compat" };
    const providers = new Map<string, ImageProvider>([["openai-compat", openai]]);
    const ex = new Executor({ router: new ModelRouter(repo), keyPool: new KeyPool(repo), providers, repo } as never);

    await expect(ex.generate("img", gen(), { callerApiKeyId: null })).rejects.toMatchObject({
      httpStatus: 500,
      type: "configuration_error",
    });
  });

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
        return {
          created: 1,
          images: [{ b64: "AA", revisedPrompt: req.prompt }],
          includeRawResponseFields: false,
          raw: {
            prompt: req.prompt,
            data: [{ b64_json: "AA", revised_prompt: req.prompt }],
            usage: { input_tokens: 12, details: { image_tokens: 4 }, unsafe_note: req.prompt },
          },
        };
      },
      async edit() {
        return ok;
      },
      async test() {
        return { ok: true, message: "" };
      },
    };

    const response = await build(provider).generate("img", request, { callerApiKeyId: null });

    expect(upstreamPrompt).toBe("  shared style  \np");
    expect(request.prompt).toBe("p");
    expect(response.result).toEqual({
      created: 1,
      images: [{ b64: "AA" }],
      raw: { usage: { input_tokens: 12, details: { image_tokens: 4 } } },
      includeRawResponseFields: false,
    });
  });

  it("does not rotate keys when an accepted async task is unsafe to retry", async () => {
    repo.updateAppSettings({ globalPrompt: "shared style", announcement: "" });
    let calls = 0;
    const provider = fakeProvider([
      async () => {
        calls++;
        throw new UpstreamError(429, "rate_limit_error", "poll throttled", null, false);
      },
    ]);

    const error = await build(provider).generate("img", gen(), { callerApiKeyId: null }).catch((value: unknown) => value);

    expect(calls).toBe(1);
    expect(error).toMatchObject({ httpStatus: 429, keyRetrySafe: false });
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

  it("does not expose an upstream error that echoes the combined prompt", async () => {
    repo.updateAppSettings({ globalPrompt: "secret policy", announcement: "" });
    const provider: ImageProvider = {
      kind: "fake",
      async generate(req) {
        throw new UpstreamError(400, "invalid_request_error", `invalid prompt: ${req.prompt}`, "bad_prompt");
      },
      async edit() {
        return ok;
      },
      async test() {
        return { ok: true, message: "" };
      },
    };

    const error = await build(provider).generate("img", gen(), { callerApiKeyId: null }).catch((err: unknown) => err);

    expect(error).toMatchObject({ httpStatus: 400, type: "invalid_request_error", code: "bad_prompt" });
    expect((error as Error).message).not.toContain("secret policy");
    expect((error as Error).message).not.toContain("invalid prompt");
  });

  it("throws ModelNotFoundError for unknown model", async () => {
    await expect(build(fakeProvider([])).generate("nope", gen(), { callerApiKeyId: null })).rejects.toMatchObject({
      name: "ModelNotFoundError",
    });
    expect(repo.recentLogs(10)).toHaveLength(0);
  });
});
