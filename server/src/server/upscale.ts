import type { FastifyRequest } from "fastify";
import type { AppContext } from "../app.js";
import type { CloudflareImagesEnv } from "../env.js";
import { ServiceUnavailableError, ValidationError } from "../core/errors.js";
import {
  buildCloudflareUpscaleUrl,
  ConcurrencyLimiter,
  fetchCloudflareUpscale,
  removeStagedUpscaleInput,
  saveUpscaleOutput,
  stageUpscaleInput,
  UpscaleError,
  validateUpscaleInput,
  type ValidatedUpscaleInput,
} from "../media/upscale.js";

const MODEL = "cloudflare-images-upscale";
const PROMPT = "图片超分";
const ENGINE = "cloudflare-images-esrgan";
const limiters = new WeakMap<object, { concurrency: number; limiter: ConcurrencyLimiter }>();

function config(ctx: AppContext): CloudflareImagesEnv {
  return ctx.deps.env.cloudflareImages ?? {
    enabled: false,
    baseUrl: null,
    timeoutMs: 120_000,
    maxInputBytes: 20 * 1024 * 1024,
    maxInputPixels: 40_000_000,
    maxDimension: 8192,
    maxOutputBytes: 50 * 1024 * 1024,
    concurrency: 2,
  };
}

function limiterFor(ctx: AppContext, concurrency: number): ConcurrencyLimiter {
  const key = ctx.deps.jobManager as object;
  const existing = limiters.get(key);
  if (existing?.concurrency === concurrency) return existing.limiter;
  const limiter = new ConcurrencyLimiter(concurrency);
  limiters.set(key, { concurrency, limiter });
  return limiter;
}

function unavailable(): Error {
  return new ServiceUnavailableError("图片超分未在当前部署中启用", "upscale_not_configured");
}

async function parseUpscaleMultipart(
  req: FastifyRequest,
  cf: CloudflareImagesEnv,
): Promise<ValidatedUpscaleInput> {
  if (!req.isMultipart()) throw new ValidationError("request must be multipart/form-data");
  let image: Buffer | null = null;
  let imageCount = 0;
  let scale: 2 | 4 = 2;
  let responseFormat = "url";
  const seenFields = new Set<string>();

  try {
    for await (const part of req.parts({
      limits: { fileSize: cf.maxInputBytes, files: 2, fields: 3, parts: 5 },
    })) {
      if (part.type === "file") {
        if (part.fieldname !== "image") throw new ValidationError(`unsupported file field '${part.fieldname}'`);
        imageCount++;
        if (imageCount > 1) throw new ValidationError("exactly one 'image' file is required");
        image = await part.toBuffer();
      } else {
        if (seenFields.has(part.fieldname)) throw new ValidationError(`duplicate field '${part.fieldname}'`);
        seenFields.add(part.fieldname);
        const value = String(part.value);
        if (part.fieldname === "scale") {
          if (value !== "2" && value !== "4") throw new ValidationError("'scale' must be 2 or 4");
          scale = value === "4" ? 4 : 2;
        } else if (part.fieldname === "response_format") {
          responseFormat = value;
        } else {
          throw new ValidationError(`unsupported field '${part.fieldname}'`);
        }
      }
    }
  } catch (err) {
    if (err instanceof ValidationError) throw err;
    const code = (err as { code?: string }).code;
    if (code === "FST_REQ_FILE_TOO_LARGE") throw new ValidationError(`'image' exceeds the ${cf.maxInputBytes}-byte input limit`);
    if (typeof code === "string" && code.startsWith("FST_")) throw new ValidationError("invalid multipart upload");
    throw err;
  }
  if (imageCount !== 1 || !image) throw new ValidationError("exactly one 'image' file is required");
  if (responseFormat !== "url") throw new ValidationError("'response_format' must be 'url'");
  return validateUpscaleInput(image, scale, cf);
}

function paramsFor(input: ValidatedUpscaleInput): string {
  return JSON.stringify({
    operation: "upscale",
    scale: input.scale,
    sourceWidth: input.sourceWidth,
    sourceHeight: input.sourceHeight,
    targetWidth: input.targetWidth,
    targetHeight: input.targetHeight,
    engine: ENGINE,
  });
}

