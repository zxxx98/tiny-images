# AI Horde Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a native AI Horde channel that serves OpenAI-compatible generation and edit requests, including img2img/inpainting and namespaced Horde tuning.

**Architecture:** Parse `horde` into a typed provider extension, route each resolved channel through a provider registry, and let `AIHordeProvider` own payload construction, async polling, error translation, and edit-image conversion. Existing response conversion, history, jobs, SSE, key pools, quotas, and circuit breaking remain shared gateway behavior.

**Tech Stack:** TypeScript, Node.js 22 fetch/AbortSignal, Fastify 5, SQLite, sharp, React 18, Vitest.

---

## File map

- Create `server/src/providers/registry.ts`: provider lookup with an explicit unknown-type configuration error.
- Create `server/src/providers/ai-horde.ts`: Horde request mapping, HTTP calls, polling, result parsing, and provider connectivity test.
- Create `server/src/providers/ai-horde-images.ts`: bounded image/mask decoding and WebP conversion.
- Create `server/tests/ai-horde-provider.test.ts`: generation, polling, error, header, timeout, and connectivity tests.
- Create `server/tests/ai-horde-edits.test.ts`: img2img/inpainting and image validation tests.
- Create `server/tests/v1-horde.test.ts`: OpenAI endpoint integration across sync, SSE, and detached jobs.
- Create `web/src/pages/Admin.test.tsx`: pure channel-form behavior tests.
- Modify `server/src/core/types.ts`: channel type, Horde options, provider extensions, and registry-compatible types.
- Modify `server/src/core/errors.ts`: safe key-retry metadata for submitted asynchronous work.
- Modify `server/src/core/executor.ts`: select provider by `channel.type` and honor retry safety.
- Modify `server/src/server/validate.ts`: reserve, parse, and validate `horde`.
- Modify `server/src/server/generations.ts`, `server/src/server/edits.ts`: carry the typed Horde extension.
- Modify `server/src/server/stream.ts`: propagate client disconnects to long-running polling.
- Modify `server/src/server/history.ts`: preserve Horde options through detached generation/edit jobs.
- Modify `server/src/store/repo.ts`, `server/src/store/seed.ts`: persist and seed channel type.
- Modify `server/src/server/admin.ts`: validate channel type and test with the selected provider.
- Modify `server/src/app.ts`, `server/src/index.ts`: construct and expose the provider registry.
- Modify existing server tests that build `Executor` or `buildApp`: pass `providers` instead of one `provider`.
- Modify `server/package.json` and the root lockfile: add `sharp`.
- Modify `web/src/api.ts`, `web/src/pages/Admin.tsx`: typed channel selector, defaults, provider hints, and list badge.

### Task 1: Persist a closed channel-type union

**Files:**
- Modify: `server/src/core/types.ts`
- Modify: `server/src/store/repo.ts`
- Modify: `server/src/store/seed.ts`
- Modify: `server/tests/store.test.ts`
- Modify: `server/tests/seed-admin.test.ts`

- [ ] **Step 1: Write failing persistence and seed tests**

Add assertions that the default remains OpenAI-compatible, an explicit Horde type survives create/update, and YAML seeding accepts it:

```ts
it("persists channel type on create and update", () => {
  const c = repo.createChannel({ name: "h", type: "ai-horde", baseUrl: "https://aihorde.net/api/v2" });
  expect(c.type).toBe("ai-horde");
  expect(repo.updateChannel(c.id, { type: "openai-compat" })?.type).toBe("openai-compat");
});

it("defaults channel type to openai-compat", () => {
  expect(repo.createChannel({ name: "o", baseUrl: "https://example.test/v1" }).type).toBe("openai-compat");
});
```

Extend the existing seed fixture with `type: ai-horde` and assert `repo.listChannels()[0].type === "ai-horde"`.

- [ ] **Step 2: Run the focused tests to verify RED**

Run: `npm test -w server -- --run tests/store.test.ts tests/seed-admin.test.ts`

Expected: FAIL because `ChannelInput` and YAML seed input do not accept `type`, and create/update ignore it.

- [ ] **Step 3: Add the channel type and persistence code**

In `core/types.ts`:

```ts
export type ChannelType = "openai-compat" | "ai-horde";

export interface ChannelConfig {
  id: number;
  name: string;
  type: ChannelType;
}
```

