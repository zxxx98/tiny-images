export class UpstreamError extends Error {
  constructor(
    public readonly httpStatus: number,
    public readonly type: string,
    message: string,
    public readonly code: string | null = null,
  ) {
    super(message);
    this.name = "UpstreamError";
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export class ModelNotFoundError extends Error {
  constructor(public readonly model: string) {
    super(`model '${model}' not found`);
    this.name = "ModelNotFoundError";
  }
}

export interface OpenAIErrorBody {
  error: { message: string; type: string; code: string | null };
}

export function toOpenAIError(err: unknown): { status: number; body: OpenAIErrorBody } {
  if (err instanceof UpstreamError) {
    return { status: err.httpStatus, body: { error: { message: err.message, type: err.type, code: err.code } } };
  }
  if (err instanceof ValidationError) {
    return { status: 400, body: { error: { message: err.message, type: "invalid_request_error", code: null } } };
  }
  if (err instanceof ModelNotFoundError) {
    return { status: 404, body: { error: { message: err.message, type: "invalid_request_error", code: "model_not_found" } } };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { status: 500, body: { error: { message, type: "internal_error", code: null } } };
}

interface UpstreamErrorShape {
  error?: { message?: string; type?: string; code?: string | null };
}

function statusText(status: number): string {
  return `upstream responded with HTTP ${status}`;
}

export function mapUpstreamFailure(status: number, body: unknown, channelName: string): UpstreamError {
  const b = body as UpstreamErrorShape | null;
  const upstreamMessage = typeof b?.error?.message === "string" ? b.error.message : undefined;
  const upstreamCode = typeof b?.error?.code === "string" ? b.error.code : null;
  if (status === 401 || status === 403) {
    return new UpstreamError(
      status,
      "invalid_request_error",
      `channel '${channelName}' rejected credentials: ${upstreamMessage ?? statusText(status)}`,
      upstreamCode ?? "invalid_api_key",
    );
  }
  if (status === 429) {
    return new UpstreamError(
      429,
      "rate_limit_error",
      `channel '${channelName}' rate limited: ${upstreamMessage ?? "too many requests"}`,
      upstreamCode ?? "rate_limit_exceeded",
    );
  }
  if (status >= 500) {
    return new UpstreamError(502, "upstream_error", `channel '${channelName}' server error: ${upstreamMessage ?? statusText(status)}`, upstreamCode);
  }
  return new UpstreamError(
    status,
    "invalid_request_error",
    `channel '${channelName}' rejected request: ${upstreamMessage ?? statusText(status)}`,
    upstreamCode,
  );
}

export function wrapNetworkError(err: unknown, channelName: string): UpstreamError {
  if (err instanceof UpstreamError) return err;
  if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) {
    return new UpstreamError(504, "timeout", `channel '${channelName}' timed out`);
  }
  return new UpstreamError(502, "upstream_error", `channel '${channelName}' unreachable: ${err instanceof Error ? err.message : String(err)}`);
}
