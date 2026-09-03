export const TOKEN_KEY = "tiny-admin-token";
export const ROLE_KEY = "tiny-role";

export const getToken = (): string => localStorage.getItem(TOKEN_KEY) ?? "";
export const setToken = (t: string): void => localStorage.setItem(TOKEN_KEY, t);
export const clearToken = (): void => localStorage.removeItem(TOKEN_KEY);

export function getRole(): "admin" | "user" | null {
  const v = localStorage.getItem(ROLE_KEY);
  return v === "admin" || v === "user" ? v : null;
}

export function setRole(role: "admin" | "user" | null): void {
  if (role) localStorage.setItem(ROLE_KEY, role);
  else localStorage.removeItem(ROLE_KEY);
}

export async function loginRequest(email: string, password: string, turnstileToken?: string): Promise<{ token: string; role: "admin" | "user"; email: string }> {
  const res = await fetch("/admin/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password, ...(turnstileToken ? { turnstileToken } : {}) }),
  });
  const parsed = (await res.json().catch(() => ({}))) as { token?: string; role?: "admin" | "user"; email?: string; error?: { message?: string } };
  if (!res.ok || !parsed.token) throw new ApiError(res.status, parsed as { error?: { message?: string } });
  return { token: parsed.token, role: parsed.role!, email: parsed.email! };
}

// 注册入口开关（管理员在设置页控制）；未开启时登录页不展示注册入口
export async function fetchRegistrationEnabled(): Promise<boolean> {
  const res = await fetch("/admin/auth/register");
  const parsed = (await res.json().catch(() => ({}))) as { enabled?: boolean };
  return !!parsed.enabled;
}

// Turnstile 人机验证配置（环境变量开启）；登录/注册页据此渲染验证组件
export async function fetchTurnstileConfig(): Promise<{ enabled: boolean; siteKey: string | null }> {
  const res = await fetch("/admin/auth/turnstile");
  const parsed = (await res.json().catch(() => ({}))) as { enabled?: boolean; siteKey?: string | null };
  return { enabled: !!parsed.enabled, siteKey: parsed.siteKey ?? null };
}

// 用户自助注册：成功即视为已登录（服务端直接返回 token）
export async function registerRequest(email: string, password: string, turnstileToken?: string): Promise<{ token: string; role: "admin" | "user"; email: string }> {
  const res = await fetch("/admin/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password, ...(turnstileToken ? { turnstileToken } : {}) }),
  });
  const parsed = (await res.json().catch(() => ({}))) as { token?: string; role?: "admin" | "user"; email?: string; error?: { message?: string } };
  if (!res.ok || !parsed.token) throw new ApiError(res.status, parsed as { error?: { message?: string } });
  return { token: parsed.token, role: parsed.role!, email: parsed.email! };
}

export interface Me {
  role: "admin" | "user";
  email: string;
  quotaTotal: number | null;
  quotaUsed: number;
  quotaRemaining: number | null;
}

export function fetchMe(): Promise<Me> {
  return api<Me>("/admin/auth/me");
}

// 生成完成等时机通知顶栏刷新额度
export const QUOTA_EVENT = "tiny-quota-changed";
export function notifyQuotaChanged(): void {
  window.dispatchEvent(new Event(QUOTA_EVENT));
}

export async function fetchSetupNeeded(): Promise<boolean> {
  const res = await fetch("/admin/auth/setup");
  const parsed = (await res.json().catch(() => ({}))) as { needed?: boolean };
  return !!parsed.needed;
}

// 首次设置 admin：成功即视为已登录（服务端直接返回 token）
export async function setupAdmin(email: string, password: string): Promise<{ token: string; role: "admin" | "user"; email: string }> {
  const res = await fetch("/admin/auth/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const parsed = (await res.json().catch(() => ({}))) as { token?: string; role?: "admin" | "user"; email?: string; error?: { message?: string } };
  if (!res.ok || !parsed.token) throw new ApiError(res.status, parsed as { error?: { message?: string } });
  return { token: parsed.token, role: parsed.role!, email: parsed.email! };
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: { error?: { message?: string } },
  ) {
    super(body?.error?.message ?? `HTTP ${status}`);
  }
}