In `repo.ts`, type `ChannelRow.type` and add `type?: ChannelType` to `ChannelInput`. Bind `input.type ?? "openai-compat"` in INSERT and include `type = ?` in UPDATE. Cast the stored value to `ChannelType` in `toChannel`.

In `seed.ts`, add `type?: ChannelType` to `SeedConfig.channels` and pass `type: ch.type` into `repo.createChannel`.

- [ ] **Step 4: Run the focused tests to verify GREEN**

Run: `npm test -w server -- --run tests/store.test.ts tests/seed-admin.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/core/types.ts server/src/store/repo.ts server/src/store/seed.ts server/tests/store.test.ts server/tests/seed-admin.test.ts
git commit -m "feat: persist AI Horde channel type"
```

### Task 2: Route calls through a provider registry

**Files:**
- Create: `server/src/providers/registry.ts`
- Modify: `server/src/core/errors.ts`
- Modify: `server/src/core/executor.ts`
- Modify: `server/src/app.ts`
- Modify: `server/src/server/admin.ts`
- Modify: `server/tests/executor.test.ts`
- Modify: `server/tests/admin.test.ts`
- Modify: `server/tests/app.test.ts`
- Modify: `server/tests/files-seed.test.ts`
- Modify: `server/tests/groups-users-admin.test.ts`
- Modify: `server/tests/quota-groups.test.ts`
- Modify: `server/tests/users-auth.test.ts`
- Modify: `server/tests/v1-edits.test.ts`
- Modify: `server/tests/v1-generations.test.ts`
- Modify: `server/tests/v1-history.test.ts`
- Modify: `server/tests/v1-stream.test.ts`

- [ ] **Step 1: Write failing registry-selection tests**

Change the Executor test helper to build two named fakes and add:

```ts
const providers = new Map<string, ImageProvider>([
  ["openai-compat", openaiProvider],
  ["ai-horde", hordeProvider],
]);

it("selects the provider from channel.type", async () => {
  repo.updateChannel(channelId, { type: "ai-horde" });
  await build(providers).generate("img", gen(), { callerApiKeyId: null });
  expect(hordeGenerate).toHaveBeenCalledOnce();
  expect(openaiGenerate).not.toHaveBeenCalled();
});

it("rejects an unregistered channel type without fallback", async () => {
  repo.updateChannel(channelId, { type: "ai-horde" });
  const badProviders = new Map<string, ImageProvider>([["openai-compat", openaiProvider]]);
  await expect(build(badProviders).generate("img", gen(), { callerApiKeyId: null }))
    .rejects.toMatchObject({ httpStatus: 500, type: "configuration_error" });
  expect(openaiGenerate).not.toHaveBeenCalled();
});
```

Add an admin connectivity test proving `/admin/channels/:id/test` calls the provider registered for that channel type.

- [ ] **Step 2: Run the focused tests to verify RED**

Run: `npm test -w server -- --run tests/executor.test.ts tests/admin.test.ts`

Expected: FAIL because Executor and AppDeps accept only one provider.

- [ ] **Step 3: Implement registry lookup and dependency changes**

Create `providers/registry.ts`:

```ts
import { UpstreamError } from "../core/errors.js";
import type { ChannelType, ImageProvider } from "../core/types.js";

export type ProviderRegistry = ReadonlyMap<string, ImageProvider>;

export function providerFor(registry: ProviderRegistry, type: ChannelType | string): ImageProvider {
  const provider = registry.get(type);
  if (!provider) throw new UpstreamError(500, "configuration_error", `no provider registered for channel type '${type}'`);
  return provider;
}

export function createProviderRegistry(...providers: ImageProvider[]): ProviderRegistry {
  return new Map(providers.map((provider) => [provider.kind, provider]));
}
```

Replace `provider: ImageProvider` with `providers: ProviderRegistry` in `ExecutorDeps` and `AppDeps`. In Executor, resolve once per route:

```ts
const provider = providerFor(this.deps.providers, channel.type);
// inside the attempt loop
const result = payload.kind === "generate"
  ? await provider.generate(payload.req, ctx)
  : await provider.edit(payload.req, ctx);
```

In the admin test route use `providerFor(ctx.deps.providers, channel.type).test(channel, key.apiKey)`. Mechanically update test fixtures to wrap their existing fake with `createProviderRegistry(provider)`; do not change test behavior.

