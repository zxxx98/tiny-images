# Chat Image Upstream Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow each OpenAI-compatible channel to generate through `/images/generations` or `/chat/completions` while preserving the gateway's Images API response.

**Architecture:** Persist a channel-level `generationMode` setting and expose it through the existing admin API/UI. Keep the executor and public V1 route unchanged; branch inside `OpenAICompatProvider.generate`, translate image requests to chat payloads, parse common structured and Markdown image outputs into `UnifiedImageResult`, then reuse existing image conformance and history flows.

**Tech Stack:** TypeScript, Fastify, Node SQLite migrations, React, Vitest

---

### Task 1: Persist and validate the channel generation mode

**Files:**
- Modify: `server/src/core/types.ts`
- Modify: `server/src/store/db.ts`
- Modify: `server/src/store/repo.ts`
- Modify: `server/src/store/seed.ts`
- Modify: `server/src/server/admin.ts`
- Test: `server/tests/store.test.ts`
- Test: `server/tests/admin.test.ts`
- Test: `server/tests/files-seed.test.ts`

- [ ] **Step 1: Write failing persistence and admin tests**

Add assertions that a new channel defaults to `generationMode: "images"`, accepts `generationMode: "chat"` during create/update/seed, and rejects values other than `images` and `chat` with HTTP 400.

```ts
const created = repo.createChannel({ name: "chat", baseUrl: "https://upstream.test/v1", generationMode: "chat" });
expect(created.generationMode).toBe("chat");
expect(repo.updateChannel(created.id, { generationMode: "images" })?.generationMode).toBe("images");
```

- [ ] **Step 2: Run focused tests and confirm the missing-field failures**

Run: `npm test -w server -- tests/store.test.ts tests/admin.test.ts tests/files-seed.test.ts`

Expected: FAIL because `generationMode` is absent from channel types, storage, and validation.

- [ ] **Step 3: Add the type, migration, repository mapping, seed input, and API validation**

Define:

```ts
export type GenerationMode = "images" | "chat";
```

Add migration SQL:

```sql
ALTER TABLE channels ADD COLUMN generation_mode TEXT NOT NULL DEFAULT 'images';
```

Include `generation_mode` in repository INSERT/UPDATE/read mapping, defaulting new rows to `images`. Extend seed channel input and `validateChannelInput`; only `images` and `chat` are accepted.

- [ ] **Step 4: Run focused tests and confirm green**

Run: `npm test -w server -- tests/store.test.ts tests/admin.test.ts tests/files-seed.test.ts`

Expected: all focused tests PASS.

### Task 2: Translate chat requests and parse common image response shapes

**Files:**
- Modify: `server/src/providers/openai-compat.ts`
- Test: `server/tests/provider.test.ts`

- [ ] **Step 1: Write failing provider request tests**

Register a mock `/v1/chat/completions` route and assert chat-mode generation sends the mapped model, server-built messages, default modalities, supported generation fields, and passthrough supplier options. Assert passthrough cannot override `model` or `messages` but can override `modalities`.

```ts
expect(seen).toMatchObject({
  model: "gpt-image-1",
  messages: [{ role: "user", content: "a cat" }],
  modalities: ["text", "image"],
  n: 2,
});
```

- [ ] **Step 2: Write failing response-parser tests**

Cover all of these response sources:

```ts
choices[0].message.images[0].image_url.url
choices[0].message.content[0].image_url.url
choices[0].delta.content[0].image_url.url
choices[0].message.content // Markdown image or exact image URL/data URL
```

Assert data URLs become `{ b64 }`, HTTP(S) values become `{ url }`, duplicates are removed, numeric `created` and `usage` are preserved, malformed base64 data URLs are ignored, and no recognized image produces `UpstreamError` 502.

- [ ] **Step 3: Run provider tests and confirm RED**

Run: `npm test -w server -- tests/provider.test.ts`

Expected: FAIL because generation still posts only to `/images/generations` and no chat parser exists.

- [ ] **Step 4: Implement minimal chat payload construction and parser helpers**