export async function api<T>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: opts.method ?? "GET",
    // 无 body 的请求不能带 content-type: application/json，否则 Fastify 会报
    // "Body cannot be empty when content-type is set"
    headers: {
      ...(opts.body === undefined ? {} : { "content-type": "application/json" }),
      authorization: `Bearer ${getToken()}`,
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const parsed = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
  if (!res.ok) {
    // 令牌失效时统一送回登录页（登录页自身的 401 表示令牌错误，交给页面展示）
    if (res.status === 401 && window.location.pathname !== "/login") {
      clearToken();
      window.location.assign("/login");
    }
    throw new ApiError(res.status, parsed);
  }
  if (res.status === 204) return undefined as T;
  return parsed as T;
}

// ---- 服务端数据形状 ----

export interface Channel {
  id: number;
  name: string;
  type: "openai-compat" | "ai-horde";
  baseUrl: string;
  timeoutMs: number;
  concurrency: number;
  generationMode: "images" | "chat";
  editMode: "auto" | "multipart" | "json-base64";
  extraHeaders: Record<string, string>;
  enabled: boolean;
  createdAt: number;
  keys?: ChannelKey[];
}

export interface ChannelKey {
  id: number;
  channelId: number;
  apiKey: string;
  enabled: boolean;
  cooldownUntil: number;
}

export interface ChannelHealth {
  channelId: number;
  name: string;
  type: Channel["type"];
  enabled: boolean;
  status: "disabled" | "no-key" | "circuit-open" | "unknown" | "error" | "healthy";
  keys: { total: number; enabled: number; available: number; coolingDown: number };
  models: { total: number; coolingDown: number };
  requests: {
    sampleSize: number;
    successful: number;
    failed: number;
    successRate: number | null;
    averageLatencyMs: number | null;
    lastRequestAt: number | null;
    lastError: string | null;
  };
}

export const fetchChannelHealth = (): Promise<ChannelHealth[]> => api<ChannelHealth[]>("/admin/channel-health");

export type ModelHealthStatus = "healthy" | "degraded" | "unavailable" | "unknown";

export interface ModelHealthSample {
  ts: number;
  status: "ok" | "error";
  latencyMs: number | null;
}

export interface ModelHealth {
  model: string;
  status: ModelHealthStatus;
  supportsImageToImage: boolean;
  routes: {
    total: number;
    available: number;
  };
  requests: {
    sampleSize: number;
    successful: number;
    failed: number;
    successRate: number | null;
    averageLatencyMs: number | null;
    lastRequestAt: number | null;
  };
  recent: ModelHealthSample[];
}

export interface ModelHealthResponse {
  generatedAt: number;
  sampleLimit: number;
  models: ModelHealth[];
}

export const fetchModelHealth = (): Promise<ModelHealthResponse> => api<ModelHealthResponse>("/v1/model-health");

export interface ModelMapping {
  id: number;
  publicName: string;
  channelId: number;
  upstreamName: string;
  enabled: boolean;
  priority: number;
  supportsImageToImage: boolean;
  supportsNsfw: boolean;
  createdAt: number;
  channelName?: string | null;
}


export interface ApiKey {
  id: number;
  name: string;
  key: string;
  enabled: boolean;
  userId: number | null;
  userEmail?: string | null;
  createdAt: number;
}

export interface ChannelGroup {
  id: number;
  name: string;
  createdAt: number;
  channelIds: number[];
}

export interface UserView {
  id: number;
  email: string;
  role: "admin" | "user";
  enabled: boolean;
  createdAt: number;
  quotaTotal: number | null;
  quotaUsed: number;
  quotaRemaining: number | null;
  groupIds: number[];
  allowNsfw: boolean;
}

export interface LogRow {
  id: number;
  ts: number;
  model: string;
  channelId: number | null;
  apiKeyId: number | null;
  status: "ok" | "error";
  httpStatus: number | null;
  latencyMs: number | null;
  errorMessage: string | null;
}

export interface PromptOptimizerSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export type PromptReverseSettings = PromptOptimizerSettings;

export interface RegistrationSettings {
  enabled: boolean;
  dailyQuota: number;
}

