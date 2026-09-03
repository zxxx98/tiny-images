import fs from "node:fs";
import path from "node:path";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AppContext } from "../app.js";
import { httpError, ValidationError } from "../core/errors.js";
import type { PlazaShareRow } from "../store/repo.js";
import { fileBaseUrlFor } from "./generations.js";

const FILE_RE = /^[0-9a-f]{32}\.(?:png|jpe?g|webp)$/;

// 分享者/查看者身份，与历史记录一致：admin 全量，普通用户按 JWT 用户
function plazaViewer(req: FastifyRequest): { admin: boolean; userId: number | null } {
  return { admin: req.callerRole === "admin", userId: req.callerUserId ?? null };
}

function serializeShare(ctx: AppContext, req: FastifyRequest, share: PlazaShareRow, viewer: { admin: boolean; userId: number | null }): Record<string, unknown> {
  const base = fileBaseUrlFor(ctx, req);
  const mine = viewer.userId !== null && share.userId === viewer.userId;
  return {
    id: share.id,
    createdAt: share.createdAt,
    userId: share.userId,
    author: share.authorEmail,
    model: share.model,
    prompt: share.prompt,
    revisedPrompt: share.revisedPrompt ?? undefined,
    width: share.width,
    height: share.height,
    url: `${base}/files/plaza/${share.file}`,
    mine,
    canDelete: viewer.admin || mine,
  };
}

export function registerPlaza(ctx: AppContext): void {
  // 分享一张生成图到广场：复制文件到 dataDir/plaza 并快照生成信息，独立于历史过期清理
  ctx.app.post("/v1/plaza", { preHandler: ctx.requireApiKey }, async (req, reply) => {
    const body = (req.body ?? {}) as { generationId?: unknown; imageIndex?: unknown };
    const viewer = plazaViewer(req);
    if (viewer.userId === null) {
      throw httpError(403, "分享到广场需要登录账号");
    }
    const generationId = Number.parseInt(String(body.generationId), 10);
    if (Number.isNaN(generationId)) throw new ValidationError("'generationId' must be an integer");
    const imageIndex = body.imageIndex === undefined ? 0 : Number.parseInt(String(body.imageIndex), 10);
    if (Number.isNaN(imageIndex) || imageIndex < 0) throw new ValidationError("'imageIndex' must be a non-negative integer");

    const row = ctx.deps.repo.getGenerationVisible(
      { admin: viewer.admin, userId: viewer.userId, apiKeyId: req.callerApiKeyId ?? null },
      generationId,
    );
    if (!row) {
      return (reply as FastifyReply).code(404).send({ error: { message: "record not found", type: "invalid_request_error", code: null } });
    }
    let images: { file?: unknown; width?: unknown; height?: unknown; revisedPrompt?: unknown }[] = [];
    try {
      images = JSON.parse(row.images || "[]");
    } catch {
      // images 字段损坏按无图处理
    }
    const img = row.status === "ok" ? images[imageIndex] : undefined;
    if (!img || typeof img?.file !== "string" || !FILE_RE.test(img.file)) {
      throw new ValidationError("图片不存在或尚未生成完成");
    }
    const source = path.join(ctx.deps.env.dataDir, "generated", img.file);
    if (!fs.existsSync(source)) {
      throw new ValidationError("图片文件已过期，无法分享到广场");
    }
    const plazaDir = path.join(ctx.deps.env.dataDir, "plaza");
    fs.mkdirSync(plazaDir, { recursive: true });
    fs.copyFileSync(source, path.join(plazaDir, img.file));

    const share = ctx.deps.repo.insertPlazaShare({
      createdAt: Date.now(),
      userId: viewer.userId,
      generationId: row.id,
      file: img.file,
      width: typeof img.width === "number" ? img.width : null,
      height: typeof img.height === "number" ? img.height : null,
      model: row.model,
      prompt: row.prompt,
      revisedPrompt: typeof img.revisedPrompt === "string" ? img.revisedPrompt : null,
    });
    return (reply as FastifyReply).code(200).send(serializeShare(ctx, req, share, viewer));
  });

  ctx.app.get("/v1/plaza", { preHandler: ctx.requireApiKey }, async (req, reply) => {
    // 无任何 API key 的部署里 requireApiKey 会匿名放行（生成接口的兼容行为）；
    // 广场仅登录可见，完全匿名的调用在此拦下
    if (req.callerApiKeyId == null && req.callerUserId == null) {
      return reply.code(401).send({ error: { message: "请先登录后查看广场", type: "invalid_request_error", code: "invalid_api_key" } });
    }
    const q = req.query as { before?: string; limit?: string; mine?: string };
    const limit = Math.min(100, Math.max(1, Number.parseInt(q.limit ?? "30", 10) || 30));
    let before: number | null = null;
    if (q.before !== undefined) {
      before = Number.parseInt(q.before, 10);
      if (Number.isNaN(before)) throw new ValidationError("'before' must be an integer id");
    }
    const viewer = plazaViewer(req);
    if (q.mine === "1" && viewer.userId === null) return { items: [] };
    const mineUserId = q.mine === "1" ? viewer.userId : null;
    const rows = ctx.deps.repo.listPlazaShares(before, limit, mineUserId);
    return { items: rows.map((r) => serializeShare(ctx, req, r, viewer)) };
  });

  ctx.app.delete("/v1/plaza/:id", { preHandler: ctx.requireApiKey }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const shareId = Number.parseInt(id, 10);
    if (Number.isNaN(shareId)) throw new ValidationError("'id' must be an integer");
    const viewer = plazaViewer(req);
    const row = ctx.deps.repo.getPlazaShare(shareId);
    if (!row || (viewer.userId !== row.userId && !viewer.admin)) {
      return reply.code(404).send({ error: { message: "share not found", type: "invalid_request_error", code: null } });
    }
    ctx.deps.repo.deletePlazaShare(shareId);
    if (FILE_RE.test(row.file)) {
      try {
        fs.rmSync(path.join(ctx.deps.env.dataDir, "plaza", row.file), { force: true });
      } catch {
        // 文件可能已被并发删除
      }
    }
    return reply.code(204).send();
  });
}
