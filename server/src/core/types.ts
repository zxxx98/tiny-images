export type EditMode = "auto" | "multipart" | "json-base64";
export type ChannelType = "openai-compat" | "ai-horde";
export type GenerationMode = "images" | "chat";

export interface ChannelConfig {
  id: number;
  name: string;
  type: ChannelType;
  baseUrl: string;
  timeoutMs: number;
  concurrency: number;
  generationMode: GenerationMode;
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
  supportsImageToImage: boolean;
  supportsNsfw: boolean;
}

export interface ModelAccessPolicy {
  allowedChannelIds: number[] | null;
  allowNsfw: boolean;
}

export interface AIHordeOptions {
  nsfw?: boolean;
  censor_nsfw?: boolean;
  allow_downgrade?: boolean;
  shared?: boolean;
  trusted_workers?: boolean;
  slow_workers?: boolean;
  extra_slow_workers?: boolean;
  disable_batching?: boolean;
  replacement_filter?: boolean;
  dry_run?: boolean;
  proxied_account?: string;
  params?: Record<string, unknown>;
}

export interface ProviderOptions {
  horde?: AIHordeOptions;
}

export interface UnifiedGenRequest {
  prompt: string;
  n: number;
  size?: string;
  quality?: string;
  /** "auto" = 客户端未指定，保持上游返回的原生格式 */
  responseFormat: "url" | "b64_json" | "auto";
  passthrough: Record<string, unknown>;
  providerOptions?: ProviderOptions;
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
  providerOptions?: ProviderOptions;
}

// OpenAI images variations：只有一张源图，没有 prompt
export interface UnifiedVariationRequest {
  n: number;
  size?: string;
  /** "auto" = 客户端未指定，保持上游返回的原生格式 */
  responseFormat: "url" | "b64_json" | "auto";
  images: IncomingImage[];
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
  includeRawResponseFields?: boolean;
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
  /** images variations：不支持该能力的 provider 可不实现（executor 会返回 400） */
  variation?(req: UnifiedVariationRequest, ctx: CallContext): Promise<UnifiedImageResult>;
  test(channel: ChannelConfig, apiKey: string | null): Promise<{ ok: boolean; message: string }>;
}
