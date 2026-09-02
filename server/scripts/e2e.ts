import Fastify from "fastify";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../src/app.js";
import { Executor } from "../src/core/executor.js";
import { hashPassword } from "../src/core/password.js";
import { KeyPool } from "../src/core/keyPool.js";
import { ModelRouter } from "../src/core/router.js";
import { OpenAICompatProvider } from "../src/providers/openai-compat.js";
import { openDb } from "../src/store/db.js";
import { Repo } from "../src/store/repo.js";
import { JobManager } from "../src/server/jobs.js";

const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

// ---- mock 上游（OpenAI 兼容） ----
const upstream = Fastify();
upstream.post("/v1/images/generations", async (req, reply) => {
  const b = req.body as { model?: string; prompt?: string };
  console.log("[mock-upstream] got:", b?.model, JSON.stringify(b?.prompt));
  return reply.send({ created: 1700000000, data: [{ b64_json: PNG_B64, revised_prompt: "a white cat" }], usage: { total_tokens: 100 } });
});
upstream.get("/v1/models", async () => ({ object: "list", data: [{ id: "gpt-image-1" }] }));
await upstream.listen({ port: 0, host: "127.0.0.1" });
const upstreamPort = (upstream.server.address() as { port: number }).port;

// ---- tiny-images ----
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-"));
const repo = new Repo(openDb(dataDir));
const providers = new Map([["openai-compat", new OpenAICompatProvider()]]);
const router = new ModelRouter(repo);
const keyPool = new KeyPool(repo);
const app = await buildApp({
  env: { port: 0, dataDir, publicBaseUrl: null },
  repo,
  router,
  keyPool,
  providers,
  executor: new Executor({ router, keyPool, providers, repo }),
  jobManager: new JobManager(),
  logger: false,
  webDist: path.resolve(import.meta.dirname, "../../web/dist"),
});
await app.listen({ port: 0, host: "127.0.0.1" });
const port = (app.server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;
// 创建初始 admin 并用 JWT 作为管理凭证
repo.createUser({ email: "admin@local", passwordHash: hashPassword("e2e-admin-pass"), role: "admin", quotaTotal: null });
const loginRes = (await (
  await fetch(`${base}/admin/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "admin@local", password: "e2e-admin-pass" }),
  })
).json()) as { token: string };
const admin = { "content-type": "application/json", authorization: `Bearer ${loginRes.token}` };

// ---- 通过管理 API 配置 ----
const ch = await (
  await fetch(`${base}/admin/channels`, {
    method: "POST",
    headers: admin,
    body: JSON.stringify({ name: "mock", baseUrl: `http://127.0.0.1:${upstreamPort}/v1` }),
  })
).json();
await fetch(`${base}/admin/channels/${ch.id}/keys`, {
  method: "POST",
  headers: admin,
  body: JSON.stringify({ apiKey: "sk-upstream-mock" }),
});
const model = await (
  await fetch(`${base}/admin/models`, {
    method: "POST",
    headers: admin,
    body: JSON.stringify({ publicName: "img-1", channelId: ch.id, upstreamName: "gpt-image-1" }),
  })
).json();
console.log("[e2e] channel:", ch.name, "model mapping:", model.publicName, "->", model.upstreamName);

// ---- Playground 风格调用（OpenAI SDK 兼容路径） ----
const gen = await fetch(`${base}/v1/images/generations`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${loginRes.token}` },
  body: JSON.stringify({ model: "img-1", prompt: "a white cat", n: 1 }),
});
const genBody = (await gen.json()) as { created: number; data: { b64_json: string }[]; usage?: { total_tokens: number } };
console.log("[e2e] generations:", gen.status, "channel:", gen.headers.get("x-tiny-channel"), "usage:", genBody.usage?.total_tokens ?? "-", "b64 length:", genBody.data?.[0]?.b64_json?.length ?? "-");
console.assert(gen.status === 200 && genBody.data[0].b64_json === PNG_B64, "generation failed");

// ---- models 列表 ----
const models = await (await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${loginRes.token}` } })).json();
console.log("[e2e] /v1/models:", JSON.stringify(models.data));