- [ ] **Step 4: Run server tests to verify GREEN**

Run: `npm test -w server`

Expected: PASS with all existing provider fixtures migrated.

- [ ] **Step 5: Commit**

```bash
git add server/src/providers/registry.ts server/src/core/errors.ts server/src/core/executor.ts server/src/app.ts server/src/server/admin.ts server/tests/admin.test.ts server/tests/app.test.ts server/tests/executor.test.ts server/tests/files-seed.test.ts server/tests/groups-users-admin.test.ts server/tests/quota-groups.test.ts server/tests/users-auth.test.ts server/tests/v1-edits.test.ts server/tests/v1-generations.test.ts server/tests/v1-history.test.ts server/tests/v1-stream.test.ts
git commit -m "refactor: route channels through provider registry"
```

### Task 3: Parse the namespaced Horde extension safely

**Files:**
- Modify: `server/src/core/types.ts`
- Modify: `server/src/server/validate.ts`
- Modify: `server/src/server/generations.ts`
- Modify: `server/src/server/edits.ts`
- Modify: `server/src/server/history.ts`
- Modify: `server/tests/v1-generations.test.ts`
- Modify: `server/tests/v1-edits.test.ts`
- Modify: `server/tests/v1-history.test.ts`

- [ ] **Step 1: Write failing validation tests**

Cover JSON generation and multipart edit forms:

```ts
expect(validateGenBody({ model: "m", prompt: "p", horde: { nsfw: true, params: { steps: 20 } } }).req.providerOptions?.horde)
  .toEqual({ nsfw: true, params: { steps: 20 } });
expect(() => validateGenBody({ model: "m", prompt: "p", horde: [] })).toThrow("'horde' must be an object");
expect(() => validateGenBody({ model: "m", prompt: "p", horde: { params: [] } })).toThrow("'horde.params' must be an object");
expect(() => validateGenBody({ model: "m", prompt: "p", horde: { models: ["override"] } })).toThrow("unsupported horde field 'models'");
expect(() => validateGenBody({ model: "m", prompt: "p", horde: { nsfw: "yes" } })).toThrow("'horde.nsfw' must be a boolean");
expect(validateGenBody({ model: "m", prompt: "p", horde: { nsfw: true } }).req.passthrough).not.toHaveProperty("horde");
```

For multipart, append `horde` as `JSON.stringify({ shared: false, params: { seed: "7" } })` and assert the same typed object reaches the fake provider in synchronous edits and detached edit jobs.

- [ ] **Step 2: Run API tests to verify RED**

Run: `npm test -w server -- --run tests/v1-generations.test.ts tests/v1-edits.test.ts tests/v1-history.test.ts`

Expected: FAIL because `horde` remains generic passthrough and multipart JSON is not parsed.

- [ ] **Step 3: Add typed extension parsing**

In `core/types.ts` define:

```ts
export interface AIHordeOptions {
  nsfw?: boolean;
  censor_nsfw?: boolean;
  allow_downgrade?: boolean;
  shared?: boolean;
  trusted_workers?: boolean;
  slow_workers?: boolean;
  extra_slow_workers?: boolean;
  disable_batching?: boolean;
  replacement_filter?: boolean;
  dry_run?: boolean;
  proxied_account?: string;
  params?: Record<string, unknown>;
}

export interface ProviderOptions { horde?: AIHordeOptions }
```

Add `providerOptions?: ProviderOptions` to both unified request interfaces. In `validate.ts`, add `horde` to `COMMON_FIELDS`, parse a multipart string with `JSON.parse`, reject arrays/null, reject unknown top-level keys against the exact allowlist above plus `params`, require the listed flag fields to be booleans, require `proxied_account` to be a string, and return `horde` from `validateCommonFields`.

Set `providerOptions: { horde: common.horde }` when Horde options exist in `validateGenBody` and `parseEditMultipart`; omit `providerOptions` otherwise. Include the extension in detached-job parameter serialization so job execution retains it; never include source-image bytes in serialized params.

- [ ] **Step 4: Prove OpenAI-compatible payloads omit `horde`**

Add to `server/tests/provider.test.ts`:

```ts
await provider.generate(gen({ providerOptions: { horde: { nsfw: true } } }), ctx());
expect(seen).not.toHaveProperty("horde");
```