function safeJobMessage(err: unknown): string {
  if (err instanceof UpscaleError) return err.message;
  return "upscale failed";
}

async function runUpscaleJob(
  ctx: AppContext,
  jobId: string,
  generationId: number,
  staged: ReturnType<typeof stageUpscaleInput>,
  input: ValidatedUpscaleInput,
  cf: CloudflareImagesEnv,
): Promise<void> {
  const started = Date.now();
  try {
    const fileName = await limiterFor(ctx, cf.concurrency).run(
      () => ctx.deps.jobManager.setProgress(jobId, "等待超分队列"),
      async () => {
        ctx.deps.jobManager.setProgress(jobId, "正在请求 AI 超分…");
        const url = buildCloudflareUpscaleUrl(cf.baseUrl!, staged.fileName, input.targetWidth, input.targetHeight);
        const output = await fetchCloudflareUpscale({
          url,
          timeoutMs: cf.timeoutMs,
          maxOutputBytes: cf.maxOutputBytes,
          targetWidth: input.targetWidth,
          targetHeight: input.targetHeight,
        });
        return saveUpscaleOutput(ctx.deps.env.dataDir, output);
      },
    );
    const latencyMs = Date.now() - started;
    ctx.deps.jobManager.addImage(jobId, { file: fileName });
    ctx.deps.jobManager.setProgress(jobId, "超分完成");
    ctx.deps.jobManager.finish(jobId, {
      status: "ok",
      channelId: null,
      channelName: null,
      latencyMs,
      errorMessage: null,
    });
    ctx.deps.repo.completeGeneration(generationId, {
      status: "ok",
      channelId: null,
      latencyMs,
      errorMessage: null,
      images: JSON.stringify([{ file: fileName }]),
    });
    removeStagedUpscaleInput(staged.fullPath);
  } catch (err) {
    const latencyMs = Date.now() - started;
    const message = safeJobMessage(err);
    const diagnostic = err instanceof UpscaleError ? err.diagnostic : err instanceof Error ? err.message : String(err);
    if (diagnostic) ctx.app.log.warn({ err: diagnostic, jobId }, "Cloudflare image upscale failed");
    ctx.deps.jobManager.setProgress(jobId, "超分失败，可重试");
    ctx.deps.jobManager.finish(jobId, {
      status: "error",
      channelId: null,
      channelName: null,
      latencyMs,
      errorMessage: message,
    });
    ctx.deps.repo.completeGeneration(generationId, {
      status: "error",
      channelId: null,
      latencyMs,
      errorMessage: message,
      images: "[]",
    });
    // 失败保留 staging 文件，由 TTL 清理器统一删除。
  }
}

export function registerUpscale(ctx: AppContext): void {
  ctx.app.get("/v1/features", async () => ({ upscale: config(ctx).enabled }));

  ctx.app.post("/v1/images/upscale-jobs", { preHandler: ctx.requireApiKey }, async (req, reply) => {
    const cf = config(ctx);
    if (!cf.enabled || !cf.baseUrl) throw unavailable();
    const input = await parseUpscaleMultipart(req, cf);
    const staged = stageUpscaleInput(ctx.deps.env.dataDir, input);
    let generationId: number;
    try {
      generationId = ctx.deps.repo.insertGeneration({
        createdAt: Date.now(),
        apiKeyId: req.callerApiKeyId ?? null,
        userId: req.callerUserId ?? null,
        model: MODEL,
        prompt: PROMPT,
        params: paramsFor(input),
        status: "pending",
        channelId: null,
        latencyMs: null,
        errorMessage: null,
        images: "[]",
      });
    } catch (err) {
      removeStagedUpscaleInput(staged.fullPath);
      throw err;
    }
    const job = ctx.deps.jobManager.create({
      apiKeyId: req.callerApiKeyId ?? null,
      userId: req.callerUserId ?? null,
      generationId,
      model: MODEL,
      prompt: PROMPT,
      kind: "upscale",
    });
    ctx.deps.jobManager.setProgress(job.id, "等待超分队列");
    void runUpscaleJob(ctx, job.id, generationId, staged, input, cf);
    return reply.code(200).send({ jobId: job.id });
  });
}
