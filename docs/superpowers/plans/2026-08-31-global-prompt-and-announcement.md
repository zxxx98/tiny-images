# Global Prompt and Announcement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add database-backed global prompt and announcement settings, apply the prompt to every upstream image request, and show versioned announcements once per browser on Playground.

**Architecture:** A generic SQLite `settings` table is exposed through focused `Repo` methods. Admin-only settings endpoints and an authenticated announcement endpoint expose only the required data; `Executor` applies the prompt on a copied request so history and jobs retain user input. The React admin gets a settings tab, while Playground uses a small announcement dialog plus a localStorage version key.

**Tech Stack:** TypeScript, Node.js 22 SQLite, Fastify 5, React 18, Vite, Vitest, CSS.

---

## File map

- Modify `server/src/store/db.ts`: add the settings-table migration.
- Modify `server/src/store/repo.ts`: own settings defaults, reads, and atomic updates.
- Modify `server/tests/store.test.ts`: verify defaults, versioning, and persistence.
- Create `server/src/server/settings.ts`: register admin settings and user announcement routes.
- Modify `server/src/app.ts`: register the settings routes.
- Modify `server/tests/admin.test.ts`: verify authorization, validation, and response visibility.
- Modify `server/src/core/executor.ts`: copy requests and prepend the current global prompt before provider calls.
- Modify `server/tests/executor.test.ts`: verify generate/edit prompting and input immutability.
- Modify `web/src/api.ts`: add settings/announcement types and API functions.
- Modify `web/src/api.test.ts`: verify API methods and auth headers.
- Create `web/src/pages/admin/SettingsTab.tsx`: settings editor with existing form/status styles.
- Modify `web/src/pages/Admin.tsx`: add and render the settings tab.
- Create `web/src/pages/AnnouncementDialog.tsx`: local-version logic and accessible Win95-style dialog.
- Create `web/src/pages/AnnouncementDialog.test.ts`: test browser acknowledgement decisions.
- Modify `web/src/pages/Playground.tsx`: fetch and display unacknowledged announcements.
- Modify `web/src/styles.css`: add restrained modal and settings helper styles using existing tokens.
- Modify `README.md`: document global prompt and announcement behavior.

### Task 1: Persist application settings

**Files:**
- Modify: `server/src/store/db.ts`
- Modify: `server/src/store/repo.ts`
- Test: `server/tests/store.test.ts`

- [ ] **Step 1: Write failing repository tests**

Add tests that exercise public repository behavior rather than SQL details:

```ts
it("returns empty application settings by default", () => {
  expect(repo.getAppSettings()).toEqual({
    globalPrompt: "",
    announcement: "",
    announcementVersion: 0,
  });
});

it("persists settings and versions only changed announcements", () => {
  expect(repo.updateAppSettings({ globalPrompt: "house style", announcement: "hello" }))
    .toEqual({ globalPrompt: "house style", announcement: "hello", announcementVersion: 1 });
  expect(repo.updateAppSettings({ globalPrompt: "new style", announcement: "hello" }).announcementVersion).toBe(1);
  expect(repo.updateAppSettings({ globalPrompt: "new style", announcement: "changed" }).announcementVersion).toBe(2);
});
```

Use the existing `dir` fixture to prove the values survive reopening:

```ts
it("keeps application settings after reopening the database", () => {
  repo.updateAppSettings({ globalPrompt: "persistent style", announcement: "persistent notice" });
  repo.close();
  repo = new Repo(openDb(dir));
  expect(repo.getAppSettings()).toEqual({
    globalPrompt: "persistent style",
    announcement: "persistent notice",
    announcementVersion: 1,
  });
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `npm test -w server -- store.test.ts`

Expected: FAIL because `getAppSettings` and `updateAppSettings` do not exist.

- [ ] **Step 3: Add the migration and minimal repository API**

Append a migration in `server/src/store/db.ts`:

```ts
`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`,
```

Add to `server/src/store/repo.ts`:

```ts
export interface AppSettings {
  globalPrompt: string;
  announcement: string;
  announcementVersion: number;
}

getAppSettings(): AppSettings {
  const rows = this.db.prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[];
  const values = new Map(rows.map((row) => [row.key, row.value]));
  return {
    globalPrompt: values.get("global_prompt") ?? "",
    announcement: values.get("announcement") ?? "",
    announcementVersion: Number(values.get("announcement_version") ?? "0"),
  };
}

