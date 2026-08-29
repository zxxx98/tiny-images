import { ModelNotFoundError, UpstreamError } from "./errors.js";
import type { KeyPool } from "./keyPool.js";
import type { ModelRouter } from "./router.js";
import type {
  CallContext,
  ImageProvider,
  UnifiedEditRequest,
  UnifiedGenRequest,
  UnifiedImageResult,
} from "./types.js";
import type { ChannelRow, Repo } from "../store/repo.js";

export interface ExecutorDeps {
  router: ModelRouter;
  keyPool: KeyPool;
  provider: ImageProvider;
  repo: Repo;
  keyRetryCooldownMs?: number;
}

export interface ExecutorOptions {
  callerApiKeyId: number | null;
  signal?: AbortSignal;
}

export interface ExecutorResult {
  result: UnifiedImageResult;
  channel: ChannelRow;
  latencyMs: number;
}

const KEY_ROTATE_STATUSES = new Set([401, 403, 429]);

export class Executor {
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
    const route = this.deps.router.resolve(publicName);
    if (!route) throw new ModelNotFoundError(publicName);
    const { channel } = route;

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
        const result =
          payload.kind === "generate"
            ? await this.deps.provider.generate(payload.req, ctx)
            : await this.deps.provider.edit(payload.req, ctx);
        this.deps.keyPool.markSuccess(key.keyId);
        const latencyMs = Date.now() - start;
        this.log(publicName, channel.id, opts.callerApiKeyId, "ok", 200, latencyMs, null);
        return { result, channel, latencyMs };
      } catch (err) {
        lastError = err;
        const rotate = err instanceof UpstreamError && KEY_ROTATE_STATUSES.has(err.httpStatus);
        if (rotate) {
          this.deps.keyPool.markFailure(key.keyId, this.deps.keyRetryCooldownMs ?? 60_000);
          continue;
        }
        this.log(publicName, channel.id, opts.callerApiKeyId, "error", toStatus(err), Date.now() - start, toMessage(err));
        throw err;
      }
    }

    const error =
      lastError ??
      new UpstreamError(502, "upstream_error", `no usable api key for channel '${channel.name}'`);
    this.log(publicName, channel.id, opts.callerApiKeyId, "error", toStatus(error), Date.now() - start, toMessage(error));
    throw error;
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