// ---- 流式 ----
const streamRes = await fetch(`${base}/v1/images/generations`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${loginRes.token}` },
  body: JSON.stringify({ model: "img-1", prompt: "a white cat", stream: true }),
});
const streamText = await streamRes.text();
console.log("[e2e] stream events:", streamText.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6, 40)).join(" | "));

// ---- 静态托管 ----
const home = await fetch(`${base}/`);
const homeHtml = await home.text();
console.log("[e2e] GET /:", home.status, "is SPA:", homeHtml.includes("<div id=\"root\">"));

// ---- api key 鉴权 ----
const apiKey = await (
  await fetch(`${base}/admin/api-keys`, { method: "POST", headers: admin, body: JSON.stringify({ name: "e2e" }) })
).json();
const withKey = await fetch(`${base}/v1/images/generations`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${apiKey.key}` },
  body: JSON.stringify({ model: "img-1", prompt: "x" }),
});
console.log("[e2e] generation with sk-tiny key:", withKey.status);
const badKey = await fetch(`${base}/v1/images/generations`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: "Bearer wrong" },
  body: JSON.stringify({ model: "img-1", prompt: "x" }),
});
console.log("[e2e] generation with wrong key:", badKey.status);

// ---- 历史 + job 端点 ----
const keyHdr = { "content-type": "application/json", authorization: `Bearer ${apiKey.key}` };
const job = await (
  await fetch(`${base}/v1/images/jobs`, {
    method: "POST",
    headers: keyHdr,
    body: JSON.stringify({ model: "img-1", prompt: "history e2e cat" }),
  })
).json();
let jobStatus = { status: "running", images: [] as { file: string; url: string }[] } as unknown as {
  status: string;
  images: { file: string; url: string }[];
  error?: string | null;
};
for (let i = 0; i < 50 && jobStatus.status === "running"; i++) {
  await new Promise((r) => setTimeout(r, 100));
  jobStatus = (await (await fetch(`${base}/v1/images/jobs/${job.jobId}`, { headers: keyHdr })).json()) as typeof jobStatus;
}
console.log("[e2e] job:", jobStatus.status, "images:", jobStatus.images?.length ?? 0, "error:", jobStatus.error ?? "-");
console.assert(jobStatus.status === "ok" && jobStatus.images?.length === 1, "job failed");
const imgRes = await fetch(jobStatus.images[0]?.url ?? "", { headers: { authorization: `Bearer ${apiKey.key}` } });
console.log("[e2e] job image fetchable:", imgRes.status);

const hist = (await (await fetch(`${base}/v1/history?limit=5`, { headers: keyHdr })).json()) as {
  items: { prompt: string; status: string; images: { url: string }[] }[];
};
console.log("[e2e] history:", hist.items.length, "items, latest prompt:", hist.items[0]?.prompt);
console.assert(hist.items.length >= 2 && hist.items[0].prompt === "history e2e cat", "history missing records");
const histImg = await fetch(hist.items[0].images[0]?.url ?? "", { headers: { authorization: `Bearer ${apiKey.key}` } });
console.assert(histImg.status === 200, "history image not fetchable");
console.log("[e2e] history ok");

// ---- 日志 ----
const logs = await (await fetch(`${base}/admin/logs`, { headers: admin })).json();
console.log("[e2e] logs:", logs.length, "entries, last status:", logs[0]?.status);

// ---- 用户注册 ----
const regDisabled = await fetch(`${base}/admin/auth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "self@x.com", password: "self-pass" }) });
console.log("[e2e] register while disabled:", regDisabled.status);
console.assert(regDisabled.status === 403, "register should be disabled by default");
await fetch(`${base}/admin/settings`, {
  method: "PUT",
  headers: admin,
  body: JSON.stringify({ globalPrompt: "", announcement: "", registration: { enabled: true, dailyQuota: 30 } }),
});
const regStatus = await (await fetch(`${base}/admin/auth/register`)).json();
console.assert(regStatus.enabled === true, "register status should be enabled");
const reg = await fetch(`${base}/admin/auth/register`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: "self@x.com", password: "self-pass" }),
});
const regBody = (await reg.json()) as { token: string; role: string };
console.log("[e2e] register:", reg.status, "role:", regBody.role);
console.assert(reg.status === 201 && regBody.role === "user", "register failed");
const regMe = (await (await fetch(`${base}/admin/auth/me`, { headers: { authorization: `Bearer ${regBody.token}` } })).json()) as { quotaTotal: number | null; quotaRemaining: number | null };
console.log("[e2e] registered user quota:", regMe.quotaRemaining, "/", regMe.quotaTotal);
console.assert(regMe.quotaTotal === 30 && regMe.quotaRemaining === 30, "registered user should default to 30/day");
const regPw = await fetch(`${base}/admin/auth/password`, {
  method: "PUT",
  headers: { "content-type": "application/json", authorization: `Bearer ${regBody.token}` },
  body: JSON.stringify({ oldPassword: "self-pass", newPassword: "self-pass-2" }),
});
console.log("[e2e] registered user change password:", regPw.status);
console.assert(regPw.status === 204, "registered user should be able to change own password");

await app.close();
await upstream.close();
repo.close();
fs.rmSync(dataDir, { recursive: true, force: true });
console.log("[e2e] DONE");
