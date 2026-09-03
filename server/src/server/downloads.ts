import fs from "node:fs";
import path from "node:path";
import type { AppContext } from "../app.js";
import { httpError } from "../core/errors.js";
import { applyWatermark } from "../media/watermark.js";
import { effectiveWatermarkStyle, WATERMARK_POSITIONS, type UserWatermarkStyle, type WatermarkPosition } from "../store/repo.js";
import { requireBody } from "./admin.js";
import { NAME_RE } from "./files.js";

const CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

// 用户自定义样式校验：四项全部合法才接受；固定前缀不在用户可改范围内
function requireUserWatermarkStyle(value: unknown): UserWatermarkStyle {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw httpError(400, "'style' must be an object");
  }
  const source = value as Record<string, unknown>;
  if (typeof source.position !== "string" || !WATERMARK_POSITIONS.includes(source.position as WatermarkPosition)) {
    throw httpError(400, "'style.position' is invalid");
  }
  if (typeof source.fontSize !== "number" || !Number.isInteger(source.fontSize) || source.fontSize < 12 || source.fontSize > 128) {
    throw httpError(400, "'style.fontSize' must be an integer between 12 and 128");
  }
  if (typeof source.opacity !== "number" || source.opacity < 0.1 || source.opacity > 1) {
    throw httpError(400, "'style.opacity' must be a number between 0.1 and 1");
  }
  if (typeof source.color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(source.color)) {
    throw httpError(400, "'style.color' must be a hex color like #ffffff");
  }
  return {
    position: source.position as WatermarkPosition,
    fontSize: source.fontSize,
    opacity: source.opacity,
    color: source.color,
  };
}

// Web 登录用户的图片下载出口：原图文件与 /files/* 始终不动，
// 仅在返回副本上按「管理员集中样式 + 用户署名」按需合成水印。
export function registerDownloads(ctx: AppContext): void {
  ctx.app.get("/v1/download/:name", { preHandler: ctx.requireUser }, async (req, reply) => {
    const { name } = req.params as { name: string };
    const match = NAME_RE.exec(name);
    if (!match) throw httpError(404, "file not found or expired");
    const full = path.join(ctx.deps.env.dataDir, "generated", name);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) throw httpError(404, "file not found or expired");

    const original: Buffer = fs.readFileSync(full);
    let out: Buffer = original;
    const watermark = ctx.deps.repo.getUser(req.callerUserId!)?.watermark;
    if (watermark?.enabled) {
      try {
        const style = effectiveWatermarkStyle(ctx.deps.repo.getAppSettings().watermarkStyle, watermark.style);
        out = await applyWatermark(original, style, watermark.text);
      } catch {
        // 合成失败不阻断下载，回退原图
        out = original;
      }
    }

    reply.header("content-type", CONTENT_TYPES[match[2]] ?? "application/octet-stream");
    reply.header("content-disposition", `attachment; filename="${name}"`);
    reply.header("cache-control", "no-store");
    return reply.send(out);
  });

  ctx.app.get("/v1/watermark", { preHandler: ctx.requireUser }, async (req) => {
    return { ...ctx.deps.repo.getWatermark(req.callerUserId!), styleDefaults: ctx.deps.repo.getAppSettings().watermarkStyle };
  });

  ctx.app.put("/v1/watermark", { preHandler: ctx.requireUser }, async (req) => {
    const body = requireBody(req);
    if (typeof body.enabled !== "boolean") throw httpError(400, "'enabled' must be a boolean");
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (text.length > 60) throw httpError(400, "'text' must be at most 60 characters");
    const style = body.style === undefined || body.style === null ? null : requireUserWatermarkStyle(body.style);
    ctx.deps.repo.setWatermark(req.callerUserId!, { enabled: body.enabled, text, style });
    return { ...ctx.deps.repo.getWatermark(req.callerUserId!), styleDefaults: ctx.deps.repo.getAppSettings().watermarkStyle };
  });
}
