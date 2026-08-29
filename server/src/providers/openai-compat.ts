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

function toBlobPart(data: Buffer): Uint8Array {
  const bytes = new Uint8Array(data.byteLength);
  bytes.set(data);
  return bytes;
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

  async edit(req: UnifiedEditRequest, ctx: CallContext): Promise<UnifiedImageResult> {
    if (ctx.channel.editMode === "json-base64") return this.editJsonBase64(req, ctx);
    try {
      return await this.editMultipart(req, ctx);
    } catch (err) {
      if (ctx.channel.editMode === "multipart") throw err;
      // auto：部分中转站只接受 JSON，遇到 404/415 回退 base64 JSON
      if (err instanceof UpstreamError && (err.httpStatus === 404 || err.httpStatus === 415)) {
        return this.editJsonBase64(req, ctx);
      }
      throw err;
    }
  }

  private async editMultipart(req: UnifiedEditRequest, ctx: CallContext): Promise<UnifiedImageResult> {
    const form = new FormData();
    form.append("model", ctx.upstreamModel);
    form.append("prompt", req.prompt);
    form.append("n", String(req.n));
    if (req.size !== undefined) form.append("size", req.size);
    for (const [k, v] of Object.entries(req.passthrough)) {
      if (typeof v === "string" || typeof v === "number") form.append(k, String(v));
    }
    for (const img of req.images) {
      form.append("image", new Blob([toBlobPart(img.data)], { type: img.mimeType }), img.filename || "image.png");
    }
    if (req.mask) {
      form.append("mask", new Blob([toBlobPart(req.mask.data)], { type: req.mask.mimeType }), req.mask.filename || "mask.png");
    }
    const timeout = AbortSignal.timeout(ctx.channel.timeoutMs);
    const signal = AbortSignal.any([ctx.signal, timeout]);
    let res: Response;
    try {
      res = await fetch(joinUrl(ctx.channel.baseUrl, "/images/edits"), {
        method: "POST",
        headers: {
          authorization: `Bearer ${ctx.apiKey}`,
          ...ctx.channel.extraHeaders,
        },
        body: form,
        signal,
      });
    } catch (err) {
      throw wrapNetworkError(err, ctx.channel.name);
    }
    const json = await readJsonResponse(res, ctx.channel.name);
    return parseImagesResponse(json, ctx.channel.name);
  }

  private async editJsonBase64(req: UnifiedEditRequest, ctx: CallContext): Promise<UnifiedImageResult> {
    const payload: Record<string, unknown> = {
      model: ctx.upstreamModel,
      prompt: req.prompt,
      n: req.n,
      ...req.passthrough,
    };
    if (req.size !== undefined) payload.size = req.size;
    const toDataUrl = (img: { data: Buffer; mimeType: string }) =>
      `data:${img.mimeType || "image/png"};base64,${img.data.toString("base64")}`;
    payload.image = req.images.length === 1 ? toDataUrl(req.images[0]) : req.images.map(toDataUrl);
    if (req.mask) payload.mask = toDataUrl(req.mask);
    const json = await this.postJson(ctx, "/images/edits", payload);
    return parseImagesResponse(json, ctx.channel.name);
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
