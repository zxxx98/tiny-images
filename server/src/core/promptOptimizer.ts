import { joinUrl } from "../providers/openai-compat.js";
import { httpError, mapUpstreamFailure, UpstreamError, wrapNetworkError } from "./errors.js";
import type { PromptOptimizerSettings } from "../store/repo.js";

// 优化提示词的系统指令：改写为更适合生图模型的版本，只输出提示词本身。
export const OPTIMIZE_SYSTEM_PROMPT = [
  "你是一位顶级的文生图（text-to-image）提示词工程师。",
  "请把用户给出的提示词改写为更适合 AI 绘图模型的版本：",
  "- 保留用户的核心意图，不发明与之冲突的内容；",
  "- 适度补全主体细节、场景、构图、光线、色调与画质等描述；",
  "- 使用与用户相同的语言（中文保持中文，英文保持英文）；",
  "- 只输出优化后的提示词本身，不要任何解释、引号或前后缀。",
].join("\n");

export const PROMPT_MAX_LENGTH = 4000;

const ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 400;
const REQUEST_TIMEOUT_MS = 60_000;
const RETRY_AFTER_MAX_MS = 5_000;

export function assertValidOptimizePrompt(prompt: string): string {
  const trimmed = prompt.trim();
  if (!trimmed) throw httpError(400, "'prompt' is required");
  if (trimmed.length > PROMPT_MAX_LENGTH) throw httpError(400, `'prompt' must be at most ${PROMPT_MAX_LENGTH} characters`);
  return trimmed;
}

interface OptimizeOptions {
  config: PromptOptimizerSettings;
  prompt: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  attempts?: number;
}

export type PromptTranslateTarget = "en" | "zh";

// 含 CJK 字符（中日韩）视为需要译成英文，否则译成中文
export function detectPromptTarget(prompt: string): PromptTranslateTarget {
  return /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/.test(prompt) ? "en" : "zh";
}

function translateSystemPrompt(target: PromptTranslateTarget): string {
  if (target === "en") {
    return [
      "你是一位专业的生图提示词翻译助手。",
      "请把用户给出的提示词准确翻译成适合 AI 绘图模型的英文描述：",
      "- 保留核心意图与细节，不增删内容；",
      "- 通用名词翻译为常见英文生图词汇；专有名词可保留原文；",
      "- 只输出译文本身，不要任何解释、引号或前后缀。",
    ].join("\n");
  }
  return [
    "你是一位专业的生图提示词翻译助手。",
    "请把用户给出的提示词准确翻译成简体中文：",
    "- 保留核心意图与细节，不增删内容；",
    "- 专有名词可保留原文；",
    "- 只输出译文本身，不要任何解释、引号或前后缀。",
  ].join("\n");
}

function retryDelayMs(response: Response | null, attempt: number): number {
  const retryAfter = response?.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, RETRY_AFTER_MAX_MS);
    const at = Date.parse(retryAfter);
    if (!Number.isNaN(at)) return Math.min(Math.max(at - Date.now(), 0), RETRY_AFTER_MAX_MS);
  }
  return RETRY_BASE_DELAY_MS * 2 ** attempt;
}

// 从 chat 响应中取出提示词文本，并剥掉模型偶尔包上的代码块围栏和引号。
export function extractOptimizedContent(body: unknown): string {
  const content = (body as { choices?: { message?: { content?: unknown } }[] } | null)?.choices?.[0]?.message?.content;
  let text = typeof content === "string" ? content : "";
  text = text.trim();
  const fence = text.match(/^```[a-zA-Z]*\n([\s\S]*?)\n?```$/);
  if (fence) text = fence[1].trim();
  if ((text.startsWith('"') && text.endsWith('"') && text.length >= 2) || (text.startsWith("「") && text.endsWith("」") && text.length >= 2)) {
    text = text.slice(1, -1).trim();
  }
  if (!text) throw new UpstreamError(502, "upstream_error", "提示词优化上游没有返回内容");
  return text;
}

interface ChatCallOptions {
  config: PromptOptimizerSettings;
  system: string;
  user: string;
  label: string;
  temperature: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  attempts?: number;
}

// 优化与翻译共用的一条 chat 调用：429/5xx/网络错误按退避重试，返回纯文本内容
async function callChatCompletion(options: ChatCallOptions): Promise<string> {
  const { config, label } = options;
  const doFetch = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const attempts = options.attempts ?? ATTEMPTS;
  if (!config.baseUrl || !config.model) throw httpError(400, `提示词${label}未配置：请在管理后台 → 设置中填写 AI 接口地址与模型`);

  const payload = {
    model: config.model,
    messages: [
      { role: "system", content: options.system },
      { role: "user", content: options.user },
    ],
    temperature: options.temperature,
  };

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
        lastError = mapUpstreamFailure(res.status, body, label);
        if (attempt < attempts - 1) {
          await sleep(retryDelayMs(res, attempt));
          continue;
        }
        throw lastError;
      }
      throw mapUpstreamFailure(res.status, body, label);
    } catch (err) {
      if (err instanceof UpstreamError) throw err;
      // 网络/超时错误：同样按可重试处理
      lastError = wrapNetworkError(err, label);
      if (attempt < attempts - 1) {
        await sleep(retryDelayMs(null, attempt));
        continue;
      }
      throw lastError;
    }
  }
  throw lastError ?? new UpstreamError(502, "upstream_error", `提示词${label}失败`);
}

export async function optimizePrompt(options: OptimizeOptions): Promise<string> {
  return callChatCompletion({
    config: options.config,
    system: OPTIMIZE_SYSTEM_PROMPT,
    user: options.prompt,
    label: "优化",
    temperature: 0.7,
    fetchImpl: options.fetchImpl,
    sleep: options.sleep,
    attempts: options.attempts,
  });
}

export interface TranslateOptions {
  config: PromptOptimizerSettings;
  prompt: string;
  /** 缺省时按提示词语言自动判断方向 */
  target?: PromptTranslateTarget;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  attempts?: number;
}

export async function translatePrompt(options: TranslateOptions): Promise<{ prompt: string; target: PromptTranslateTarget }> {
  const target = options.target ?? detectPromptTarget(options.prompt);
  const prompt = await callChatCompletion({
    config: options.config,
    system: translateSystemPrompt(target),
    user: options.prompt,
    label: "翻译",
    temperature: 0.2,
    fetchImpl: options.fetchImpl,
    sleep: options.sleep,
    attempts: options.attempts,
  });
  return { prompt, target };
}
