# NSFW Model Access Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add administrator-controlled NSFW permission to users and NSFW capability flags to model mappings, enforced across every discovery and execution path.

**Architecture:** Persist both flags as default-false SQLite columns. Build a shared `ModelAccessPolicy` from the authenticated user and pass it through listing, health aggregation, executor calls, and router resolution; the router remains the final authorization boundary. Extend existing admin forms without adding user self-service or content classification.

**Tech Stack:** TypeScript, Fastify, SQLite (`node:sqlite`), React, Vitest, Testing Library

---

## File map

- Persistence/config: `server/src/store/{db,repo,seed}.ts`, `server/src/core/types.ts`
- Authorization: `server/src/core/{router,executor}.ts`
- HTTP entry points: `server/src/server/{admin,v1,generations,stream,history,modelHealth}.ts`
- Server tests: repository/admin/router tests plus `server/tests/nsfw-access.test.ts`
- Admin UI: `web/src/api.ts`, `web/src/pages/Admin.tsx`, `web/src/pages/admin/UsersTab.tsx`
- UI tests: `web/src/pages/Admin.test.tsx`, `web/src/pages/admin/UsersTab.test.tsx`
- Documentation: `README.md`

### Task 1: Persist and administer both flags

**Files:**
- Modify: `server/src/store/db.ts`
- Modify: `server/src/store/repo.ts`
- Modify: `server/src/core/types.ts`
- Modify: `server/src/store/seed.ts`
- Modify: `server/src/server/admin.ts`
- Test: `server/tests/groups-users-store.test.ts`
- Test: `server/tests/groups-users-admin.test.ts`
- Test: `server/tests/files-seed.test.ts`
- Test: `server/tests/admin.test.ts`

- [ ] **Step 1: Write failing repository and seed tests**

Add these behaviors:

```ts
const safe = repo.createModel({ publicName: "safe", channelId: c.id });
const adult = repo.createModel({ publicName: "adult", channelId: c.id, supportsNsfw: true });
expect(safe.supportsNsfw).toBe(false);
expect(adult.supportsNsfw).toBe(true);
expect(repo.updateModel(safe.id, { supportsNsfw: true })?.supportsNsfw).toBe(true);

const user = repo.createUser({
  email: "nsfw@x.com", passwordHash: "a:b", role: "user", quotaTotal: 10,
});
expect(user.allowNsfw).toBe(false);
expect(repo.updateUser(user.id, { allowNsfw: true })?.allowNsfw).toBe(true);
```

Add seed cases for omitted and explicit `supportsNsfw`.

- [ ] **Step 2: Verify RED**

Run: `npm test -w server -- tests/groups-users-store.test.ts tests/files-seed.test.ts`

Expected: compilation/assertion failure because both properties are absent.

- [ ] **Step 3: Implement schema and repository support**

Append this migration:

```ts
  `
  ALTER TABLE users ADD COLUMN allow_nsfw INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE models ADD COLUMN supports_nsfw INTEGER NOT NULL DEFAULT 0;
  `,
```

Add the shared type:

```ts
export interface ModelAccessPolicy {
  allowedChannelIds: number[] | null;
  allowNsfw: boolean;
}
```

Add `supportsNsfw: boolean` to model rows/types and `allowNsfw: boolean` to users. Extend create/update SQL, optional input/patch types, and row conversion:

```ts
supportsNsfw: Number(row.supports_nsfw) === 1,
allowNsfw: Number(row.allow_nsfw) === 1,
```