// 下载水印：样式由管理员集中配置，署名文字按用户各自保存
export type WatermarkPosition = "tl" | "tc" | "tr" | "bl" | "bc" | "br";

export interface WatermarkStyle {
  position: WatermarkPosition;
  fontSize: number;
  opacity: number;
  color: string;
  prefix: string;
}

export const DEFAULT_WATERMARK_STYLE: WatermarkStyle = {
  position: "br",
  fontSize: 20,
  opacity: 0.6,
  color: "#ffffff",
  prefix: "",
};

// 用户自定义的水印样式（不含固定前缀）：未覆盖的字段回落到管理员的集中配置
export interface UserWatermarkStyle {
  position: WatermarkPosition;
  fontSize: number;
  opacity: number;
  color: string;
}

// styleDefaults 为管理员的集中配置（未自定义字段的默认值）；style 为 null 表示完全跟随默认
export interface WatermarkConfig {
  enabled: boolean;
  text: string;
  style: UserWatermarkStyle | null;
  styleDefaults: WatermarkStyle;
}

export interface AppSettings {
  globalPrompt: string;
  announcement: string;
  announcementVersion: number;
  promptOptimizer: PromptOptimizerSettings;
  promptReverse: PromptReverseSettings;
  registration: RegistrationSettings;
  watermarkStyle: WatermarkStyle;
}

export const fetchSettings = (): Promise<AppSettings> => api<AppSettings>("/admin/settings");

export const saveSettings = (
  input: Pick<AppSettings, "globalPrompt" | "announcement"> & {
    promptOptimizer?: PromptOptimizerSettings;
    promptReverse?: PromptReverseSettings;
    registration?: RegistrationSettings;
    watermarkStyle?: WatermarkStyle;
  },
): Promise<AppSettings> => api<AppSettings>("/admin/settings", { method: "PUT", body: input });

export interface Announcement {
  announcement: string;
  version: number;
}

export const fetchAnnouncement = (): Promise<Announcement> => api<Announcement>("/v1/announcement");

export interface Features {
  upscale: boolean;
  promptOptimizer: boolean;
  promptReverse: boolean;
}

export const fetchFeatures = (): Promise<Features> => api<Features>("/v1/features");

// 调用服务端用配置好的 AI 优化提示词，返回优化后的文本
export const optimizePrompt = (prompt: string): Promise<{ prompt: string }> =>
  api<{ prompt: string }>("/v1/prompt/optimize", { method: "POST", body: { prompt } });

// AI 翻译提示词：缺省 target 由服务端按语言自动判断
export const translatePrompt = (prompt: string, target?: "en" | "zh"): Promise<{ prompt: string; target: "en" | "zh" }> =>
  api<{ prompt: string; target: "en" | "zh" }>("/v1/prompt/translate", { method: "POST", body: { prompt, ...(target ? { target } : {}) } });

// ---- 提示词收藏夹 ----

export interface PromptFavorite {
  id: number;
  content: string;
  createdAt: number;
}

export const fetchFavorites = (): Promise<PromptFavorite[]> => api<PromptFavorite[]>("/v1/prompt-favorites");

export const addFavorite = (prompt: string): Promise<PromptFavorite> =>
  api<PromptFavorite>("/v1/prompt-favorites", { method: "POST", body: { prompt } });

export const deleteFavorite = (id: number): Promise<void> => api<void>(`/v1/prompt-favorites/${id}`, { method: "DELETE" });

// 图片反推：image 为 data URL（本地文件或历史图片转 base64），返回反推出的提示词
export type ReverseStyle = "concise" | "detailed" | "cinematic";

export const reverseImagePrompt = (image: string, style: ReverseStyle): Promise<{ prompt: string }> =>
  api<{ prompt: string }>("/v1/prompt/reverse", { method: "POST", body: { image, style } });

// ---- 生成 job ----

export interface JobImage {
  file: string;
  url: string;
  width?: number;
  height?: number;
  revisedPrompt?: string;
}

export type JobKind = "generate" | "edit" | "upscale";