Run: `npm test -w server -- --run tests/provider.test.ts tests/v1-generations.test.ts tests/v1-edits.test.ts tests/v1-history.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/core/types.ts server/src/server/validate.ts server/src/server/generations.ts server/src/server/edits.ts server/src/server/history.ts server/tests
git commit -m "feat: validate namespaced AI Horde options"
```

### Task 4: Implement AI Horde generation and polling

**Files:**
- Create: `server/src/providers/ai-horde.ts`
- Create: `server/tests/ai-horde-provider.test.ts`
- Modify: `server/src/core/types.ts`
- Modify: `server/src/core/errors.ts`
- Modify: `server/src/core/executor.ts`

- [ ] **Step 1: Write the successful-flow and precedence tests**

Use a local Fastify upstream. Capture `POST /generate/async`, return two incomplete checks followed by done, and return one status result. Assert:

```ts
expect(submitBody).toMatchObject({
  prompt: "a cat",
  models: ["stable_diffusion"],
  nsfw: true,
  r2: true,
  params: { n: 2, width: 1024, height: 768, steps: 25, seed: "123" },
});
expect(submitBody).not.toHaveProperty("source_image");
expect(seenHeaders).toMatchObject({
  apikey: "horde-key",
  "client-agent": "tiny-images:0.1.0:github.com/zxxx98/tiny-images",
});
expect(checkCalls).toBe(3);
expect(statusCalls).toBe(1);
expect(result.images).toEqual([{ url: "https://img.example/result.webp" }]);
expect(result.raw).toMatchObject({ generations: [{ seed: "123", model: "stable_diffusion" }] });
expect(result.includeRawResponseFields).toBe(false);
```

Pass conflicting `horde.params.n/width/height`; prove standard `n` and numeric `size` win. Pass `size: "auto"`; prove explicit Horde width/height remain. Pass `quality`; prove it creates no Horde field.

- [ ] **Step 2: Run the provider test to verify RED**

Run: `npm test -w server -- --run tests/ai-horde-provider.test.ts`

Expected: FAIL because `AIHordeProvider` does not exist.

- [ ] **Step 3: Implement minimal submit/check/status flow**

Implement `AIHordeProvider` with injectable timing for deterministic tests:

```ts
export interface AIHordeProviderOptions {
  pollIntervalMs?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  version?: string;
}

export class AIHordeProvider implements ImageProvider {
  readonly kind = "ai-horde";
  constructor(private readonly options: AIHordeProviderOptions = {}) {}
  async generate(req: UnifiedGenRequest, ctx: CallContext): Promise<UnifiedImageResult> {
    return this.run(req, ctx, {});
  }
  async edit(_req: UnifiedEditRequest, _ctx: CallContext): Promise<UnifiedImageResult> {
    throw new ValidationError("AI Horde image editing is not available");
  }
}
```

Set the default client version with `const version = this.options.version ?? "0.1.0"`. At the start of `generate`, create one `AbortSignal.timeout(ctx.channel.timeoutMs)`, combine it with `ctx.signal`, and pass that prepared signal into `run`. Build the payload from an allowlisted copy of `req.providerOptions?.horde`; clone `params`, then overwrite `n` and numeric `size`. Force `models: [ctx.upstreamModel]`, `prompt: req.prompt`, and `r2: true` after all client data. Task 5 makes `edit` create the same prepared signal before image conversion, so both operations measure one end-to-end deadline.

Use one `requestJson` helper that starts with `new Headers(ctx.channel.extraHeaders)` and calls case-insensitive `headers.set(...)` for `apikey`, `Client-Agent`, and JSON content type afterward. Submit, validate a non-empty string ID, immediately check once, wait at least `pollIntervalMs ?? 2000` between later checks, and request status exactly once after `done`.

- [ ] **Step 4: Write failing error, abort, and retry-safety tests**

Add table tests for submit HTTP 400/401/429/503, malformed ID, `is_possible:false`, `faulted:true`, timeout, client abort, malformed status, and empty generations. Assert 503 remains 503 instead of becoming 502. Add:

```ts
it("does not allow Executor to resubmit after async acceptance", async () => {
  // submit returns an id; check returns 429
  repo.updateAppSettings({ globalPrompt: "shared style", announcement: "" });
  await expect(executor.generate("img", gen(), opts)).rejects.toMatchObject({ httpStatus: 429 });
  expect(submitCalls).toBe(1);
});
```