Extend the seed model type with `supportsNsfw?: boolean` and pass it to `createModel`.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -w server -- tests/groups-users-store.test.ts tests/files-seed.test.ts`

Expected: both test files pass.

- [ ] **Step 5: Write failing admin API tests**

Create a user/model with each flag true, patch it false, update the administrator's own `allowNsfw`, and assert string values return 400:

```ts
expect((await app.inject({
  method: "PATCH",
  url: `/admin/users/${uid}`,
  headers: H,
  payload: { allowNsfw: "yes" },
})).statusCode).toBe(400);
```

- [ ] **Step 6: Verify admin tests are RED**

Run: `npm test -w server -- tests/groups-users-admin.test.ts tests/admin.test.ts`

Expected: new fields are ignored or missing.

- [ ] **Step 7: Implement strict admin API handling**

Expose `allowNsfw` from `toUserView`. Parse both fields with `optionalBoolean`; pass `allowNsfw` through user create/update and `supportsNsfw` through model create/update:

```ts
const allowNsfw = optionalBoolean(b, "allowNsfw");
const supportsNsfw = optionalBoolean(b, "supportsNsfw");
```

- [ ] **Step 8: Verify admin tests are GREEN**

Run: `npm test -w server -- tests/groups-users-admin.test.ts tests/admin.test.ts`

Expected: both files pass.

- [ ] **Step 9: Commit**

```bash
git add server/src/store server/src/core/types.ts server/src/server/admin.ts server/tests/groups-users-store.test.ts server/tests/groups-users-admin.test.ts server/tests/files-seed.test.ts server/tests/admin.test.ts
git commit -m "feat(server): persist NSFW user and model settings"
```

### Task 2: Enforce policy in the router

**Files:**
- Modify: `server/src/store/repo.ts`
- Modify: `server/src/core/router.ts`
- Modify: `server/src/core/executor.ts`
- Test: `server/tests/router.test.ts`
- Test: `server/tests/executor.test.ts`
- Test: `server/tests/groups-users-store.test.ts`

- [ ] **Step 1: Write failing route-policy tests**

```ts
const safe = repo.createModel({ publicName: "img", channelId: safeChannel.id, priority: 10 });
const adult = repo.createModel({
  publicName: "img", channelId: adultChannel.id, priority: 0, supportsNsfw: true,
});
expect(router.resolve("img", { allowedChannelIds: null, allowNsfw: false })?.model.id).toBe(safe.id);
expect(router.resolve("img", { allowedChannelIds: null, allowNsfw: true })?.model.id).toBe(adult.id);
expect(router.resolve("img", {
  allowedChannelIds: [adultChannel.id], allowNsfw: false,
})).toBeNull();
```

Also assert null/unbound policy is false and an opted-in user policy is true.

- [ ] **Step 2: Verify RED**

Run: `npm test -w server -- tests/router.test.ts tests/groups-users-store.test.ts`

Expected: `resolve` lacks the policy signature and `modelAccessPolicy` is absent.

- [ ] **Step 3: Implement policy construction and filtering**

Add to `Repo`:

```ts
modelAccessPolicy(userId: number | null): ModelAccessPolicy {
  return {
    allowedChannelIds: this.allowedChannelIds(userId),
    allowNsfw: userId === null ? false : this.getUser(userId)?.allowNsfw === true,
  };
}
```

Export and use this predicate in `router.ts`:

```ts
export function modelAllowedByPolicy(model: ModelRow, policy: ModelAccessPolicy): boolean {
  const channelAllowed = policy.allowedChannelIds === null
    || (policy.allowedChannelIds.length > 0 && policy.allowedChannelIds.includes(model.channelId));
  return channelAllowed && (policy.allowNsfw || !model.supportsNsfw);
}
```

Change `resolve` to accept a default-deny policy. Change `ExecutorOptions` from `allowedChannelIds` to required `modelAccess`, and resolve with it. Update executor fixtures to pass `{ allowedChannelIds: null, allowNsfw: false }`.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -w server -- tests/router.test.ts tests/executor.test.ts tests/groups-users-store.test.ts`

Expected: all three files pass.

- [ ] **Step 5: Commit**

```bash
git add server/src/store/repo.ts server/src/core/router.ts server/src/core/executor.ts server/tests/router.test.ts server/tests/executor.test.ts server/tests/groups-users-store.test.ts
git commit -m "feat(server): enforce NSFW policy in model routing"
```

### Task 3: Cover discovery, health, sync, stream, edits, and jobs

**Files:**
- Create: `server/tests/nsfw-access.test.ts`
- Modify: `server/tests/model-health.test.ts`
- Modify: `server/src/server/v1.ts`
- Modify: `server/src/server/modelHealth.ts`
- Modify: `server/src/server/generations.ts`
- Modify: `server/src/server/stream.ts`
- Modify: `server/src/server/history.ts`

- [ ] **Step 1: Write failing end-to-end tests**

Create a restricted mapping, upstream call counter, denied user, allowed user, bound keys, unbound key, and open-mode fixture. Cover:

```ts
expect(modelIds(await requestModels(deniedKey))).not.toContain("adult");
expect(modelIds(await requestModels(allowedKey))).toContain("adult");
expect(modelIds(await requestModels(unboundKey))).not.toContain("adult");
expect((await generate(deniedKey, "adult")).statusCode).toBe(404);
expect((await generate(unboundKey, "adult")).statusCode).toBe(404);
expect((await generate(allowedKey, "adult")).statusCode).toBe(200);
expect(upstreamCalls).toBe(1);
```

Add denied/allowed cases for `stream: true`, multipart edits, `/v1/images/jobs`, and `/v1/images/edit-jobs`. Poll background jobs to terminal state and prove denied work never reaches upstream. In open mode, prove the restricted mapping is hidden and direct generation returns 404.

- [ ] **Step 2: Verify RED**

Run: `npm test -w server -- tests/nsfw-access.test.ts`

Expected: denied callers can still discover or call the restricted mapping.

- [ ] **Step 3: Thread one policy through all paths**

At request boundaries:

```ts
const modelAccess = ctx.deps.repo.modelAccessPolicy(req.callerUserId ?? null);
```

Pass `modelAccess` to executor calls and background job route options. Before starting SSE, call `router.resolve(model, modelAccess)` so access errors remain JSON 404.

Filter `/v1/models` before deduplication:

```ts
const policy = ctx.deps.repo.modelAccessPolicy(req.callerUserId ?? null);
const models = ctx.deps.repo.listEnabledModels()
  .filter((mapping) => modelAllowedByPolicy(mapping, policy))
  .filter((mapping) => seen.has(mapping.publicName) ? false : (seen.add(mapping.publicName), true));
```

- [ ] **Step 4: Make health aggregation policy-aware**

