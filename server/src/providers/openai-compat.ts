import { mapUpstreamFailure, UpstreamError, wrapNetworkError } from "../core/errors.js";
import type {
  CallContext,
  ChannelConfig,
  ImageProvider,
  UnifiedEditRequest,
  UnifiedGenRequest,
  UnifiedImageResult,
} from "../core/types.js";

export function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

export class OpenAICompatProvider implements ImageProvider {
  readonly kind = "openai-compat";

  async generate(req: UnifiedGenRequest, ctx: CallContext): Promise<UnifiedImageResult> {
    // response_format 不透传：由网关本地做 b64↔url 转换，规避 gpt-image-1 等不接受该参数的上游。
    const payload: Record<string, unknown> = {
      model: ctx.upstreamModel,
      prompt: req.prompt,
      n: req.n,
      ...req.passthrough,
    };
    if (req.size !== undefined) payload.size = req.size;
    if (req.quality !== undefined) payload.quality = req.quality;
    const json = await this.postJson(ctx, "/images/generations", payload);
    return parseImagesResponse(json, ctx.channel.name);
  }

  async edit(_req: UnifiedEditRequest, _ctx: CallContext): Promise<UnifiedImageResult> {
    throw new Error("edit not implemented");
  }

  async test(channel: ChannelConfig, apiKey: string | null): Promise<{ ok: boolean; message: string }> {
    const timeout = AbortSignal.timeout(Math.min(channel.timeoutMs, 15_000));
    try {
      const headers: Record<string, string> = { ...channel.extraHeaders };
      if (apiKey) headers.authorization = `Bearer ${apiKey}`;
      const res = await fetch(joinUrl(channel.baseUrl, "/models"), { headers, signal: timeout });
      if (res.ok) return { ok: true, message: `HTTP ${res.status}` };
      const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      return { ok: false, message: body?.error?.message ?? `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  private async postJson(ctx: CallContext, path: string, payload: unknown): Promise<unknown> {
    const timeout = AbortSignal.timeout(ctx.channel.timeoutMs);
    const signal = AbortSignal.any([ctx.signal, timeout]);
    let res: Response;
    try {
      res = await fetch(joinUrl(ctx.channel.baseUrl, path), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${ctx.apiKey}`,
          ...ctx.channel.extraHeaders,
        },
        body: JSON.stringify(payload),
        signal,
      });
    } catch (err) {
      throw wrapNetworkError(err, ctx.channel.name);
    }
    return readJsonResponse(res, ctx.channel.name);
  }
}

export async function readJsonResponse(res: Response, channelName: string): Promise<unknown> {
  const text = await res.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  if (!res.ok) throw mapUpstreamFailure(res.status, json, channelName);
  return json;
}

export function parseImagesResponse(json: unknown, channelName: string): UnifiedImageResult {
  const obj = json as { created?: unknown; data?: unknown } | null;
  if (!obj || !Array.isArray(obj.data)) {
    throw new UpstreamError(502, "upstream_error", `channel '${channelName}' returned malformed response: missing data array`);
  }
  const images = (obj.data as Record<string, unknown>[]).map((item) => ({
    ...(typeof item.b64_json === "string" ? { b64: item.b64_json } : {}),
    ...(typeof item.url === "string" ? { url: item.url } : {}),
    ...(typeof item.revised_prompt === "string" ? { revisedPrompt: item.revised_prompt } : {}),
  }));
  const created = typeof obj.created === "number" ? obj.created : Math.floor(Date.now() / 1000);
  return { created, images, raw: json };
}