updateAppSettings(input: { globalPrompt: string; announcement: string }): AppSettings {
  const current = this.getAppSettings();
  const announcementVersion = current.announcement === input.announcement
    ? current.announcementVersion
    : current.announcementVersion + 1;
  const put = this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  this.db.exec("BEGIN IMMEDIATE;");
  try {
    put.run("global_prompt", input.globalPrompt);
    put.run("announcement", input.announcement);
    put.run("announcement_version", String(announcementVersion));
    this.db.exec("COMMIT;");
  } catch (error) {
    this.db.exec("ROLLBACK;");
    throw error;
  }
  return this.getAppSettings();
}
```

- [ ] **Step 4: Run repository tests and verify GREEN**

Run: `npm test -w server -- store.test.ts`

Expected: PASS with no failed tests.

- [ ] **Step 5: Commit the persistence slice**

```bash
git add server/src/store/db.ts server/src/store/repo.ts server/tests/store.test.ts
git commit -m "feat(server): persist application settings"
```

### Task 2: Expose settings and announcement endpoints

**Files:**
- Create: `server/src/server/settings.ts`
- Modify: `server/src/app.ts`
- Test: `server/tests/admin.test.ts`

- [ ] **Step 1: Write failing route tests**

Add this route group; `hashPassword` is already imported in the file:

```ts
describe("settings", () => {
  it("reads defaults and updates settings as admin", async () => {
    const initial = await app.inject({ url: "/admin/settings", headers: H });
    expect(initial.json()).toEqual({ globalPrompt: "", announcement: "", announcementVersion: 0 });
    const updated = await app.inject({
      method: "PUT",
      url: "/admin/settings",
      headers: H,
      payload: { globalPrompt: "house style", announcement: "Maintenance tonight" },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toEqual({ globalPrompt: "house style", announcement: "Maintenance tonight", announcementVersion: 1 });
    const repeated = await app.inject({
      method: "PUT",
      url: "/admin/settings",
      headers: H,
      payload: { globalPrompt: "new style", announcement: "Maintenance tonight" },
    });
    expect(repeated.json().announcementVersion).toBe(1);
  });

  it("protects admin settings while exposing only the announcement to users", async () => {
    repo.updateAppSettings({ globalPrompt: "secret prefix", announcement: "Maintenance tonight" });
    repo.createUser({ email: "user@local", passwordHash: hashPassword("user-pass"), role: "user", quotaTotal: null });
    const login = await app.inject({ method: "POST", url: "/admin/auth/login", payload: { email: "user@local", password: "user-pass" } });
    const userHeaders = { authorization: `Bearer ${(login.json() as { token: string }).token}` };
    expect((await app.inject({ url: "/admin/settings" })).statusCode).toBe(401);
    expect((await app.inject({ url: "/admin/settings", headers: userHeaders })).statusCode).toBe(403);
    const announcement = await app.inject({ url: "/v1/announcement", headers: userHeaders });
    expect(announcement.statusCode).toBe(200);
    expect(announcement.json()).toEqual({ announcement: "Maintenance tonight", version: 1 });
    expect(announcement.json()).not.toHaveProperty("globalPrompt");
  });
});
```

The user-facing response assertion is intentionally exact:

```ts
expect(announcement.json()).toEqual({ announcement: "Maintenance tonight", version: 1 });
expect(announcement.json()).not.toHaveProperty("globalPrompt");
```

Validate malformed inputs:

```ts
const bad = await app.inject({
  method: "PUT",
  url: "/admin/settings",
  headers: H,
  payload: { globalPrompt: 42, announcement: "text" },
});
expect(bad.statusCode).toBe(400);
```

- [ ] **Step 2: Run the route tests and verify RED**

Run: `npm test -w server -- admin.test.ts`

Expected: FAIL with 404 responses for `/admin/settings` and `/v1/announcement`.

- [ ] **Step 3: Implement focused route registration**

Create `server/src/server/settings.ts`:

```ts
import type { AppContext } from "../app.js";
import { requireBody, requireStr } from "./admin.js";

export function registerSettings(ctx: AppContext): void {
  ctx.app.get("/admin/settings", { preHandler: ctx.requireAdmin }, async () =>
    ctx.deps.repo.getAppSettings(),
  );

  ctx.app.put("/admin/settings", { preHandler: ctx.requireAdmin }, async (req) => {
    const body = requireBody(req);
    return ctx.deps.repo.updateAppSettings({
      globalPrompt: requireStr(body, "globalPrompt"),
      announcement: requireStr(body, "announcement"),
    });
  });

  ctx.app.get("/v1/announcement", { preHandler: ctx.requireUser }, async () => {
    const settings = ctx.deps.repo.getAppSettings();
    return { announcement: settings.announcement, version: settings.announcementVersion };
  });
}
```

Import and call `registerSettings(ctx)` in `server/src/app.ts` after auth route registration and before the generic not-found handler.

- [ ] **Step 4: Run route and server tests**

Run: `npm test -w server -- admin.test.ts`

Expected: PASS.

Run: `npm test -w server`

Expected: all server suites PASS.

- [ ] **Step 5: Commit the HTTP slice**

```bash
git add server/src/app.ts server/src/server/settings.ts server/tests/admin.test.ts
git commit -m "feat(server): add settings and announcement endpoints"
```

### Task 3: Apply the global prompt without changing recorded user input

**Files:**
- Modify: `server/src/core/executor.ts`
- Test: `server/tests/executor.test.ts`

- [ ] **Step 1: Write failing executor tests**

Extend the fake provider so tests can inspect the request. Cover generation, edit, empty setting, and immutability:

```ts
it("prepends the global prompt without mutating the caller request", async () => {
  repo.updateAppSettings({ globalPrompt: "shared style", announcement: "" });
  const request = gen();
  let upstreamPrompt = "";
  const provider: ImageProvider = {
    kind: "fake",
    async generate(req) { upstreamPrompt = req.prompt; return ok; },
    async edit(req) { upstreamPrompt = req.prompt; return ok; },
    async test() { return { ok: true, message: "" }; },
  };
  await build(provider).generate("img", request, { callerApiKeyId: null });
  expect(upstreamPrompt).toBe("shared style\np");
  expect(request.prompt).toBe("p");
});
```

For edit, use a request containing an image buffer and assert the prompt changes but the original request and image list do not. For an all-whitespace global prompt, assert the upstream receives the original prompt unchanged.

- [ ] **Step 2: Run executor tests and verify RED**

Run: `npm test -w server -- executor.test.ts`

Expected: FAIL because the provider still receives only the user prompt.

- [ ] **Step 3: Implement request copying at the unified executor boundary**

Add a pure helper in `server/src/core/executor.ts`:

```ts
export function withGlobalPrompt<T extends UnifiedGenRequest | UnifiedEditRequest>(request: T, globalPrompt: string): T {
  const prefix = globalPrompt.trim();
  if (!prefix) return request;
  return { ...request, prompt: `${prefix}\n${request.prompt}` } as T;
}
```

At the start of `call`, derive `upstreamRequest` from `this.deps.repo.getAppSettings().globalPrompt`, and pass that copy to `provider.generate` or `provider.edit`. Continue using the original payload for quota calculation and leave all history/job code unchanged.

- [ ] **Step 4: Verify executor and history behavior**

Run: `npm test -w server -- executor.test.ts v1-history.test.ts v1-stream.test.ts jobs.test.ts`

Expected: all selected suites PASS, demonstrating that upstream prompting changes while existing record shapes stay stable.

- [ ] **Step 5: Commit the execution slice**

```bash
git add server/src/core/executor.ts server/tests/executor.test.ts
git commit -m "feat(server): prepend global prompt upstream"
```

### Task 4: Add the admin settings editor in the existing visual style

**Files:**
- Modify: `web/src/api.ts`
- Modify: `web/src/api.test.ts`
- Create: `web/src/pages/admin/SettingsTab.tsx`
- Modify: `web/src/pages/Admin.tsx`

- [ ] **Step 1: Write failing web API tests**

Import `fetchSettings` and `saveSettings`, stub `fetch`, and assert:

```ts
await fetchSettings();
expect(fetchMock).toHaveBeenCalledWith("/admin/settings", expect.objectContaining({ method: "GET" }));

await saveSettings({ globalPrompt: "style", announcement: "hello" });
expect(fetchMock).toHaveBeenCalledWith("/admin/settings", expect.objectContaining({
  method: "PUT",
  body: JSON.stringify({ globalPrompt: "style", announcement: "hello" }),
}));
```

- [ ] **Step 2: Run the web API tests and verify RED**

Run: `npm test -w web -- api.test.ts`

Expected: FAIL because the functions are not exported.

- [ ] **Step 3: Add typed API methods**

Add to `web/src/api.ts`:

```ts
export interface AppSettings {
  globalPrompt: string;
  announcement: string;
  announcementVersion: number;
}

export const fetchSettings = (): Promise<AppSettings> => api<AppSettings>("/admin/settings");
export const saveSettings = (input: Pick<AppSettings, "globalPrompt" | "announcement">): Promise<AppSettings> =>
  api<AppSettings>("/admin/settings", { method: "PUT", body: input });
```

- [ ] **Step 4: Create the settings tab and wire it into Admin**

Create `web/src/pages/admin/SettingsTab.tsx` with controlled `globalPrompt` and `announcement` textareas, initial loading through `fetchSettings`, submit through `saveSettings`, a disabled save button while pending, and existing `.card`, `.inline-form`, `.ok`, `.error`, and `.btn.primary` classes. Use these labels and help texts:

```tsx
<label htmlFor="settings-global-prompt">全局提示词</label>
<textarea id="settings-global-prompt" rows={8} value={globalPrompt} onChange={(event) => setGlobalPrompt(event.target.value)} />
<p className="muted">会前置到全部图片生成和编辑请求；留空则不处理。</p>
<label htmlFor="settings-announcement">公告</label>
<textarea id="settings-announcement" rows={8} value={announcement} onChange={(event) => setAnnouncement(event.target.value)} />
<p className="muted">仅在 Playground 自动弹出；留空则不展示。</p>
<button className="btn primary" type="submit" disabled={saving}>{saving ? "保存中…" : "保存设置"}</button>
```

In `web/src/pages/Admin.tsx`, add `"settings"` to `Tab`, append `["settings", "设置"]` to `TABS`, import `SettingsTab`, and render it in the tab panel.

- [ ] **Step 5: Verify web tests and compile**

Run: `npm test -w web -- api.test.ts`

Expected: PASS.

Run: `npm run build -w web`

Expected: TypeScript and Vite build exit 0.

- [ ] **Step 6: Commit the admin UI slice**

```bash
git add web/src/api.ts web/src/api.test.ts web/src/pages/admin/SettingsTab.tsx web/src/pages/Admin.tsx
git commit -m "feat(web): add settings editor"
```

### Task 5: Show each Playground announcement once per browser

**Files:**
- Modify: `web/src/api.ts`
- Modify: `web/src/api.test.ts`
- Create: `web/src/pages/AnnouncementDialog.tsx`
- Create: `web/src/pages/AnnouncementDialog.test.ts`
- Modify: `web/src/pages/Playground.tsx`
- Modify: `web/src/styles.css`

- [ ] **Step 1: Write failing decision-logic and API tests**

Test the pure local-version rules:

```ts
expect(shouldShowAnnouncement({ announcement: "", version: 2 }, null)).toBe(false);
expect(shouldShowAnnouncement({ announcement: "hello", version: 2 }, null)).toBe(true);
expect(shouldShowAnnouncement({ announcement: "hello", version: 2 }, "2")).toBe(false);
expect(shouldShowAnnouncement({ announcement: "changed", version: 3 }, "2")).toBe(true);
```

Add this API test with the same `localStorage` and `fetch` stubs used by the surrounding suite:

```ts
it("fetches the current announcement", async () => {
  vi.stubGlobal("localStorage", { getItem: () => "web-token" });
  const fetchMock = vi.fn().mockResolvedValue(new Response(
    JSON.stringify({ announcement: "hello", version: 2 }),
    { status: 200, headers: { "content-type": "application/json" } },
  ));
  vi.stubGlobal("fetch", fetchMock);
  await expect(fetchAnnouncement()).resolves.toEqual({ announcement: "hello", version: 2 });
  expect(fetchMock).toHaveBeenCalledWith("/v1/announcement", expect.objectContaining({
    method: "GET",
    headers: expect.objectContaining({ authorization: "Bearer web-token" }),
  }));
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npm test -w web -- AnnouncementDialog.test.ts api.test.ts`

Expected: FAIL because the announcement helpers and API function do not exist.

- [ ] **Step 3: Add announcement types, API, and dialog**

Add to `web/src/api.ts`:

```ts
export interface Announcement {
  announcement: string;
  version: number;
}
export const fetchAnnouncement = (): Promise<Announcement> => api<Announcement>("/v1/announcement");
```

Create `web/src/pages/AnnouncementDialog.tsx`:

```tsx
import type { Announcement } from "../api";

export const ANNOUNCEMENT_ACK_KEY = "tiny-announcement-version";
export const shouldShowAnnouncement = (value: Announcement, acknowledged: string | null): boolean =>
  value.announcement.length > 0 && acknowledged !== String(value.version);

export default function AnnouncementDialog({ value, onAcknowledge }: { value: Announcement; onAcknowledge: () => void }) {
  return (
    <div className="detail-overlay announcement-overlay" role="presentation">
      <section className="win-window announcement-window" role="dialog" aria-modal="true" aria-labelledby="announcement-title">
        <header className="titlebar"><span id="announcement-title">公告</span></header>
        <div className="announcement-body">
          <p className="announcement-copy">{value.announcement}</p>
          <button className="btn primary" type="button" autoFocus onClick={onAcknowledge}>知道了</button>
        </div>
      </section>
    </div>
  );
}
```

- [ ] **Step 4: Integrate with Playground and preserve failure isolation**

In `web/src/pages/Playground.tsx`, load once on mount:

```ts
const [announcement, setAnnouncement] = useState<Announcement | null>(null);
useEffect(() => {
  fetchAnnouncement()
    .then((value) => {
      if (shouldShowAnnouncement(value, localStorage.getItem(ANNOUNCEMENT_ACK_KEY))) setAnnouncement(value);
    })
    .catch(() => undefined);
}, []);

const acknowledgeAnnouncement = (): void => {
  if (!announcement) return;
  localStorage.setItem(ANNOUNCEMENT_ACK_KEY, String(announcement.version));
  setAnnouncement(null);
};
```

Render `AnnouncementDialog` next to the existing page root when state is non-null. Do not couple this error path to Playground's generation errors.

- [ ] **Step 5: Style with existing Win95 tokens**

Append to `web/src/styles.css`:

```css
.announcement-window { width: min(520px, 100%); }
.announcement-body { display: flex; flex-direction: column; gap: 16px; padding: 16px; }
.announcement-copy {
  margin: 0;
  padding: 12px;
  min-height: 96px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  background: #fff;
  border: 2px solid;
  border-color: var(--bevel-in-border);
  box-shadow: var(--bevel-in-shadow);
}
.announcement-body .btn { align-self: flex-end; min-width: 88px; }
```

- [ ] **Step 6: Run web tests and build**

Run: `npm test -w web`

Expected: all web tests PASS.

Run: `npm run build -w web`

Expected: exit 0 with a generated production bundle.

- [ ] **Step 7: Commit the announcement UI slice**

```bash
git add web/src/api.ts web/src/api.test.ts web/src/pages/AnnouncementDialog.tsx web/src/pages/AnnouncementDialog.test.ts web/src/pages/Playground.tsx web/src/styles.css
git commit -m "feat(web): show versioned Playground announcements"
```

### Task 6: Document and verify the complete feature

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update operator documentation**

Append this section after the configuration table:

```markdown
### 管理设置

管理员可在「管理后台 → 设置」编辑全局提示词和公告。全局提示词会在服务端前置到所有生成与图片编辑请求，但历史记录仍保留用户原始提示词。非空公告会在 Playground 自动弹出；用户点击“知道了”后当前浏览器不再显示该版本，管理员修改公告后会再次显示。
```

- [ ] **Step 2: Run all verification commands fresh**

Run: `npm test`

Expected: server and web Vitest suites complete with 0 failures.

Run: `npm run build`

Expected: web Vite build and server TypeScript build both exit 0.

Run: `git diff --check`

Expected: no output and exit 0.

- [ ] **Step 3: Review the requirements against the diff**

Confirm from the final diff that:

- defaults are empty;
- the existing marquee is untouched;
- generation and edit requests receive the prefix;
- history and job prompts remain original;
- only Playground fetches/displays the announcement;
- acknowledgement is browser-local and versioned;
- settings and dialog reuse current visual classes and tokens;
- global prompt is never returned by the ordinary-user endpoint.

- [ ] **Step 4: Commit documentation**

```bash
git add README.md
git commit -m "docs: explain global prompt and announcements"
```
