import { UpstreamError, ValidationError, wrapNetworkError } from "../core/errors.js";
import type {
  CallContext,
  ChannelConfig,
  ImageProvider,
  UnifiedEditRequest,
  UnifiedGenRequest,
  UnifiedImageResult,
} from "../core/types.js";
import { joinUrl } from "./openai-compat.js";
import { toHordeWebP } from "./ai-horde-images.js";

const HORDE_REQUEST_FIELDS = [
  "nsfw",
  "censor_nsfw",
  "allow_downgrade",
  "shared",
  "trusted_workers",
  "slow_workers",
  "extra_slow_workers",
  "disable_batching",
  "replacement_filter",
  "dry_run",
  "proxied_account",
] as const;

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

export interface AIHordeProviderOptions {
  pollIntervalMs?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  version?: string;
}

export class AIHordeProvider implements ImageProvider {
  readonly kind = "ai-horde";

  constructor(private readonly options: AIHordeProviderOptions = {}) {}

  async generate(req: UnifiedGenRequest, ctx: CallContext): Promise<UnifiedImageResult> {
    const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(ctx.channel.timeoutMs)]);
    return this.run(req, ctx, signal, {});
  }

  async edit(req: UnifiedEditRequest, ctx: CallContext): Promise<UnifiedImageResult> {
    if (req.images.length !== 1) throw new ValidationError("AI Horde edits require exactly one image");
    const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(ctx.channel.timeoutMs)]);
    try {
      const source = await toHordeWebP(req.images[0], signal);
      const fields: Record<string, unknown> = {
        source_image: source.base64,
        source_processing: req.mask ? "inpainting" : "img2img",
      };
      if (req.mask) {
        const mask = await toHordeWebP(req.mask, signal);
        if (mask.width !== source.width || mask.height !== source.height) {
          throw new ValidationError("mask dimensions must match the source image");
        }
        fields.source_mask = mask.base64;
      }
      return await this.run(req, ctx, signal, fields);
    } catch (error) {
      if (error instanceof ValidationError || error instanceof UpstreamError) throw error;
      throw wrapNetworkError(error, ctx.channel.name);
    }
  }

  async test(_channel: ChannelConfig, _apiKey: string | null): Promise<{ ok: boolean; message: string }> {
    const signal = AbortSignal.timeout(Math.min(_channel.timeoutMs, 15_000));
    const ctx: CallContext = {
      channel: _channel,
      upstreamModel: "",
      apiKey: _apiKey ?? "",
      signal,
    };
    try {
      const path = _apiKey === null ? "/status/heartbeat" : "/find_user";
      const json = await this.requestJson(ctx, path, {}, signal, true, _apiKey);
      const message = (json as { message?: unknown } | null)?.message;
      return { ok: true, message: typeof message === "string" ? message : "HTTP 200" };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  private async run(
    req: UnifiedGenRequest | UnifiedEditRequest,
    ctx: CallContext,
    signal: AbortSignal,
    source: Record<string, unknown>,
  ): Promise<UnifiedImageResult> {
    const horde = req.providerOptions?.horde;
    const payload: Record<string, unknown> = {};
    for (const field of HORDE_REQUEST_FIELDS) {
      if (horde?.[field] !== undefined) payload[field] = horde[field];
    }
    const params: Record<string, unknown> = { ...(horde?.params ?? {}), n: req.n };
    if (req.size && req.size !== "auto") {
      const [width, height] = req.size.split("x").map(Number);
      params.width = width;
      params.height = height;
    }
    Object.assign(payload, source, {
      prompt: req.prompt,
      models: [ctx.upstreamModel],
      r2: true,
      params,
    });

    const accepted = await this.requestJson(ctx, "/generate/async", { method: "POST", body: JSON.stringify(payload) }, signal, true);
    const id = (accepted as { id?: unknown } | null)?.id;
    if (typeof id !== "string" || !id) {
      throw new UpstreamError(502, "upstream_error", `channel '${ctx.channel.name}' returned a malformed task id`);
    }

    try {
      const sleep = this.options.sleep ?? defaultSleep;
      while (true) {
        const check = await this.requestJson(ctx, `/generate/check/${encodeURIComponent(id)}`, {}, signal, false) as {
          done?: unknown;
          faulted?: unknown;
          is_possible?: unknown;
        };
        if (check?.is_possible === false) {
          throw new UpstreamError(503, "service_unavailable", `channel '${ctx.channel.name}' has no compatible AI Horde workers`, null, false);
        }
        if (check?.faulted === true) {
          throw new UpstreamError(502, "upstream_error", `channel '${ctx.channel.name}' AI Horde task faulted`, null, false);
        }
        if (check?.done === true) break;
        await sleep(this.options.pollIntervalMs ?? 2000, signal);
      }

      const status = await this.requestJson(ctx, `/generate/status/${encodeURIComponent(id)}`, {}, signal, false) as {
        generations?: unknown;
      };
      if (!status || !Array.isArray(status.generations)) {
        throw new UpstreamError(502, "upstream_error", `channel '${ctx.channel.name}' returned malformed generation status`, null, false);
      }
      const images = status.generations
        .map((generation) => (generation as { img?: unknown } | null)?.img)
        .filter((image): image is string => typeof image === "string" && image.length > 0)
        .map((url) => ({ url }));
      if (images.length === 0) {
        throw new UpstreamError(502, "upstream_error", `channel '${ctx.channel.name}' returned no images`, null, false);
      }
      return {
        created: Math.floor(Date.now() / 1000),
        images,
        raw: status,
        includeRawResponseFields: false,
      };
    } catch (error) {
      throw this.markUnsafe(error, ctx.channel.name);
    }
  }

  private async requestJson(
    ctx: CallContext,
    path: string,
    init: RequestInit,
    signal: AbortSignal,
    keyRetrySafe: boolean,
    apiKey: string | null = ctx.apiKey,
  ): Promise<unknown> {
    const headers = new Headers(ctx.channel.extraHeaders);
    if (apiKey === null) headers.delete("apikey");
    else headers.set("apikey", apiKey);
    headers.set("Client-Agent", `tiny-images:${this.options.version ?? "0.1.0"}:github.com/zxxx98/tiny-images`);
    if (init.body !== undefined) headers.set("content-type", "application/json");
    let response: Response;
    try {
      response = await fetch(joinUrl(ctx.channel.baseUrl, path), { ...init, headers, signal });
    } catch (error) {
      const mapped = wrapNetworkError(error, ctx.channel.name);
      throw new UpstreamError(mapped.httpStatus, mapped.type, mapped.message, mapped.code, keyRetrySafe);
    }
    const text = await response.text();
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text) as unknown;
      } catch {
        json = null;
      }
    }
    if (!response.ok) {
      throw this.mapHttpError(response.status, json, ctx.channel.name, keyRetrySafe);
    }
    return json;
  }

  private mapHttpError(status: number, body: unknown, channelName: string, keyRetrySafe: boolean): UpstreamError {
    const detail = this.safeErrorDetail(body);
    const suffix = detail ? `: ${detail}` : "";
    if (status === 400) return new UpstreamError(400, "invalid_request_error", `channel '${channelName}' rejected request${suffix}`, null, keyRetrySafe);
    if (status === 401 || status === 403) {
      return new UpstreamError(status, "invalid_request_error", `channel '${channelName}' rejected credentials${suffix}`, "invalid_api_key", keyRetrySafe);
    }
    if (status === 429) return new UpstreamError(429, "rate_limit_error", `channel '${channelName}' rate limited${suffix}`, "rate_limit_exceeded", keyRetrySafe);
    if (status === 503) return new UpstreamError(503, "service_unavailable", `channel '${channelName}' has no available AI Horde service${suffix}`, null, keyRetrySafe);
    if (status === 404 && !keyRetrySafe) {
      return new UpstreamError(502, "upstream_error", `channel '${channelName}' AI Horde task expired or was not found${suffix}`, null, false);
    }
    if (status >= 500) return new UpstreamError(502, "upstream_error", `channel '${channelName}' server error${suffix}`, null, keyRetrySafe);
    return new UpstreamError(status, "invalid_request_error", `channel '${channelName}' rejected request${suffix}`, null, keyRetrySafe);
  }

  private safeErrorDetail(body: unknown): string | null {
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    const value = body as Record<string, unknown>;
    if (typeof value.message === "string") return value.message.slice(0, 500);
    if (typeof value.error === "string") return value.error.slice(0, 500);
    if (value.error && typeof value.error === "object" && typeof (value.error as { message?: unknown }).message === "string") {
      return String((value.error as { message: string }).message).slice(0, 500);
    }
    if (value.errors && typeof value.errors === "object") {
      const detail = Object.values(value.errors as Record<string, unknown>).find((item) => typeof item === "string");
      if (typeof detail === "string") return detail.slice(0, 500);
    }
    return null;
  }

  private markUnsafe(error: unknown, channelName: string): UpstreamError {
    if (error instanceof UpstreamError) {
      return new UpstreamError(error.httpStatus, error.type, error.message, error.code, false);
    }
    const mapped = wrapNetworkError(error, channelName);
    return new UpstreamError(mapped.httpStatus, mapped.type, mapped.message, mapped.code, false);
  }
}
