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
import { hashPassword } from "../src/core/password.js";

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG_BUF = Buffer.from(PNG_B64, "base64");
const WEBP_B64 = "UklGRhIAAABXRUJQVlA4TAYAAAAvAAAAAAfQ//73v/+BiOh/AAA=";
const WEBP_BUF = Buffer.from(WEBP_B64, "base64");

let dir: string;
let repo: Repo;
let app: Awaited<ReturnType<typeof buildApp>>;
let H: { authorization: string };
let H2: { authorization: string };

async function login(email: string, password: string): Promise<{ authorization: string }> {
  const res = await app.inject({ method: "POST", url: "/admin/auth/login", payload: { email, password } });
  return { authorization: `Bearer ${(res.json() as { token: string }).token}` };
}

async function injectForm(
  url: string,
  method: "POST" | "PUT",
  fields: Record<string, string>,
  files: Record<string, Buffer>,
  headers: { authorization: string },
): Promise<ReturnType<typeof app.inject>> {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  for (const [k, buf] of Object.entries(files)) form.append(k, new Blob([new Uint8Array(buf)], { type: "image/png" }), `${k}.png`);
  const r = new Request("http://local/", { method: "POST", body: form });
  return app.inject({
    method,
    url,
    payload: Buffer.from(await r.arrayBuffer()),
    headers: { "content-type": r.headers.get("content-type")!, ...headers },
  });
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tpl-"));
  repo = new Repo(openDb(dir));
  repo.createUser({ email: "admin@local", passwordHash: hashPassword("admin-pass"), role: "admin", quotaTotal: null });
  repo.createUser({ email: "user@local", passwordHash: hashPassword("user-pass"), role: "user", quotaTotal: 100 });
  const provider = new OpenAICompatProvider();
  const router = new ModelRouter(repo);
  const keyPool = new KeyPool(repo);
  const providers = new Map([["openai-compat", provider]]);
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
  H = await login("admin@local", "admin-pass");
  H2 = await login("user@local", "user-pass");
});