- [ ] **Step 5: Implement Horde error mapping and safe key retry**

Extend `UpstreamError` without changing existing call sites:

```ts
constructor(
  public readonly httpStatus: number,
  public readonly type: string,
  message: string,
  public readonly code: string | null = null,
  public readonly keyRetrySafe = true,
) {
  super(message);
  this.name = "UpstreamError";
}
```

Executor rotates only when `KEY_ROTATE_STATUSES.has(err.httpStatus) && err.keyRetrySafe`. AI Horde errors before a task ID is accepted use the default `true`; every error after acceptance uses `keyRetrySafe: false`. Update `suppressPromptEchoedByError` to pass `error.keyRetrySafe` into the sanitized error constructor, so enabling the global prompt cannot accidentally make a submitted Horde task retryable. Preserve `includeRawResponseFields` in `suppressPromptEchoes`; its existing prompt-echo sanitization may still remove unsafe string metadata when a global prompt is active.

Map Horde bodies from `message`, `error`, or `errors` into a short sanitized string. Never stringify request payloads. Map 400→400, 401/403 unchanged, 429→429, 503→503 `service_unavailable`, other 5xx→502, impossible→503, faulted/expired/malformed/empty→502, timeout→504. Add `includeRawResponseFields?: boolean` to `UnifiedImageResult`; preserve the complete status object in `raw`, map only each string `img` to `images[].url`, and return `includeRawResponseFields: false` so Horde's `generations`, queue, seed, model, and censored fields remain available internally but are not appended to the OpenAI response body.

- [ ] **Step 6: Add and implement non-generating connectivity tests**

Test `GET /status/heartbeat` when the key is null, and `GET /find_user` for both a registered key and `0000000000`. Assert `apikey` and `Client-Agent` override conflicting `extraHeaders`; HTTP failures return `{ ok: false, message }` instead of throwing.

Implement the method with the same bounded request helper:

```ts
async test(channel: ChannelConfig, apiKey: string | null): Promise<{ ok: boolean; message: string }> {
  try {
    const path = apiKey === null ? "/status/heartbeat" : "/find_user";
    const json = await this.testRequest(channel, path, apiKey);
    const message = (json as { message?: unknown }).message;
    return { ok: true, message: typeof message === "string" ? message : "HTTP 200" };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
```

- [ ] **Step 7: Run provider and Executor tests to verify GREEN**

Run: `npm test -w server -- --run tests/ai-horde-provider.test.ts tests/executor.test.ts`

Expected: PASS; fake timers or injected sleep prove no check occurs inside the two-second production interval.

- [ ] **Step 8: Commit**

```bash
git add server/src/providers/ai-horde.ts server/src/core/types.ts server/src/core/errors.ts server/src/core/executor.ts server/tests/ai-horde-provider.test.ts server/tests/executor.test.ts
git commit -m "feat: add AI Horde generation polling"
```

### Task 5: Add bounded img2img and inpainting conversion

**Files:**
- Modify: `server/package.json`
- Modify: `package-lock.json`
- Create: `server/src/providers/ai-horde-images.ts`
- Modify: `server/src/providers/ai-horde.ts`
- Create: `server/tests/ai-horde-edits.test.ts`

- [ ] **Step 1: Install sharp**

Run: `npm install sharp -w server`

Expected: `sharp` appears under server runtime dependencies and the root lockfile records its platform packages.

- [ ] **Step 2: Write failing conversion and edit tests**

Generate tiny PNG/JPEG/WebP fixtures with sharp in the test. Assert all produce a Horde payload whose decoded `source_image` metadata format is `webp`. Add tests for:

```ts
expect(img2imgBody.source_processing).toBe("img2img");
expect(img2imgBody).not.toHaveProperty("source_mask");
expect(inpaintBody.source_processing).toBe("inpainting");
expect(typeof inpaintBody.source_mask).toBe("string");
await expect(provider.edit(reqWithTwoImages, ctx)).rejects.toThrow("exactly one image");
await expect(provider.edit(reqWithBrokenImage, ctx)).rejects.toMatchObject({ name: "ValidationError" });
await expect(provider.edit(reqWithMismatchedMask, ctx)).rejects.toThrow("mask dimensions");
```

