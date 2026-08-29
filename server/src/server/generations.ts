import type { FastifyReply, FastifyRequest } from "fastify";
import { ValidationError } from "../core/errors.js";
import type { UnifiedGenRequest, UnifiedImage, UnifiedImageResult } from "../core/types.js";
import { conformImages } from "../media/b64cache.js";
import type { AppContext } from "../app.js";

const SIZE_RE = /^(\d{3,4}x\d{3,4}|auto)$/;
const KNOWN_GEN_FIELDS = new Set(["model", "prompt", "n", "size", "quality", "response_format", "stream"]);

interface ValidatedGen {
  model: string;
  req: UnifiedGenRequest;
  stream: boolean;
}

export function validateGenBody(body: unknown): ValidatedGen {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ValidationError("request body must be a JSON object");
  }
  const b = body as Record<string, unknown>;
  if (typeof b.model !== "string" || b.model.length === 0) throw new ValidationError("'model' is required");
  if (typeof b.prompt !== "string" || b.prompt.length === 0) throw new ValidationError("'prompt' is required");
  let n = 1;
  if (b.n !== undefined) {
    if (!Number.isInteger(b.n) || (b.n as number) < 1 || (b.n as number) > 10) throw new ValidationError("'n' must be an integer between 1 and 10");
    n = b.n as number;
  }
  if (b.size !== undefined && (typeof b.size !== "string" || !SIZE_RE.test(b.size))) {
    throw new ValidationError("'size' must match '<width>x<height>' (e.g. 1024x1024) or 'auto'");
  }
  if (b.quality !== undefined && typeof b.quality !== "string") throw new ValidationError("'quality' must be a string");
  let responseFormat: "url" | "b64_json" | "auto" = "auto";
  if (b.response_format !== undefined) {
    if (b.response_format !== "url" && b.response_format !== "b64_json") {
      throw new ValidationError("'response_format' must be 'url' or 'b64_json'");
    }
    responseFormat = b.response_format;
  }
  let stream = false;
  if (b.stream !== undefined) {
    if (typeof b.stream !== "boolean") throw new ValidationError("'stream' must be a boolean");
    stream = b.stream;
  }
  const passthrough: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(b)) {
    if (!KNOWN_GEN_FIELDS.has(k)) passthrough[k] = v;
  }
  return {
    model: b.model,
    req: {
      prompt: b.prompt,
      n,
      size: b.size as string | undefined,
      quality: b.quality as string | undefined,
      responseFormat,
      passthrough,
    },
    stream,
  };
}

export function toDataItem(img: UnifiedImage): Record<string, unknown> {
  const item: Record<string, unknown> = {};
  if (img.b64 !== undefined) item.b64_json = img.b64;
  if (img.url !== undefined) item.url = img.url;
  if (img.revisedPrompt !== undefined) item.revised_prompt = img.revisedPrompt;
  return item;
}

export function toImagesResponse(result: UnifiedImageResult, images: UnifiedImage[]): Record<string, unknown> {
  const body: Record<string, unknown> = { created: result.created, data: images.map(toDataItem) };
  if (result.raw && typeof result.raw === "object") {
    for (const [k, v] of Object.entries(result.raw as Record<string, unknown>)) {
      if (k === "created" || k === "data") continue;
      body[k] = v;
    }
  }
  return body;
}

export function fileBaseUrlFor(ctx: AppContext, req: FastifyRequest): string {
  if (ctx.deps.env.publicBaseUrl) return ctx.deps.env.publicBaseUrl.replace(/\/+$/, "");
  const host = req.headers.host ?? `localhost:${ctx.deps.env.port}`;
  const proto = req.protocol === "https" || req.headers["x-forwarded-proto"] === "https" ? "https" : "http";
  return `${proto}://${host}`;
}

export function requestSignal(req: FastifyRequest, reply: FastifyReply): AbortSignal {
  const ac = new AbortController();
  req.raw.on("close", () => {
    if (!reply.raw.writableEnded) ac.abort(new Error("client disconnected"));
  });
  return ac.signal;
}

export function registerGenerations(ctx: AppContext): void {
  ctx.app.post("/v1/images/generations", { preHandler: ctx.requireApiKey }, async (req, reply) => {
    const { model, req: genReq, stream } = validateGenBody(req.body);
    void stream; // 流式在 Task 12 接入
    const r = await ctx.deps.executor.generate(model, genReq, {
      callerApiKeyId: req.callerApiKeyId ?? null,
      signal: requestSignal(req, reply),
    });
    const images = await conformImages({
      images: r.result.images,
      wanted: genReq.responseFormat,
      dataDir: ctx.deps.env.dataDir,
      fileBaseUrl: fileBaseUrlFor(ctx, req),
      fetchTimeoutMs: r.channel.timeoutMs,
      signal: requestSignal(req, reply),
    });
    reply.header("x-tiny-channel", r.channel.name);
    reply.header("x-tiny-latency-ms", r.latencyMs);
    return toImagesResponse(r.result, images);
  });
}