afterEach(async () => {
  await app.close();
  repo.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function templateFile(name: string): string {
  return path.join(dir, "templates", name);
}

describe("official templates", () => {
  it("admin endpoints require admin", async () => {
    expect((await app.inject({ url: "/admin/templates" })).statusCode).toBe(401);
    expect((await app.inject({ url: "/admin/templates", headers: H2 })).statusCode).toBe(403);
    expect((await app.inject({ method: "DELETE", url: "/admin/templates/1", headers: H2 })).statusCode).toBe(403);
  });

  it("creates a text2image template with a generated example image", async () => {
    const res = await injectForm(
      "/admin/templates",
      "POST",
      { type: "text2image", name: "极简线条狼", prompt: "minimal line-art tattoo of a wolf", enabled: "1", sortOrder: "2" },
      { image: PNG_BUF },
      H,
    );
    expect(res.statusCode).toBe(201);
    const row = res.json() as { id: number; type: string; exampleImage: string | null; exampleBefore: string | null };
    expect(row.type).toBe("text2image");
    expect(row.exampleImage).toMatch(/^[0-9a-f]{32}\.png$/);
    expect(row.exampleBefore).toBeNull();
    expect(fs.existsSync(templateFile(row.exampleImage!))).toBe(true);

    // 示例图可通过 /files/templates 访问
    const file = await app.inject({ url: `/files/templates/${row.exampleImage}` });
    expect(file.statusCode).toBe(200);
    expect(file.headers["content-type"]).toBe("image/png");

    // 前台列表带示例 URL
    const list = await app.inject({ url: "/v1/templates", headers: { ...H2, host: "localhost" } });
    expect(list.statusCode).toBe(200);
    const items = list.json() as { id: number; exampleImage: string | null; exampleBefore: string | null }[];
    expect(items).toHaveLength(1);
    expect(items[0].exampleImage).toBe(`http://localhost/files/templates/${row.exampleImage}`);
    expect(items[0].exampleBefore).toBeNull();
  });

  it("creates an image2image template with before/after examples", async () => {
    const res = await injectForm(
      "/admin/templates",
      "POST",
      { type: "image2image", name: "风格化纹身", prompt: "turn this into a tattoo design" },
      { before: PNG_BUF, after: WEBP_BUF },
      H,
    );
    expect(res.statusCode).toBe(201);
    const row = res.json() as { exampleImage: string | null; exampleBefore: string | null; exampleAfter: string | null };
    expect(row.exampleImage).toBeNull();
    expect(row.exampleBefore).toMatch(/\.png$/);
    expect(row.exampleAfter).toMatch(/\.webp$/);
    expect(fs.existsSync(templateFile(row.exampleBefore!))).toBe(true);
    expect(fs.existsSync(templateFile(row.exampleAfter!))).toBe(true);
  });

  it("saves a text-only template when no example image was generated", async () => {
    const res = await injectForm("/admin/templates", "POST", { type: "text2image", name: "纯文字模板", prompt: "blackwork snake" }, {}, H);
    expect(res.statusCode).toBe(201);
    const row = res.json() as { exampleImage: string | null };
    expect(row.exampleImage).toBeNull();
  });

  it("replaces the example image on update and removes the old file", async () => {
    const created = await injectForm("/admin/templates", "POST", { type: "text2image", name: "t", prompt: "p" }, { image: PNG_BUF }, H);
    const row = created.json() as { id: number; exampleImage: string };
    const updated = await injectForm(`/admin/templates/${row.id}`, "PUT", {}, { image: WEBP_BUF }, H);
    expect(updated.statusCode).toBe(200);
    const next = updated.json() as { exampleImage: string };
    expect(next.exampleImage).not.toBe(row.exampleImage);
    expect(next.exampleImage).toMatch(/\.webp$/);
    expect(fs.existsSync(templateFile(row.exampleImage))).toBe(false);
    expect(fs.existsSync(templateFile(next.exampleImage))).toBe(true);
  });

  it("never clears a saved example image (示例图不可删除)", async () => {
    const created = await injectForm("/admin/templates", "POST", { type: "text2image", name: "t", prompt: "p" }, { image: PNG_BUF }, H);
    const row = created.json() as { id: number; exampleImage: string };
    // multipart 更新不带图片字段
    await injectForm(`/admin/templates/${row.id}`, "PUT", { name: "renamed" }, {}, H);
    // JSON 更新显式传 null
    const cleared = await app.inject({ method: "PUT", url: `/admin/templates/${row.id}`, headers: H, payload: { exampleImage: null, exampleBefore: null, exampleAfter: null } });
    expect(cleared.statusCode).toBe(200);
    const after = repo.getTemplate(row.id)!;
    expect(after.exampleImage).toBe(row.exampleImage);
    expect(fs.existsSync(templateFile(row.exampleImage))).toBe(true);
  });

  it("hides disabled templates from the public list but keeps them for admin", async () => {
    const created = await injectForm("/admin/templates", "POST", { type: "text2image", name: "t", prompt: "p" }, {}, H);
    const row = created.json() as { id: number };
    const toggled = await app.inject({ method: "PUT", url: `/admin/templates/${row.id}`, headers: H, payload: { enabled: false } });
    expect(toggled.statusCode).toBe(200);
    expect((toggled.json() as { enabled: boolean }).enabled).toBe(false);
    expect((await app.inject({ url: "/v1/templates", headers: H2 })).json()).toEqual([]);
    const adminList = (await app.inject({ url: "/admin/templates", headers: H })).json() as unknown[];
    expect(adminList).toHaveLength(1);
  });

  it("rejects changing the template type", async () => {
    const created = await injectForm("/admin/templates", "POST", { type: "text2image", name: "t", prompt: "p" }, {}, H);
    const row = created.json() as { id: number };
    const res = await app.inject({ method: "PUT", url: `/admin/templates/${row.id}`, headers: H, payload: { type: "image2image" } });
    expect(res.statusCode).toBe(400);
  });

  it("orders templates by sortOrder then id", async () => {
    await injectForm("/admin/templates", "POST", { type: "text2image", name: "b", prompt: "p", sortOrder: "5" }, {}, H);
    await injectForm("/admin/templates", "POST", { type: "text2image", name: "a", prompt: "p", sortOrder: "1" }, {}, H);
    await injectForm("/admin/templates", "POST", { type: "text2image", name: "c", prompt: "p", sortOrder: "5" }, {}, H);
    const names = ((await app.inject({ url: "/v1/templates", headers: H2 })).json() as { name: string }[]).map((r) => r.name);
    expect(names).toEqual(["a", "b", "c"]);
  });

  it("deletes a template and its example files", async () => {
    const created = await injectForm(
      "/admin/templates",
      "POST",
      { type: "image2image", name: "t", prompt: "p" },
      { before: PNG_BUF, after: PNG_BUF },
      H,
    );
    const row = created.json() as { id: number; exampleBefore: string; exampleAfter: string };
    const del = await app.inject({ method: "DELETE", url: `/admin/templates/${row.id}`, headers: H });
    expect(del.statusCode).toBe(204);
    expect(fs.existsSync(templateFile(row.exampleBefore))).toBe(false);
    expect(fs.existsSync(templateFile(row.exampleAfter))).toBe(false);
    expect(repo.getTemplate(row.id)).toBeNull();
    expect((await app.inject({ method: "DELETE", url: `/admin/templates/${row.id}`, headers: H })).statusCode).toBe(404);
  });

  it("validates create input", async () => {
    expect((await injectForm("/admin/templates", "POST", { name: "t", prompt: "p" }, {}, H)).statusCode).toBe(400);
    expect((await injectForm("/admin/templates", "POST", { type: "text2image", prompt: "p" }, {}, H)).statusCode).toBe(400);
    expect((await injectForm("/admin/templates", "POST", { type: "text2image", name: "t", prompt: "  " }, {}, H)).statusCode).toBe(400);
    expect((await injectForm("/admin/templates", "POST", { type: "wat", name: "t", prompt: "p" }, {}, H)).statusCode).toBe(400);
    expect((await injectForm("/admin/templates", "POST", { type: "text2image", name: "t", prompt: "p", sortOrder: "-1" }, {}, H)).statusCode).toBe(400);
    expect((await injectForm("/admin/templates", "POST", { type: "text2image", name: "t", prompt: "p" }, { image: Buffer.from("not an image") }, H)).statusCode).toBe(400);
    expect(repo.listTemplates()).toHaveLength(0);
  });

  it("404s on unknown template id and rejects non-multipart/JSON bodies", async () => {
    expect((await app.inject({ method: "PUT", url: "/admin/templates/999", headers: H, payload: { enabled: true } })).statusCode).toBe(404);
    const noBody = await app.inject({ method: "POST", url: "/admin/templates", headers: { ...H, "content-type": "text/plain" }, payload: "x" });
    expect(noBody.statusCode).toBe(400);
  });

  it("lets users record their own templates with a generated image", async () => {
    // 先建一个官方模板，验证官方排在用户模板前面
    await injectForm("/admin/templates", "POST", { type: "text2image", name: "官方模板", prompt: "p" }, {}, H);
    const res = await injectForm(
      "/v1/templates",
      "POST",
      { type: "text2image", name: "我的文生图模板", prompt: "my own tattoo prompt" },
      { image: PNG_BUF },
      H2,
    );
    expect(res.statusCode).toBe(201);
    const row = res.json() as { id: number; ownerUserId: number | null; exampleImage: string | null };
    expect(row.ownerUserId).toBe(repo.getUserByEmail("user@local")!.id);
    expect(row.exampleImage).toMatch(/\.png$/);
    expect(fs.existsSync(templateFile(row.exampleImage!))).toBe(true);

    // 本人可见且带 mine 标记；官方模板排在前面
    const list = (await app.inject({ url: "/v1/templates", headers: H2 })).json() as { id: number; mine: boolean; name: string }[];
    expect(list[0].mine).toBe(false);
    expect(list[list.length - 1]).toMatchObject({ id: row.id, mine: true });
    // 其他登录用户看不到
    await repo.createUser({ email: "user2@local", passwordHash: hashPassword("user2-pass"), role: "user", quotaTotal: 10 });
    const H3 = await login("user2@local", "user2-pass");
    const otherList = (await app.inject({ url: "/v1/templates", headers: H3 })).json() as { mine: boolean }[];
    expect(otherList.every((t) => !t.mine)).toBe(true);
    expect(otherList.some((t) => t.id === row.id)).toBe(false);
  });

  it("rejects user template recording without a login user (anon api key)", async () => {
    const key = repo.createApiKey("anon-key", null);
    const res = await injectForm("/v1/templates", "POST", { type: "text2image", name: "t", prompt: "p" }, {}, { authorization: `Bearer ${key.key}` });
    expect(res.statusCode).toBe(403);
  });

  it("users can delete their own templates but never official ones", async () => {
    // 官方模板（管理员创建）
    const official = await injectForm("/admin/templates", "POST", { type: "text2image", name: "官方", prompt: "p" }, {}, H);
    const officialRow = official.json() as { id: number };
    // 用户自己的模板
    const mine = await injectForm("/v1/templates", "POST", { type: "text2image", name: "我的", prompt: "p" }, { image: PNG_BUF }, H2);
    const mineRow = mine.json() as { id: number; exampleImage: string };

    // 官方模板不可被用户删除
    const deny = await app.inject({ method: "DELETE", url: `/v1/templates/${officialRow.id}`, headers: H2 });
    expect(deny.statusCode).toBe(403);

    // 删除别人的用户模板 → 404（当作不存在）
    await repo.createUser({ email: "user2@local", passwordHash: hashPassword("user2-pass"), role: "user", quotaTotal: 10 });
    const H3 = await login("user2@local", "user2-pass");
    expect((await app.inject({ method: "DELETE", url: `/v1/templates/${mineRow.id}`, headers: H3 })).statusCode).toBe(404);

    // 本人删除成功并清理示例图文件
    const del = await app.inject({ method: "DELETE", url: `/v1/templates/${mineRow.id}`, headers: H2 });
    expect(del.statusCode).toBe(204);
    expect(fs.existsSync(templateFile(mineRow.exampleImage))).toBe(false);
    expect((await app.inject({ method: "DELETE", url: `/v1/templates/${mineRow.id}`, headers: H2 })).statusCode).toBe(404);

    // 管理员仍可删除官方模板
    expect((await app.inject({ method: "DELETE", url: `/admin/templates/${officialRow.id}`, headers: H })).statusCode).toBe(204);
  });

  it("validates that example files match the template type", async () => {
    expect(
      (await injectForm("/v1/templates", "POST", { type: "image2image", name: "t", prompt: "p" }, { image: PNG_BUF }, H2)).statusCode,
    ).toBe(400);
    expect(
      (await injectForm("/v1/templates", "POST", { type: "text2image", name: "t", prompt: "p" }, { before: PNG_BUF }, H2)).statusCode,
    ).toBe(400);
    expect(repo.listTemplates()).toHaveLength(0);
  });

  it("shows the owner of user templates in the admin list", async () => {
    await injectForm("/v1/templates", "POST", { type: "text2image", name: "我的", prompt: "p" }, {}, H2);
    const list = (await app.inject({ url: "/admin/templates", headers: H })).json() as { ownerUserId: number | null; ownerEmail: string | null }[];
    expect(list).toHaveLength(1);
    expect(list[0].ownerEmail).toBe("user@local");
  });
});