export interface JobStatus {
  kind?: JobKind;
  status: "running" | "ok" | "error";
  progress: string | null;
  channel: string | null;
  latencyMs: number | null;
  error: string | null;
  createdAt: number;
  generationId?: number;
  images: JobImage[];
}

export function createJob(body: Record<string, unknown>): Promise<{ jobId: string }> {
  return api<{ jobId: string }>("/v1/images/jobs", { method: "POST", body });
}

async function createMultipartJob(path: string, form: FormData): Promise<{ jobId: string }> {
  const res = await fetch(path, {
    method: "POST",
    headers: { authorization: `Bearer ${getToken()}` },
    body: form,
  });
  const parsed = (await res.json().catch(() => ({}))) as { jobId?: string; error?: { message?: string } };
  if (res.status === 401 && window.location.pathname !== "/login") {
    clearToken();
    window.location.assign("/login");
  }
  if (!res.ok || !parsed.jobId) throw new ApiError(res.status, parsed);
  return { jobId: parsed.jobId };
}

export function createEditJob(form: FormData): Promise<{ jobId: string }> {
  return createMultipartJob("/v1/images/edit-jobs", form);
}

export function createUpscaleJob(form: FormData): Promise<{ jobId: string }> {
  return createMultipartJob("/v1/images/upscale-jobs", form);
}

export function fetchJob(id: string): Promise<JobStatus> {
  return api<JobStatus>(`/v1/images/jobs/${id}`);
}

// 删除一条生成历史（服务端会连带删除其图片文件）
export const deleteHistoryItem = (id: number): Promise<void> => api<void>(`/v1/history/${id}`, { method: "DELETE" });

// ---- 广场分享 ----

export interface PlazaItem {
  id: number;
  createdAt: number;
  userId: number;
  author: string | null;
  model: string | null;
  prompt: string;
  revisedPrompt?: string;
  width: number | null;
  height: number | null;
  url: string;
  mine: boolean;
  canDelete: boolean;
}

export interface PlazaResponse {
  items: PlazaItem[];
}

// 分享一条生成记录中的某张图到广场；同一张图重复分享幂等返回已有记录
export const shareToPlaza = (generationId: number, imageIndex = 0): Promise<PlazaItem> =>
  api<PlazaItem>("/v1/plaza", { method: "POST", body: { generationId, imageIndex } });

export const fetchPlaza = (opts: { before?: number; mine?: boolean } = {}): Promise<PlazaResponse> => {
  const q = new URLSearchParams();
  if (opts.before) q.set("before", String(opts.before));
  if (opts.mine) q.set("mine", "1");
  const qs = q.toString();
  return api<PlazaResponse>(`/v1/plaza${qs ? `?${qs}` : ""}`);
};

// 取消分享（仅本人或管理员；服务端会连带删除广场图片文件）
export const deletePlazaShare = (id: number): Promise<void> => api<void>(`/v1/plaza/${id}`, { method: "DELETE" });

// ---- 下载水印 ----

export const fetchMyWatermark = (): Promise<WatermarkConfig> => api<WatermarkConfig>("/v1/watermark");

export const saveMyWatermark = (config: { enabled: boolean; text: string; style?: UserWatermarkStyle | null }): Promise<WatermarkConfig> =>
  api<WatermarkConfig>("/v1/watermark", { method: "PUT", body: config });

// /files/ 结果走鉴权下载端点（按用户水印配置按需合成）；其余 URL 保持浏览器直下行为
const DOWNLOAD_NAME_RE = /^\/files\/([0-9a-f]{32}\.(?:png|jpe?g|webp))$/;

export async function downloadImage(url: string, filename: string): Promise<void> {
  const anchor = document.createElement("a");
  const match = DOWNLOAD_NAME_RE.exec(url);
  if (!match) {
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    return;
  }
  const res = await fetch(`/v1/download/${match[1]}`, { headers: { authorization: `Bearer ${getToken()}` } });
  if (res.status === 401 && window.location.pathname !== "/login") {
    clearToken();
    window.location.assign("/login");
  }
  if (!res.ok) {
    const parsed = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new ApiError(res.status, parsed);
  }
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  anchor.href = objectUrl;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(objectUrl);
}