Branch in `generate` on `ctx.channel.generationMode`. Build payload in this precedence order so routing and global prompts cannot be bypassed:

```ts
const payload = {
  modalities: ["text", "image"],
  n: req.n,
  ...req.passthrough,
  model: ctx.upstreamModel,
  messages: [{ role: "user", content: req.prompt }],
};
```

Add `parseChatImagesResponse(json, channelName)` and small helpers that only accept valid HTTP(S) URLs and syntactically valid `data:image/*;base64,...` values. Traverse every choice's `message` and `delta`, parse structured arrays before Markdown strings, and deduplicate by original URL/data URL.

- [ ] **Step 5: Run provider tests and confirm GREEN**

Run: `npm test -w server -- tests/provider.test.ts`

Expected: all provider tests PASS.

### Task 3: Prove the public Images API works through a chat-only upstream

**Files:**
- Test: `server/tests/v1-generations.test.ts`
- Modify: `server/src/providers/openai-compat.ts` only if the integration exposes a missing behavior

- [ ] **Step 1: Write a failing V1 integration test**

Create a channel with `generationMode: "chat"`, expose only `/v1/chat/completions` on the mock upstream, return a Markdown or structured data URL, and call the gateway's `/v1/images/generations`.

```ts
expect(upstreamBody).toMatchObject({
  model: "gpt-image-1",
  messages: [{ role: "user", content: "cat" }],
});
expect(res.json()).toMatchObject({ data: [{ b64_json: PNG_B64 }] });
```

- [ ] **Step 2: Run the integration test and confirm RED**

Run: `npm test -w server -- tests/v1-generations.test.ts`

Expected: FAIL until test setup and Provider behavior route through chat mode.

- [ ] **Step 3: Make the smallest implementation correction needed**

Keep the V1 handler, executor, quota, history, and `conformImages` unchanged. Correct only Provider conversion or test app channel setup revealed by the failing integration.

- [ ] **Step 4: Run relevant server tests**

Run: `npm test -w server -- tests/provider.test.ts tests/v1-generations.test.ts tests/v1-stream.test.ts tests/executor.test.ts`

Expected: all relevant tests PASS.

### Task 4: Add the channel selector and document it

**Files:**
- Modify: `web/src/api.ts`
- Modify: `web/src/pages/Admin.tsx`
- Test: `web/src/pages/Admin.test.tsx`
- Modify: `README.md`

- [ ] **Step 1: Write the failing Web form-state test**

Assert `newChannelDraft()` defaults `generationMode` to `images` and `Channel` exposes the `"images" | "chat"` union.

```ts
expect(AdminModule.newChannelDraft()).toMatchObject({ generationMode: "images" });
```

- [ ] **Step 2: Run the Web test and confirm RED**

Run: `npm test -w web -- src/pages/Admin.test.tsx`

Expected: FAIL because the draft and form do not contain the setting.

- [ ] **Step 3: Add the selector and help text**

For OpenAI-compatible channels, add a select labelled `图片生成请求方式` with:

```tsx
<option value="images">Images API（/images/generations）</option>
<option value="chat">Chat API（/chat/completions）</option>
```

Update the API type and default draft. Document the setting, request transformation, supported chat response shapes, and unchanged public Images API in README.

- [ ] **Step 4: Run Web tests and production build**

Run: `npm test -w web && npm run build`

Expected: all Web tests PASS and both workspaces build successfully.

### Task 5: Full verification and review

**Files:**
- Review all modified files against `docs/superpowers/specs/2026-09-02-chat-image-upstream-design.md`

- [ ] **Step 1: Run full verification**

Run: `npm test && npm run build && git diff --check`

Expected: all server and Web tests PASS, production build exits 0, and diff check emits no errors.

- [ ] **Step 2: Inspect the final diff for scope and secrets**

Run: `git status --short && git diff --stat && git diff`

Expected: only the channel mode, chat adapter, tests, UI, and documentation are changed; no keys, generated build output, or unrelated files are present.

- [ ] **Step 3: Request code review and address findings**

Review the final branch against the design spec. Fix every Critical or Important finding, then rerun the verification command from Step 1.
