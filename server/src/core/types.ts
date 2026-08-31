export type EditMode = "auto" | "multipart" | "json-base64";
export type ChannelType = "openai-compat" | "ai-horde";

export interface ChannelConfig {
  id: number;
  name: string;
  type: ChannelType;
  baseUrl: string;
  timeoutMs: number;
  editMode: EditMode;
  extraHeaders: Record<string, string>;
  enabled: boolean;
}

export interface ModelMapping {
  id: number;
  publicName: string;
  channelId: number;
  upstreamName: string;
  enabled: boolean;
}

export interface UnifiedGenRequest {
  prompt: string;
  n: number;
  size?: string;
  quality?: string;
  /** "auto" = 客户端未指定，保持上游返回的原生格式 */
  responseFormat: "url" | "b64_json" | "auto";
  passthrough: Record<string, unknown>;
}

export interface IncomingImage {
  filename: string;
  data: Buffer;
  mimeType: string;
}

export interface UnifiedEditRequest {
  prompt: string;
  n: number;
  size?: string;
  /** "auto" = 客户端未指定，保持上游返回的原生格式 */
  responseFormat: "url" | "b64_json" | "auto";
  images: IncomingImage[];
  mask?: IncomingImage;
  passthrough: Record<string, unknown>;
}

export interface UnifiedImage {
  b64?: string;
  url?: string;
  revisedPrompt?: string;
}

export interface UnifiedImageResult {
  created: number;
  images: UnifiedImage[];
  raw?: unknown;
}

export interface CallContext {
  channel: ChannelConfig;
  upstreamModel: string;
  apiKey: string;
  signal: AbortSignal;
}

export interface ImageProvider {
  kind: string;
  generate(req: UnifiedGenRequest, ctx: CallContext): Promise<UnifiedImageResult>;
  edit(req: UnifiedEditRequest, ctx: CallContext): Promise<UnifiedImageResult>;
  test(channel: ChannelConfig, apiKey: string | null): Promise<{ ok: boolean; message: string }>;
}
