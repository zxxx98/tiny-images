import sharp from "sharp";
import { joinUrl } from "../providers/openai-compat.js";
import { httpError, mapUpstreamFailure, UpstreamError, wrapNetworkError } from "./errors.js";
import { extractOptimizedContent, retryDelayMs } from "./promptOptimizer.js";
import type { PromptOptimizerSettings } from "../store/repo.js";

// 三档反推风格对应的打标指令，输出一律为英文提示词。
export const REVERSE_INSTRUCTIONS = {
  concise: `
Generate a concise AI image generation prompt.

Requirements:
- English only
- 50-100 words
- Focus on main subject, style and composition
`,
  detailed: `
Generate a detailed AI image generation prompt.

Include:
- subject
- appearance
- clothing
- environment
- composition
- camera angle
- lighting
- colors
- texture
- mood

English only.
150-250 words.
`,
  cinematic: `
Generate an extremely detailed cinematic AI image prompt.

Include:
- professional photography terminology
- lens and camera feeling
- lighting setup
- color grading
- atmosphere
- realistic material details
- artistic style

Suitable for Midjourney / SDXL / Flux.

English only.
Maximum 300 words.
`,
} as const;

export type ReverseStyle = keyof typeof REVERSE_INSTRUCTIONS;

export const REVERSE_STYLES = Object.keys(REVERSE_INSTRUCTIONS) as ReverseStyle[];

export function isReverseStyle(style: unknown): style is ReverseStyle {
  return typeof style === "string" && (REVERSE_STYLES as readonly string[]).includes(style);
}

export function assertValidReverseStyle(style: unknown): ReverseStyle {
  if (!isReverseStyle(style)) throw httpError(400, `'style' must be one of: ${REVERSE_STYLES.join(", ")}`);
  return style;
}

const IMAGE_MAX_BYTES = 20 * 1024 * 1024;
const IMAGE_MAX_PIXELS = 40_000_000;
// 发给视觉模型前统一缩到该边长以内，省 token 也规避上游大图限制
const IMAGE_MAX_SIDE = 1536;
const ALLOWED_MIME = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

const REQUEST_TIMEOUT_MS = 120_000;
const ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 400;

// Node 的 base64 解码对非法字符过于宽松，先用严格格式校验拦住明显不是图片数据的输入
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

export interface DecodedImage {
  buffer: Buffer;
  mimeType: string;
}

// 接受 data URL（image/png;base64,…）或裸 base64，返回解码后的图片
export function decodeReverseImage(value: string): DecodedImage {
  const trimmed = value.trim();
  if (!trimmed) throw httpError(400, "'image' is required");
  const match = trimmed.match(/^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,(.*)$/is);
  const mimeType = match ? match[1].toLowerCase() : "image/png";
  const base64 = (match ? match[2] : trimmed).replace(/\s/g, "");
  if (!BASE64_RE.test(base64)) throw httpError(400, "'image' is not valid base64 data");
  const buffer = Buffer.from(base64, "base64");
  if (buffer.length === 0) throw httpError(400, "'image' is not valid base64 data");
  if (buffer.length > IMAGE_MAX_BYTES) throw httpError(400, "'image' must be at most 20 MiB");
  if (!ALLOWED_MIME.has(mimeType)) throw httpError(400, "'image' must be PNG, JPEG, WebP or GIF");
  return { buffer, mimeType };
}

// 统一转码为 JPEG：尊重 EXIF 方向、缩到 IMAGE_MAX_SIDE 以内、去掉可能拖慢上游的大图
export async function prepareImageDataUrl(image: DecodedImage): Promise<string> {
  try {
    const buffer = await sharp(image.buffer, { limitInputPixels: IMAGE_MAX_PIXELS })
      .rotate()
      .resize({ width: IMAGE_MAX_SIDE, height: IMAGE_MAX_SIDE, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 88 })
      .toBuffer();
    return `data:image/jpeg;base64,${buffer.toString("base64")}`;
  } catch (err) {
    throw httpError(400, `'image' could not be decoded: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export type ReverseUpstreamSettings = PromptOptimizerSettings;

// 反推接口独立配置；未配置时回退到「AI 提示词优化」的接口（需该模型支持视觉）
export function resolveReverseUpstream(settings: {
  promptReverse: ReverseUpstreamSettings;
  promptOptimizer: ReverseUpstreamSettings;
}): ReverseUpstreamSettings | null {
  if (settings.promptReverse.baseUrl && settings.promptReverse.model) return settings.promptReverse;
  if (settings.promptOptimizer.baseUrl && settings.promptOptimizer.model) return settings.promptOptimizer;
  return null;
}

export function isReverseConfigured(settings: {
  promptReverse: ReverseUpstreamSettings;
  promptOptimizer: ReverseUpstreamSettings;
}): boolean {
  return resolveReverseUpstream(settings) !== null;
}

interface ReverseOptions {
  settings: { promptReverse: ReverseUpstreamSettings; promptOptimizer: ReverseUpstreamSettings };
  image: string;
  style: ReverseStyle;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  attempts?: number;
}

export async function reverseImagePrompt(options: ReverseOptions): Promise<string> {
  const { settings, style } = options;
  const config = resolveReverseUpstream(settings);
  if (!config) throw httpError(400, "图片反推未配置：请在管理后台 → 设置中填写 AI 接口地址与模型（需支持视觉）");
  const imageDataUrl = await prepareImageDataUrl(decodeReverseImage(options.image));

  const payload = {
    model: config.model,
    messages: [
      { role: "system", content: REVERSE_INSTRUCTIONS[style] },
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: imageDataUrl } },
          { type: "text", text: "Generate the prompt for this image." },
        ],
      },
    ],
    temperature: 0.7,
  };

  const doFetch = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const attempts = options.attempts ?? ATTEMPTS;

  let lastError: unknown = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const res = await doFetch(joinUrl(config.baseUrl, "/chat/completions"), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const text = await res.text();
      let body: unknown = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = null;
      }
      if (res.ok) return extractOptimizedContent(body);
      // 429 与 5xx 视为可重试；其他 4xx（如 key 无效）直接失败
      if (res.status === 429 || res.status >= 500) {
        lastError = mapUpstreamFailure(res.status, body, "图片反推");
        if (attempt < attempts - 1) {
          await sleep(retryDelayMs(res, attempt));
          continue;
        }
        throw lastError;
      }
      throw mapUpstreamFailure(res.status, body, "图片反推");
    } catch (err) {
      if (err instanceof UpstreamError) throw err;
      // 网络/超时错误：同样按可重试处理
      lastError = wrapNetworkError(err, "图片反推");
      if (attempt < attempts - 1) {
        await sleep(retryDelayMs(null, attempt));
        continue;
      }
      throw lastError;
    }
  }
  throw lastError ?? new UpstreamError(502, "upstream_error", "图片反推失败");
}
