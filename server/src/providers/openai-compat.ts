import { mapUpstreamFailure, UpstreamError, wrapNetworkError } from "../core/errors.js";
import type {
  CallContext,
  ChannelConfig,
  ImageProvider,
  UnifiedEditRequest,
  UnifiedGenRequest,
  UnifiedImageResult,
  UnifiedVariationRequest,
} from "../core/types.js";

export function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function toBlob(data: Buffer, mimeType: string): Blob {
  // Buffer/Uint8Array 运行时可被 Blob 接受，但 @types/node 的 BlobPart 类型不含 ArrayBufferLike 视图
  const bytes = new Uint8Array(data.byteLength);
  bytes.set(data);
  return new Blob([bytes as unknown as BlobPart], { type: mimeType });
}

export class OpenAICompatProvider implements ImageProvider {
  readonly kind = "openai-compat";

  async generate(req: UnifiedGenRequest, ctx: CallContext): Promise<UnifiedImageResult> {
    if (ctx.channel.generationMode === "chat") return this.generateChat(req, ctx);
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

  private async generateChat(req: UnifiedGenRequest, ctx: CallContext): Promise<UnifiedImageResult> {
    const payload: Record<string, unknown> = {
      modalities: ["text", "image"],
      n: req.n,
      ...req.passthrough,
    };
    if (req.size !== undefined) payload.size = req.size;
    if (req.quality !== undefined) payload.quality = req.quality;
    payload.model = ctx.upstreamModel;
    payload.messages = [{ role: "user", content: req.prompt }];
    delete payload.response_format;
    delete payload.stream;
    const json = await this.postJson(ctx, "/chat/completions", payload);
    return parseChatImagesResponse(json, ctx.channel.name);
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
      form.append("image", toBlob(img.data, img.mimeType), img.filename || "image.png");
    }
    if (req.mask) {
      form.append("mask", toBlob(req.mask.data, req.mask.mimeType), req.mask.filename || "mask.png");
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

  // 仅 images 模式的渠道支持 /images/variations；chat 模式没有对应语义，快速失败
  async variation(req: UnifiedVariationRequest, ctx: CallContext): Promise<UnifiedImageResult> {
    if (ctx.channel.generationMode === "chat") {
      throw new UpstreamError(400, "invalid_request_error", `channel '${ctx.channel.name}' uses the Chat API and does not support image variations`);
    }
    const form = new FormData();
    form.append("model", ctx.upstreamModel);
    form.append("n", String(req.n));
    if (req.size !== undefined) form.append("size", req.size);
    for (const [k, v] of Object.entries(req.passthrough)) {
      if (typeof v === "string" || typeof v === "number") form.append(k, String(v));
    }
    for (const img of req.images) {
      form.append("image", toBlob(img.data, img.mimeType), img.filename || "image.png");
    }
    const timeout = AbortSignal.timeout(ctx.channel.timeoutMs);
    const signal = AbortSignal.any([ctx.signal, timeout]);
    let res: Response;
    try {
      res = await fetch(joinUrl(ctx.channel.baseUrl, "/images/variations"), {
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

  async test(channel: ChannelConfig, apiKey: string | null): Promise<{ ok: boolean; message: string }> {
    const timeout = AbortSignal.timeout(Math.min(channel.timeoutMs, 15_000));
    try {
      const headers: Record<string, string> = { ...channel.extraHeaders };
      // A bodyless GET with content-type: application/json makes gateways reject
      // with "Body cannot be empty when content-type is set"; drop it.
      delete headers["content-type"];
      delete headers["Content-Type"];
      delete headers["content-length"];
      delete headers["Content-Length"];
      if (apiKey) headers.authorization = `Bearer ${apiKey}`;
      const url = joinUrl(channel.baseUrl, "/models");
      let res = await fetch(url, { headers, signal: timeout });
      if (!res.ok) {
        // Some gateways only accept POST on /models (or force JSON body parsing
        // even on GET); retry with a minimal JSON body.
        await res.body?.cancel();
        res = await fetch(url, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: "{}",
          signal: timeout,
        });
      }
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

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseImageValue(value: unknown): { key: string; image: { b64: string } | { url: string } } | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  const dataMatch = /^data:image\/[a-zA-Z0-9.+-]+;base64,([A-Za-z0-9+/]*={0,2})$/.exec(normalized);
  if (dataMatch) {
    const b64 = dataMatch[1];
    const validBase64 = b64.length > 0
      && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(b64);
    if (!validBase64) return null;
    return { key: normalized, image: { b64 } };
  }
  try {
    const url = new URL(normalized);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return { key: normalized, image: { url: normalized } };
  } catch {
    return null;
  }
}

function markdownImageValues(content: string): string[] {
  const values: string[] = [];
  let scannedThrough = 0;
  const closingParenAfterOptionalTitle = (start: number): number | null => {
    let pos = start;
    while (/\s/.test(content[pos] ?? "")) pos += 1;
    scannedThrough = Math.max(scannedThrough, pos);
    if (content[pos] === ")") return pos;
    const opener = content[pos];
    if (opener !== "\"" && opener !== "'" && opener !== "(") return null;
    const closer = opener === "(" ? ")" : opener;
    pos += 1;
    while (pos < content.length) {
      if (content[pos] === "\\") {
        pos += 2;
        scannedThrough = Math.max(scannedThrough, pos);
        continue;
      }
      if (content[pos] === closer) break;
      pos += 1;
    }
    scannedThrough = Math.max(scannedThrough, pos);
    if (content[pos] !== closer) return null;
    pos += 1;
    while (/\s/.test(content[pos] ?? "")) pos += 1;
    scannedThrough = Math.max(scannedThrough, pos);
    return content[pos] === ")" ? pos : null;
  };

  let searchFrom = 0;
  while (searchFrom < content.length) {
    const start = content.indexOf("![", searchFrom);
    if (start < 0) break;
    let labelEnd = start + 2;
    while (labelEnd < content.length && content[labelEnd] !== "]") {
      labelEnd += content[labelEnd] === "\\" ? 2 : 1;
    }
    scannedThrough = Math.max(scannedThrough, labelEnd);
    if (content[labelEnd] !== "]") break;
    if (content[labelEnd + 1] !== "(") {
      searchFrom = labelEnd + 1;
      continue;
    }

    let pos = labelEnd + 2;
    while (/\s/.test(content[pos] ?? "")) pos += 1;
    let destination = "";
    let linkEnd: number | null = null;
    if (content[pos] === "<") {
      pos += 1;
      while (pos < content.length && content[pos] !== ">" && content[pos] !== "\n" && content[pos] !== "\r") {
        if (content[pos] === "\\" && pos + 1 < content.length) pos += 1;
        destination += content[pos];
        pos += 1;
      }
      scannedThrough = Math.max(scannedThrough, pos);
      if (content[pos] === ">") linkEnd = closingParenAfterOptionalTitle(pos + 1);
    } else {
      let depth = 0;
      while (pos < content.length) {
        const char = content[pos];
        if (char === "\n" || char === "\r") break;
        if (char === "\\" && pos + 1 < content.length) {
          destination += content[pos + 1];
          pos += 2;
          continue;
        }
        if (char === "(") {
          depth += 1;
          destination += char;
          pos += 1;
          continue;
        }
        if (char === ")") {
          if (depth === 0) {
            linkEnd = pos;
            break;
          }
          depth -= 1;
          destination += char;
          pos += 1;
          continue;
        }
        if (/\s/.test(char) && depth === 0) {
          linkEnd = closingParenAfterOptionalTitle(pos);
          break;
        }
        destination += char;
        pos += 1;
      }
      scannedThrough = Math.max(scannedThrough, pos);
    }
    if (destination && linkEnd !== null) {
      values.push(destination);
      searchFrom = linkEnd + 1;
    } else {
      searchFrom = Math.max(start + 2, scannedThrough + 1);
    }
  }
  return values;
}

export function parseChatImagesResponse(json: unknown, channelName: string): UnifiedImageResult {
  const obj = record(json);
  if (!obj || !Array.isArray(obj.choices)) {
    throw new UpstreamError(502, "upstream_error", `channel '${channelName}' returned malformed chat image response`);
  }

  const images: UnifiedImageResult["images"] = [];
  const seen = new Set<string>();
  const addValue = (value: unknown) => {
    const parsed = parseImageValue(value);
    if (!parsed || seen.has(parsed.key)) return;
    seen.add(parsed.key);
    images.push(parsed.image);
  };
  const addStringContent = (content: string) => {
    for (const value of markdownImageValues(content)) addValue(value);
    addValue(content);
  };
  const collect = (value: unknown) => {
    const container = record(value);
    if (!container) return;
    if (Array.isArray(container.images)) {
      for (const image of container.images) {
        const imageUrl = record(record(image)?.image_url)?.url;
        addValue(imageUrl);
      }
    }
    if (Array.isArray(container.content)) {
      for (const item of container.content) {
        if (typeof item === "string") {
          addStringContent(item);
          continue;
        }
        const contentItem = record(item);
        if (!contentItem) continue;
        addValue(record(contentItem.image_url)?.url);
        addValue(contentItem.image_url);
        addValue(contentItem.data);
      }
    } else if (typeof container.content === "string") {
      addStringContent(container.content);
    }
  };

  for (const choice of obj.choices) {
    const choiceObj = record(choice);
    if (!choiceObj) continue;
    collect(choiceObj.message);
    collect(choiceObj.delta);
  }
  if (images.length === 0) {
    throw new UpstreamError(502, "upstream_error", `channel '${channelName}' returned no recognizable chat image`);
  }

  const created = typeof obj.created === "number" ? obj.created : Math.floor(Date.now() / 1000);
  const raw = Object.hasOwn(obj, "usage") ? { usage: obj.usage } : undefined;
  return { created, images, ...(raw ? { raw } : {}) };
}
