export const TOKEN_KEY = "tiny-admin-token";

export const getToken = (): string => localStorage.getItem(TOKEN_KEY) ?? "";
export const setToken = (t: string): void => localStorage.setItem(TOKEN_KEY, t);
export const clearToken = (): void => localStorage.removeItem(TOKEN_KEY);

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
  type: string;
  baseUrl: string;
  timeoutMs: number;
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

export interface ModelMapping {
  id: number;
  publicName: string;
  channelId: number;
  upstreamName: string;
  enabled: boolean;
  createdAt: number;
  channelName?: string | null;
}

export interface ApiKey {
  id: number;
  name: string;
  key: string;
  enabled: boolean;
  createdAt: number;
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

// ---- 生成 job ----

export interface JobImage {
  file: string;
  url: string;
  revisedPrompt?: string;
}

export interface JobStatus {
  status: "running" | "ok" | "error";
  progress: string | null;
  channel: string | null;
  latencyMs: number | null;
  error: string | null;
  createdAt: number;
  images: JobImage[];
}

export function createJob(body: Record<string, unknown>): Promise<{ jobId: string }> {
  return api<{ jobId: string }>("/v1/images/jobs", { method: "POST", body });
}

export function fetchJob(id: string): Promise<JobStatus> {
  return api<JobStatus>(`/v1/images/jobs/${id}`);
}