Test an exported pixel-limit guard with `assertPixelLimit(10_000, 4_001)` so the 40,000,001-pixel case is rejected without allocating a decoded bitmap. Abort before conversion and immediately after an injected conversion boundary; assert no `/generate/async` request occurs.

- [ ] **Step 3: Run edit tests to verify RED**

Run: `npm test -w server -- --run tests/ai-horde-edits.test.ts`

Expected: FAIL because edit conversion is not implemented.

- [ ] **Step 4: Implement the focused converter**

Create:

```ts
const MAX_INPUT_PIXELS = 40_000_000;

export interface HordeWebPImage { base64: string; width: number; height: number }

export function assertPixelLimit(width: number, height: number): void {
  if (width * height > MAX_INPUT_PIXELS) throw new ValidationError("image exceeds 40000000 pixels");
}

export async function toHordeWebP(image: IncomingImage, signal: AbortSignal): Promise<HordeWebPImage> {
  if (signal.aborted) throw signal.reason;
  try {
    const pipeline = sharp(image.data, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error" });
    const metadata = await pipeline.metadata();
    if (!metadata.width || !metadata.height) throw new ValidationError("image dimensions are unavailable");
    assertPixelLimit(metadata.width, metadata.height);
    const data = await pipeline.webp().toBuffer();
    if (signal.aborted) throw signal.reason;
    return { base64: data.toString("base64"), width: metadata.width, height: metadata.height };
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (error instanceof ValidationError) throw error;
    throw new ValidationError(`invalid image '${image.filename}'`);
  }
}
```

In `AIHordeProvider.edit`, require exactly one source image, convert it and the optional mask, require equal dimensions for inpainting, then call the shared `run` with protected `source_image`, optional `source_mask`, and `source_processing` fields. The shared total deadline must be created before conversion so preprocessing counts toward timeout.

- [ ] **Step 5: Run edit and generation provider tests to verify GREEN**

Run: `npm test -w server -- --run tests/ai-horde-edits.test.ts tests/ai-horde-provider.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/package.json package-lock.json server/src/providers/ai-horde-images.ts server/src/providers/ai-horde.ts server/tests/ai-horde-edits.test.ts
git commit -m "feat: support AI Horde image editing"
```

### Task 6: Wire the provider into all server paths

**Files:**
- Modify: `server/src/index.ts`
- Modify: `server/src/server/admin.ts`
- Modify: `server/src/server/stream.ts`
- Modify: `server/src/server/generations.ts`
- Create: `server/tests/v1-horde.test.ts`
- Modify: `server/tests/v1-stream.test.ts`

- [ ] **Step 1: Write failing API integration tests**

Build an app with both providers and a local Horde upstream. Create an `ai-horde` channel mapped from public model `pony` to upstream `Pony Diffusion`. Cover:

```ts
const postJson = (url: string, payload: Record<string, unknown>) => app.inject({ method: "POST", url, payload });

function parseEvents(body: string): { hasDone: boolean } {
  const frames = body.split("\n\n").filter((frame) => frame.startsWith("data: "));
  return { hasDone: frames.includes("data: [DONE]") };
}

async function postForm(url: string, form: FormData) {
  const request = new Request("http://local/", { method: "POST", body: form });
  return app.inject({
    method: "POST",
    url,
    payload: Buffer.from(await request.arrayBuffer()),
    headers: { "content-type": request.headers.get("content-type")! },
  });
}

function editForm(mask: boolean, horde: Record<string, unknown> = {}): FormData {
  const form = new FormData();
  form.append("model", "pony");
  form.append("prompt", "paint it blue");
  form.append("image", new Blob([PNG_BUF], { type: "image/png" }), "source.png");
  if (mask) form.append("mask", new Blob([PNG_BUF], { type: "image/png" }), "mask.png");
  if (Object.keys(horde).length > 0) form.append("horde", JSON.stringify(horde));
  return form;
}

async function waitForJob(jobId: string, expected: "ok" | "error"): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const state = await app.inject({ url: `/v1/images/jobs/${jobId}` });
    if (state.json().status === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`job ${jobId} did not reach ${expected}`);
}

// synchronous generation
expect(await postJson("/v1/images/generations", { model: "pony", prompt: "p", horde: { nsfw: true } })).toMatchObject({ statusCode: 200 });
expect(submitBody).toMatchObject({ models: ["Pony Diffusion"], nsfw: true });
expect((await postJson("/v1/images/generations", { model: "pony", prompt: "p" })).json()).not.toHaveProperty("generations");

// SSE
expect(parseEvents((await postJson("/v1/images/generations", { model: "pony", prompt: "p", stream: true })).body).hasDone).toBe(true);

// detached generation job
const { jobId } = (await postJson("/v1/images/jobs", { model: "pony", prompt: "p", horde: { params: { steps: 12 } } })).json();
await waitForJob(jobId, "ok");
expect(lastSubmitBody.params).toMatchObject({ steps: 12 });

// sync edit + detached edit job
expect((await postForm("/v1/images/edits", editForm(false, { shared: false }))).statusCode).toBe(200);
expect((await postForm("/v1/images/edit-jobs", editForm(true))).statusCode).toBe(200);
```

