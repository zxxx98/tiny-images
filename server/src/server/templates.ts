import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { FastifyRequest } from "fastify";
import type { AppContext } from "../app.js";
import { httpError } from "../core/errors.js";
import type { TemplateInput, TemplateType } from "../store/repo.js";
import { fileBaseUrlFor } from "./generations.js";

const TEMPLATE_TYPES: TemplateType[] = ["text2image", "image2image"];
const NAME_MAX = 60;
const PROMPT_MAX = 4000;
const SORT_MAX = 1_000_000;

// 模板示例图字段名：image 为文生图生成示例，before/after 为图生图生成前后示例
type ExampleField = "image" | "before" | "after";
const EXAMPLE_FIELDS: ExampleField[] = ["image", "before", "after"];

function templatesDir(dataDir: string): string {
  const dir = path.join(dataDir, "templates");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// 按魔数判断图片类型并给出扩展名，其余一律拒绝（与 /files 的白名单保持一致）
function sniffImageExt(buf: Buffer): ".png" | ".jpg" | ".webp" {
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return ".png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return ".jpg";
  if (buf.length >= 12 && buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") return ".webp";
  throw httpError(400, "示例图片仅支持 PNG/JPG/WebP 格式");
}

export function saveTemplateImage(dataDir: string, buf: Buffer): string {
  const fileName = `${randomBytes(16).toString("hex")}${sniffImageExt(buf)}`;
  fs.writeFileSync(path.join(templatesDir(dataDir), fileName), buf);
  return fileName;
}

function removeTemplateImage(dataDir: string, fileName: string | null): void {
  if (!fileName) return;
  fs.rmSync(path.join(templatesDir(dataDir), fileName), { force: true });
}

interface TemplateParts {
  fields: Record<string, string>;
  files: Partial<Record<ExampleField, Buffer>>;
}

async function readMultipartParts(req: FastifyRequest): Promise<TemplateParts> {
  if (!req.isMultipart()) throw httpError(400, "multipart/form-data is required");
  const fields: Record<string, string> = {};
  const files: Partial<Record<ExampleField, Buffer>> = {};
  for await (const part of req.parts()) {
    if (part.type === "file") {
      if ((EXAMPLE_FIELDS as string[]).includes(part.fieldname)) {
        const buf = await part.toBuffer();
        if (buf.length > 0) files[part.fieldname as ExampleField] = buf;
      }
      continue;
    }
    fields[part.fieldname] = typeof part.value === "string" ? part.value : String(part.value ?? "");
  }
  return { fields, files };
}

// JSON 直传（如启用/停用开关）与 multipart 字段的公共校验
function parseFields(raw: Record<string, unknown>, opts: { requireType: boolean }): Partial<TemplateInput> {
  const out: Partial<TemplateInput> = {};
  if (raw.type !== undefined || opts.requireType) {
    const type = raw.type;
    if (!TEMPLATE_TYPES.includes(type as TemplateType)) throw httpError(400, `'type' must be 'text2image' or 'image2image'`);
    out.type = type as TemplateType;
  }
  if (raw.name !== undefined) {
    const name = String(raw.name).trim();
    if (!name) throw httpError(400, "'name' must be a non-empty string");
    if (name.length > NAME_MAX) throw httpError(400, `'name' must be at most ${NAME_MAX} characters`);
    out.name = name;
  }
  if (raw.prompt !== undefined) {
    const prompt = String(raw.prompt).trim();
    if (!prompt) throw httpError(400, "'prompt' must be a non-empty string");
    if (prompt.length > PROMPT_MAX) throw httpError(400, `'prompt' must be at most ${PROMPT_MAX} characters`);
    out.prompt = prompt;
  }
  if (raw.enabled !== undefined) {
    const v = raw.enabled;
    if (typeof v === "boolean") out.enabled = v;
    else if (v === "1" || v === "true") out.enabled = true;
    else if (v === "0" || v === "false") out.enabled = false;
    else throw httpError(400, "'enabled' must be a boolean");
  }
  if (raw.sortOrder !== undefined && raw.sortOrder !== "") {
    const n = Number(raw.sortOrder);
    if (!Number.isInteger(n) || n < 0 || n > SORT_MAX) throw httpError(400, `'sortOrder' must be an integer between 0 and ${SORT_MAX}`);
    out.sortOrder = n;
  }
  if (opts.requireType && out.type === undefined) throw httpError(400, "'type' is required");
  if (opts.requireType && (out.name === undefined || out.prompt === undefined)) {
    throw httpError(400, "'name' and 'prompt' are required");
  }
  return out;
}

// 示例图字段必须与模板类型匹配：image 只属于文生图，before/after 只属于图生图
function assertFilesMatchType(files: Partial<Record<ExampleField, Buffer>>, type: TemplateType): void {
  if (type === "text2image" && (files.before !== undefined || files.after !== undefined)) {
    throw httpError(400, "生成前/生成后示例图仅适用于图生图模板");
  }
  if (type === "image2image" && files.image !== undefined) {
    throw httpError(400, "生成示例图仅适用于文生图模板");
  }
}

async function readInput(req: FastifyRequest, opts: { requireType: boolean }): Promise<{ input: Partial<TemplateInput>; files: Partial<Record<ExampleField, Buffer>> }> {
  if (req.isMultipart()) {
    const { fields, files } = await readMultipartParts(req);
    return { input: parseFields(fields, opts), files };
  }
  const body = req.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) throw httpError(400, "a JSON object or multipart body is required");
  return { input: parseFields(body as Record<string, unknown>, opts), files: {} };
}

export function registerTemplates(ctx: AppContext): void {
  const repo = ctx.deps.repo;
  const dataDir = ctx.deps.env.dataDir;

  // ---- 前台：官方模板（所有人可见、只读）+ 自己录入的模板（本人可见、本人可删）----

  ctx.app.get("/v1/templates", { preHandler: ctx.requireApiKey }, async (req) => {
    const base = fileBaseUrlFor(ctx, req);
    const callerUserId = req.callerUserId ?? null;
    return repo.listVisibleTemplates(callerUserId).map((t) => ({
      id: t.id,
      type: t.type,
      name: t.name,
      prompt: t.prompt,
      exampleImage: t.exampleImage ? `${base}/files/templates/${t.exampleImage}` : null,
      exampleBefore: t.exampleBefore ? `${base}/files/templates/${t.exampleBefore}` : null,
      exampleAfter: t.exampleAfter ? `${base}/files/templates/${t.exampleAfter}` : null,
      mine: t.ownerUserId !== null && t.ownerUserId === callerUserId,
    }));
  });

  // 用户录入自己的模板：图片已生成就随表单一起录入，没生成就只录文字；
  // 示例图保存后不可删除（用户模板没有更新入口，只能整体删除重建）
  ctx.app.post("/v1/templates", { preHandler: ctx.requireApiKey }, async (req, reply) => {
    const callerUserId = req.callerUserId ?? null;
    if (callerUserId === null) throw httpError(403, "登录用户才能录入模板");
    const { input, files } = await readInput(req, { requireType: true });
    assertFilesMatchType(files, input.type!);
    const created = repo.createTemplate({
      type: input.type!,
      name: input.name!,
      prompt: input.prompt!,
      exampleImage: files.image ? saveTemplateImage(dataDir, files.image) : null,
      exampleBefore: files.before ? saveTemplateImage(dataDir, files.before) : null,
      exampleAfter: files.after ? saveTemplateImage(dataDir, files.after) : null,
      enabled: true,
      sortOrder: 0,
      ownerUserId: callerUserId,
    });
    return await reply.code(201).send(created);
  });

  // 只能删除自己录入的模板；官方模板（owner 为空）一律拒绝
  ctx.app.delete("/v1/templates/:id", { preHandler: ctx.requireApiKey }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const callerUserId = req.callerUserId ?? null;
    if (callerUserId === null) throw httpError(403, "登录用户才能删除自己录入的模板");
    const row = repo.getTemplate(id);
    if (!row) throw httpError(404, "template not found");
    if (row.ownerUserId === null) throw httpError(403, "官方模板不可删除");
    if (row.ownerUserId !== callerUserId) throw httpError(404, "template not found");
    repo.deleteTemplate(id);
    removeTemplateImage(dataDir, row.exampleImage);
    removeTemplateImage(dataDir, row.exampleBefore);
    removeTemplateImage(dataDir, row.exampleAfter);
    return await reply.code(204).send();
  });

  // ---- 后台管理 ----

  ctx.app.get("/admin/templates", { preHandler: ctx.requireAdmin }, async () =>
    repo.listTemplates().map((t) => ({
      ...t,
      ownerEmail: t.ownerUserId === null ? null : (repo.getUser(t.ownerUserId)?.email ?? null),
    })),
  );

  ctx.app.post("/admin/templates", { preHandler: ctx.requireAdmin }, async (req, reply) => {
    const { input, files } = await readInput(req, { requireType: true });
    assertFilesMatchType(files, input.type!);
    const created = repo.createTemplate({
      ...(input as { type: TemplateType; name: string; prompt: string }),
      exampleImage: files.image ? saveTemplateImage(dataDir, files.image) : null,
      exampleBefore: files.before ? saveTemplateImage(dataDir, files.before) : null,
      exampleAfter: files.after ? saveTemplateImage(dataDir, files.after) : null,
    });
    return await reply.code(201).send(created);
  });

  ctx.app.put("/admin/templates/:id", { preHandler: ctx.requireAdmin }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const existing = repo.getTemplate(id);
    if (!existing) throw httpError(404, "template not found");
    const { input, files } = await readInput(req, { requireType: false });
    if (input.type !== undefined && input.type !== existing.type) throw httpError(400, "模板类型不可修改，请删除后重建");
    assertFilesMatchType(files, existing.type);
    // 示例图片只进不出：上传了新图才替换（替换后清理旧文件），否则保持原图
    const next = {
      ...input,
      exampleImage: files.image ? saveTemplateImage(dataDir, files.image) : existing.exampleImage,
      exampleBefore: files.before ? saveTemplateImage(dataDir, files.before) : existing.exampleBefore,
      exampleAfter: files.after ? saveTemplateImage(dataDir, files.after) : existing.exampleAfter,
    };
    const updated = repo.updateTemplate(id, next);
    if (!updated) throw httpError(404, "template not found");
    if (updated.exampleImage !== existing.exampleImage) removeTemplateImage(dataDir, existing.exampleImage);
    if (updated.exampleBefore !== existing.exampleBefore) removeTemplateImage(dataDir, existing.exampleBefore);
    if (updated.exampleAfter !== existing.exampleAfter) removeTemplateImage(dataDir, existing.exampleAfter);
    return updated;
  });

  ctx.app.delete("/admin/templates/:id", { preHandler: ctx.requireAdmin }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const removed = repo.deleteTemplate(id);
    if (!removed) throw httpError(404, "template not found");
    removeTemplateImage(dataDir, removed.exampleImage);
    removeTemplateImage(dataDir, removed.exampleBefore);
    removeTemplateImage(dataDir, removed.exampleAfter);
    return await reply.code(204).send();
  });
}
