import sharp from "sharp";
import { DEFAULT_WATERMARK_STYLE, WATERMARK_POSITIONS, type WatermarkStyle } from "../store/repo.js";

// Alpine 镜像需安装 font-noto-cjk，否则中文署名会渲染为方框（见 Dockerfile）
const FONT_FAMILY =
  '"Noto Sans CJK SC", "Noto Sans CJK", "Noto Sans SC", "WenQuanYi Zen Hei", "PingFang SC", "Microsoft YaHei", sans-serif';

function xmlEscape(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

// 最终水印文字：固定前缀与用户署名以 · 连接，各自可空；两者皆空返回空串（不合成）
export function composeWatermarkText(prefix: string, userText: string): string {
  return [prefix.trim(), userText.trim()].filter(Boolean).join(" · ");
}

// 在原图字节上合成全尺寸 SVG 文字层，输出与输入同格式的 buffer；文字为空时原样返回
export async function applyWatermark(buf: Buffer, style: WatermarkStyle, userText: string): Promise<Buffer> {
  const text = composeWatermarkText(style.prefix, userText);
  if (!text) return buf;

  const image = sharp(buf, { failOn: "error" });
  const meta = await image.metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (width <= 0 || height <= 0) return buf;

  const position = WATERMARK_POSITIONS.includes(style.position) ? style.position : DEFAULT_WATERMARK_STYLE.position;
  const fontSize = Math.min(128, Math.max(12, Math.round(style.fontSize)));
  const opacity = Math.min(1, Math.max(0.1, style.opacity));
  const color = /^#[0-9a-fA-F]{6}$/.test(style.color) ? style.color : DEFAULT_WATERMARK_STYLE.color;
  const margin = Math.max(8, Math.round(fontSize * 0.75));

  const anchorX = position.endsWith("l") ? margin : position.endsWith("r") ? width - margin : width / 2;
  const textAnchor = position.endsWith("l") ? "start" : position.endsWith("r") ? "end" : "middle";
  const baselineY = position.startsWith("t") ? margin + fontSize : height - margin;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<text x="${anchorX}" y="${baselineY}" text-anchor="${textAnchor}" font-family='${FONT_FAMILY}' ` +
    `font-size="${fontSize}" fill="${color}" fill-opacity="${opacity}" stroke="#000000" stroke-opacity="0.35" ` +
    `stroke-width="${Math.max(2, Math.round(fontSize / 7))}" stroke-linejoin="round" paint-order="stroke">` +
    `${xmlEscape(text)}</text></svg>`;

  const composited = image.composite([{ input: Buffer.from(svg), top: 0, left: 0 }]);
  // 动图 webp 合成后输出静态帧（已知限制）；显式 toFormat 确保输出格式与输入一致
  if (meta.format === "jpeg") return composited.toFormat("jpeg", { quality: 90 }).toBuffer();
  if (meta.format === "webp") return composited.toFormat("webp", { quality: 90 }).toBuffer();
  return composited.toFormat("png").toBuffer();
}