Add a stream-disconnect unit test using a controllable AbortController around the extracted request signal; assert a provider waiting in polling sees `signal.aborted === true` and performs no next check.

- [ ] **Step 2: Run integration tests to verify RED**

Run: `npm test -w server -- --run tests/v1-horde.test.ts tests/v1-stream.test.ts`

Expected: FAIL because production startup does not register Horde and SSE omits a disconnect signal.

- [ ] **Step 3: Complete production wiring and disconnect propagation**

In `index.ts`:

```ts
const providers = createProviderRegistry(new OpenAICompatProvider(), new AIHordeProvider());
const executor = new Executor({ router, keyPool, providers, repo });
const app = await buildApp({
  env,
  repo,
  router,
  keyPool,
  providers,
  executor,
  jobManager,
  logger: true,
  webDist: path.resolve(import.meta.dirname, "../../web/dist"),
});
```

Update `toImagesResponse` to merge `result.raw` top-level fields only when `result.includeRawResponseFields !== false`; this preserves existing OpenAI-compatible usage fields while keeping Horde status metadata internal. Create one request AbortSignal per synchronous/SSE request and reuse it for Executor plus response image conversion; do not call `requestSignal` twice. Broaden `streamImageFlow`'s request type to `FastifyRequest`, pass `requestSignal(req, reply)` to Executor, and use the same signal during `conformImages`. Detached jobs deliberately have no client-disconnect signal and remain bounded by channel timeout.

Ensure admin connectivity lookup uses the registry. Registered Horde keys, including `0000000000`, reach `AIHordeProvider.test`; extra headers cannot override `apikey`, `Client-Agent`, or content type.

- [ ] **Step 4: Run server integration and full server tests**

Run: `npm test -w server -- --run tests/v1-horde.test.ts tests/v1-stream.test.ts tests/admin.test.ts`

Expected: PASS.

Run: `npm test -w server`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/index.ts server/src/server/admin.ts server/src/server/stream.ts server/src/server/generations.ts server/tests/v1-horde.test.ts server/tests/v1-stream.test.ts
git commit -m "feat: expose AI Horde across image endpoints"
```

### Task 7: Add channel-type management UI

**Files:**
- Modify: `server/src/server/admin.ts`
- Modify: `server/tests/admin.test.ts`
- Modify: `web/src/api.ts`
- Modify: `web/src/pages/Admin.tsx`
- Create: `web/src/pages/Admin.test.tsx`

- [ ] **Step 1: Write failing admin API tests**

Add create, patch, and validation cases:

```ts
const created = await createChannel({ type: "ai-horde", baseUrl: "https://aihorde.net/api/v2" });
expect(created.json().type).toBe("ai-horde");
expect((await patchChannel(created.json().id, { type: "openai-compat" })).json().type).toBe("openai-compat");
const bad = await createChannel({ type: "unknown", baseUrl: "https://example.test" });
expect(bad.statusCode).toBe(400);
expect(bad.json().error.message).toContain("'type'");
```

- [ ] **Step 2: Run admin tests to verify RED, then implement validation**

Run: `npm test -w server -- --run tests/admin.test.ts`

Expected: FAIL because `validateChannelInput` drops `type`.

Add an exact `openai-compat | ai-horde` check, include `type` in the return type, and pass the validated type to Repo create/update. Run the same command; expected PASS.

```ts
if (b.type !== undefined) {
  if (b.type !== "openai-compat" && b.type !== "ai-horde") {
    throw httpError(400, "'type' must be 'openai-compat' or 'ai-horde'");
  }
  out.type = b.type;
}
```

- [ ] **Step 3: Write failing pure UI-state tests**

Export two small helpers from `Admin.tsx` and test them without a DOM:

```ts
expect(newChannelDraft()).toMatchObject({ type: "openai-compat", editMode: "auto", timeoutMs: 120000 });
expect(changeChannelType({ type: "openai-compat", baseUrl: "" }, "ai-horde").baseUrl)
  .toBe("https://aihorde.net/api/v2");
