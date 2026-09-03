import fs from "node:fs";
import path from "node:path";
import type { FastifyReply } from "fastify";
import type { AppContext } from "../app.js";

// 生成图文件名：<32位hex>.<扩展名>，/files 与 /v1/download 共用同一校验规则
export const NAME_RE = /^([0-9a-f]{32})\.(png|jpe?g|webp)$/;
const STAGED_NAME_RE = /^([0-9a-f]{32})\.(png|jpg|webp)$/;
const CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

function notFound(reply: FastifyReply, message: string): void {
  reply.code(404).send({ error: { message, type: "invalid_request_error", code: null } });
}

export function registerFiles(ctx: AppContext): void {
  ctx.app.get("/files/:name", async (req, reply) => {
    const { name } = req.params as { name: string };
    const match = NAME_RE.exec(name);
    if (!match) {
      notFound(reply, "invalid file name");
      return;
    }
    const full = path.join(ctx.deps.env.dataDir, "generated", `${match[1]}.${match[2]}`);
    if (!fs.existsSync(full)) {
      notFound(reply, "file not found or expired");
      return;
    }
    reply.header("content-type", CONTENT_TYPES[match[2]] ?? "application/octet-stream");
    reply.header("cache-control", "private, max-age=86400");
    reply.header("x-content-type-options", "nosniff");
    return reply.send(fs.createReadStream(full));
  });

  // Cloudflare Image Resizing 的专用回源路由。只接受随机暂存名，不回落到 generated。
  ctx.app.get("/upscale-inputs/:name", async (req, reply) => {
    const { name } = req.params as { name: string };
    const match = STAGED_NAME_RE.exec(name);
    if (!match) {
      notFound(reply, "invalid staged image name");
      return;
    }
    const full = path.join(ctx.deps.env.dataDir, "upscale-inputs", `${match[1]}.${match[2]}`);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
      notFound(reply, "staged image not found or expired");
      return;
    }
    reply.header("content-type", CONTENT_TYPES[match[2]] ?? "application/octet-stream");
    reply.header("cache-control", "public, max-age=3600");
    reply.header("x-content-type-options", "nosniff");
    return reply.send(fs.createReadStream(full));
  });
}