Change `buildModelHealth` to accept `ModelAccessPolicy`, filter mappings with `modelAllowedByPolicy`, and call it with `repo.modelAccessPolicy`. Test:

```ts
const denied = buildModelHealth(repo, router, { allowedChannelIds: null, allowNsfw: false });
const allowed = buildModelHealth(repo, router, { allowedChannelIds: null, allowNsfw: true });
expect(denied.models.map((model) => model.model)).not.toContain("adult");
expect(allowed.models.map((model) => model.model)).toContain("adult");
```

- [ ] **Step 5: Verify GREEN**

Run: `npm test -w server -- tests/nsfw-access.test.ts tests/model-health.test.ts tests/v1-generations.test.ts tests/v1-edits.test.ts tests/v1-stream.test.ts tests/v1-history.test.ts`

Expected: all files pass and denied paths make zero restricted upstream calls.

- [ ] **Step 6: Commit**

```bash
git add server/src/server server/tests/nsfw-access.test.ts server/tests/model-health.test.ts
git commit -m "feat(server): apply NSFW policy across image APIs"
```

### Task 4: Add administrator controls

**Files:**
- Modify: `web/src/api.ts`
- Modify: `web/src/pages/Admin.tsx`
- Modify: `web/src/pages/admin/UsersTab.tsx`
- Modify: `web/src/pages/Admin.test.tsx`
- Create: `web/src/pages/admin/UsersTab.test.tsx`

- [ ] **Step 1: Write failing UI tests**

Mock admin API responses, render both forms, and assert default-unchecked controls:

```ts
expect(screen.getByRole("checkbox", { name: "支持 NSFW" })).not.toBeChecked();
expect(screen.getByRole("checkbox", { name: "允许使用 NSFW 模型" })).not.toBeChecked();
```

Toggle and submit each form; assert bodies contain `supportsNsfw: true` or `allowNsfw: true`. Render true/false rows and assert model badges say “支持/不支持” and user badges say “允许/禁止”.

- [ ] **Step 2: Verify RED**

Run: `npm test -w web -- src/pages/Admin.test.tsx src/pages/admin/UsersTab.test.tsx`

Expected: controls and badges are absent.

- [ ] **Step 3: Implement types and model control**

Add `supportsNsfw: boolean` to `ModelMapping` and `allowNsfw: boolean` to `UserView`. Initialize new model drafts with false, add:

```tsx
<label className="check">
  <input type="checkbox"
    checked={editing.supportsNsfw ?? false}
    onChange={(event) => setEditing({ ...editing, supportsNsfw: event.target.checked })}
  />{" "}支持 NSFW
</label>
```

Add an NSFW table column with “支持/不支持”.

- [ ] **Step 4: Implement user control and payload**

Initialize user drafts with false. Include the flag in create and patch bodies:

```ts
const body: Record<string, unknown> = {
  groupIds: editing.groupIds ?? [],
  enabled: editing.enabled,
  allowNsfw: editing.allowNsfw ?? false,
};
```

Add a checkbox labeled “允许使用 NSFW 模型” and an “NSFW 权限” column with “允许/禁止”. Keep the full edit form restricted to ordinary users, but add an NSFW permission toggle for every row so an administrator can explicitly configure administrator accounts:

```ts
const toggleNsfw = async (user: UserView): Promise<void> => {
  await api(`/admin/users/${user.id}`, {
    method: "PATCH",
    body: { allowNsfw: !user.allowNsfw },
  });
  load();
};
```

Render its button label as `允许 NSFW` when false and `禁止 NSFW` when true. Extend the UI test to click this action on an administrator row and assert the PATCH body.

- [ ] **Step 5: Verify GREEN**

Run: `npm test -w web -- src/pages/Admin.test.tsx src/pages/admin/UsersTab.test.tsx`

Expected: both files pass.

- [ ] **Step 6: Commit**

```bash
git add web/src/api.ts web/src/pages/Admin.tsx web/src/pages/admin/UsersTab.tsx web/src/pages/Admin.test.tsx web/src/pages/admin/UsersTab.test.tsx
git commit -m "feat(web): configure NSFW model access"
```

### Task 5: Document and verify

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update documentation**

Document both default-off flags, administrator-only user configuration, denial for unbound/open-mode callers, and add:

```yaml
models:
  - name: pony
    channel: horde
    upstream: Pony Diffusion
    supportsNsfw: true
```

- [ ] **Step 2: Verify diff and build**

Run:

```bash
git diff --check
npm run build
```

Expected: diff check and both builds exit 0.

- [ ] **Step 3: Run the complete suite**

Run: `npm test`

Expected: all server and web tests pass with zero failures.

- [ ] **Step 4: Review scope and commit docs**

Run:

```bash
git diff --stat 7124294..HEAD
git status --short
```

Confirm the diff contains both migrations, both controls, router enforcement, all API paths, tests, and no unrelated files. Then:

```bash
git add README.md
git commit -m "docs: explain NSFW model permissions"
```

- [ ] **Step 5: Re-run final verification**

Run:

```bash
git status --short
npm test
npm run build
```

Expected: clean status, all tests pass, and the build exits 0.