expect(changeChannelType({ id: 7, type: "openai-compat", baseUrl: "https://custom.test" }, "ai-horde").baseUrl)
  .toBe("https://custom.test");
```

Run: `npm test -w web -- --run src/pages/Admin.test.tsx`

Expected: FAIL because the helpers and typed channel union do not exist.

- [ ] **Step 4: Implement the selector and contextual hints**

In `api.ts`, change `Channel.type` to `"openai-compat" | "ai-horde"`. In `Admin.tsx`, render before Base URL:

```ts
export function newChannelDraft(): Partial<Channel> {
  return { type: "openai-compat", editMode: "auto", timeoutMs: 120000, enabled: true };
}

export function changeChannelType(draft: Partial<Channel>, type: Channel["type"]): Partial<Channel> {
  const addHordeDefault = type === "ai-horde" && draft.id === undefined && !draft.baseUrl;
  return { ...draft, type, ...(addHordeDefault ? { baseUrl: "https://aihorde.net/api/v2" } : {}) };
}
```

```tsx
<label htmlFor="ch-type">渠道类型</label>
<select
  id="ch-type"
  value={editing.type ?? "openai-compat"}
  onChange={(e) => setEditing(changeChannelType(editing, e.target.value as Channel["type"]))}
>
  <option value="openai-compat">OpenAI Compatible</option>
  <option value="ai-horde">AI Horde</option>
</select>
```

For AI Horde, hide `editMode` and show plain text explaining asynchronous queues, worker-dependent edits, registered keys, and anonymous key `0000000000`. Use `https://aihorde.net/api/v2` as the new blank draft default only when switching a new untouched draft; never rewrite an existing or custom URL. Add a channel-type pill to each list item.

- [ ] **Step 5: Run web tests and build**

Run: `npm test -w web`

Expected: PASS.

Run: `npm run build -w web`

Expected: PASS with no TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add server/src/server/admin.ts server/tests/admin.test.ts web/src/api.ts web/src/pages/Admin.tsx web/src/pages/Admin.test.tsx
git commit -m "feat: manage AI Horde channels in admin"
```

### Task 8: Final regression and documentation check

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document a minimal channel and request example**

Extend the existing `DATA_DIR/config.yaml` example with this AI Horde channel and model:

```yaml
channels:
  - name: horde
    type: ai-horde
    baseUrl: https://aihorde.net/api/v2
    keys: ["0000000000"]
models:
  - name: pony
    channel: horde
    upstream: Pony Diffusion
```

Include one generation request with `horde.nsfw` and `horde.params`, and state that edits use img2img without a mask and inpainting with a mask.

Update the feature and limitation text so it no longer says only OpenAI-compatible upstreams are supported, and mention that `sharp` performs AI Horde edit-image conversion.

- [ ] **Step 2: Run formatting/static checks available in the repository**

Run: `git diff --check`

Expected: no output.

Run: `npm run build`

Expected: both web and server builds succeed.

- [ ] **Step 3: Run the complete test suite**

Run: `npm test`

Expected: server and web Vitest suites both PASS.

- [ ] **Step 4: Inspect the final diff for security invariants**

Run:

```bash
rg -n "apikey|Client-Agent|source_image|source_mask|keyRetrySafe|providerFor" server/src
git diff --stat
git status --short
```

Expected: identity headers are overwritten after extra headers; image Base64 and API keys are absent from logs/errors/history; post-submit errors are not key-retry-safe; only intended files are modified.

- [ ] **Step 5: Commit final documentation or verification fixes**

```bash
git add README.md
git commit -m "docs: explain AI Horde channel setup"
```
