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
    headers: { "content-type": "application/json", authorization: `Bearer ${getToken()}` },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => ({})));
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
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
