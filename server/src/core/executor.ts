import { ModelNotFoundError, QuotaError, UpstreamError } from "./errors.js";
import type { KeyPool } from "./keyPool.js";
import type { ModelRouter } from "./router.js";
import type {
  CallContext,
  UnifiedEditRequest,
  UnifiedGenRequest,
  UnifiedImageResult,
} from "./types.js";
import type { ChannelRow, Repo } from "../store/repo.js";
import { providerFor, type ProviderRegistry } from "../providers/registry.js";
import { AdaptiveConcurrencyLimiter } from "./concurrency.js";

export interface ExecutorDeps {
  router: ModelRouter;
  keyPool: KeyPool;
  providers: ProviderRegistry;
  repo: Repo;
  keyRetryCooldownMs?: number;
}

export interface ExecutorOptions {
  callerApiKeyId: number | null;
  callerUserId?: number | null;
  allowedChannelIds?: number[] | null;
  signal?: AbortSignal;
}

export interface ExecutorResult {
  result: UnifiedImageResult;
  channel: ChannelRow;
  latencyMs: number;
}

const KEY_ROTATE_STATUSES = new Set([401, 403, 429]);

export function withGlobalPrompt<T extends UnifiedGenRequest | UnifiedEditRequest>(request: T, globalPrompt: string): T {
  if (!globalPrompt.trim()) return request;
  return { ...request, prompt: `${globalPrompt}\n${request.prompt}` } as T;
}

function safeMetadata(value: unknown): unknown | undefined {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(safeMetadata).filter((item) => item !== undefined);
  if (!value || typeof value !== "object") return undefined;
  const entries = Object.entries(value as Record<string, unknown>)
    .map(([key, item]) => [key, safeMetadata(item)] as const)
    .filter((entry): entry is readonly [string, unknown] => entry[1] !== undefined);
  return Object.fromEntries(entries);
}

function suppressPromptEchoes(result: UnifiedImageResult): UnifiedImageResult {
  const raw = result.raw && typeof result.raw === "object" && !Array.isArray(result.raw)
    ? result.raw as Record<string, unknown>
    : null;
  const usage = safeMetadata(raw?.usage);
  return {
    created: result.created,
    images: result.images.map(({ revisedPrompt: _revisedPrompt, ...image }) => image),
    ...(usage !== undefined ? { raw: { usage } } : {}),
    ...(result.includeRawResponseFields !== undefined ? { includeRawResponseFields: result.includeRawResponseFields } : {}),
  };
}

function suppressPromptEchoedByError(error: unknown, channelName: string): unknown {
  if (!(error instanceof UpstreamError)) return error;
  return new UpstreamError(
    error.httpStatus,
    error.type,
    `channel '${channelName}' rejected the upstream request`,
    error.code,
    error.keyRetrySafe,
  );
}

export class Executor {
  private readonly channelLimiters = new Map<number, AdaptiveConcurrencyLimiter>();

  constructor(private readonly deps: ExecutorDeps) {}

  generate(publicName: string, req: UnifiedGenRequest, opts: ExecutorOptions): Promise<ExecutorResult> {
    return this.call(publicName, { kind: "generate", req }, opts);
  }

  edit(publicName: string, req: UnifiedEditRequest, opts: ExecutorOptions): Promise<ExecutorResult> {
    return this.call(publicName, { kind: "edit", req }, opts);
  }

  private async call(
    publicName: string,
    payload: { kind: "generate"; req: UnifiedGenRequest } | { kind: "edit"; req: UnifiedEditRequest },
    opts: ExecutorOptions,
  ): Promise<ExecutorResult> {
    const route = this.deps.router.resolve(publicName, opts.allowedChannelIds ?? null);
    if (!route) throw new ModelNotFoundError(publicName);
    const { channel } = route;
    const provider = providerFor(this.deps.providers, channel.type);
    const globalPrompt = this.deps.repo.getAppSettings().globalPrompt;
    const upstreamRequest = withGlobalPrompt(payload.req, globalPrompt);

    // 额度：仅普通用户且配置了 quota_total 时生效；按成功生成的图片张数扣减
    const user = opts.callerUserId ? this.deps.repo.getUser(opts.callerUserId) : null;
    const quotaLimited = !!user && user.role !== "admin" && user.quotaTotal !== null;
    if (quotaLimited) {
      const wanted = "n" in payload.req && typeof payload.req.n === "number" ? payload.req.n : 1;
      if (user!.quotaTotal! - user!.quotaUsed < wanted) throw new QuotaError();
    }

    const limiter = this.limiterFor(channel.id, channel.concurrency);
    return limiter.run(async () => {
      const start = Date.now();
      const attempted = new Set<number>();
      const maxAttempts = this.deps.repo.enabledKeyCount(channel.id);
      let lastError: unknown = null;

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const key = this.deps.keyPool.pick(channel.id);
        if (!key || attempted.has(key.keyId)) break;
        attempted.add(key.keyId);

        const ctx: CallContext = {
          channel,
          upstreamModel: route.model.upstreamName,
          apiKey: key.apiKey,
          signal: opts.signal ?? new AbortController().signal,
        };
        try {
          const upstreamResult =
            payload.kind === "generate"
              ? await provider.generate(upstreamRequest as UnifiedGenRequest, ctx)
              : await provider.edit(upstreamRequest as UnifiedEditRequest, ctx);
          const result = globalPrompt.trim() ? suppressPromptEchoes(upstreamResult) : upstreamResult;
          this.deps.keyPool.markSuccess(key.keyId);
          this.deps.router.markSuccess(channel.id);
          if (quotaLimited) {
            const charged = this.deps.repo.chargeQuota(user!.id, result.images.length);
            if (!charged) console.warn(`[quota] concurrent over-spend for user ${user!.id}; images=${result.images.length}`);
          }
          const latencyMs = Date.now() - start;
          this.log(publicName, channel.id, opts.callerApiKeyId, "ok", 200, latencyMs, null);
          return { result, channel, latencyMs };
        } catch (err) {
          lastError = err;
          const rotate = err instanceof UpstreamError && err.keyRetrySafe && KEY_ROTATE_STATUSES.has(err.httpStatus);
          if (rotate) {
            this.deps.keyPool.markFailure(key.keyId, this.deps.keyRetryCooldownMs ?? 60_000);
            continue;
          }
          // key 轮换解决不了的错误（网络不通 / 5xx / 超时）计入渠道熔断
          this.deps.router.markFailure(channel.id);
          this.log(publicName, channel.id, opts.callerApiKeyId, "error", toStatus(err), Date.now() - start, toMessage(err));
          throw globalPrompt.trim() ? suppressPromptEchoedByError(err, channel.name) : err;
        }
      }

      const error =
        lastError ??
        new UpstreamError(502, "upstream_error", `no usable api key for channel '${channel.name}'`);
      this.deps.router.markFailure(channel.id);
      this.log(publicName, channel.id, opts.callerApiKeyId, "error", toStatus(error), Date.now() - start, toMessage(error));
      throw globalPrompt.trim() ? suppressPromptEchoedByError(error, channel.name) : error;
    });
  }

  private limiterFor(channelId: number, concurrency: number): AdaptiveConcurrencyLimiter {
    let limiter = this.channelLimiters.get(channelId);
    if (!limiter) {
      limiter = new AdaptiveConcurrencyLimiter(concurrency);
      this.channelLimiters.set(channelId, limiter);
    } else {
      limiter.setMax(concurrency);
    }
    return limiter;
  }

  private log(
    model: string,
    channelId: number,
    apiKeyId: number | null,
    status: "ok" | "error",
    httpStatus: number | null,
    latencyMs: number,
    errorMessage: string | null,
  ): void {
    try {
      this.deps.repo.insertLog({ ts: Date.now(), model, channelId, apiKeyId, status, httpStatus, latencyMs, errorMessage });
    } catch {
      // 日志失败不影响主流程
    }
  }
}

function toStatus(err: unknown): number | null {
  if (err instanceof UpstreamError) return err.httpStatus;
  return 500;
}

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
