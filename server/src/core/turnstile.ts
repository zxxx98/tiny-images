export const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export interface TurnstileVerifyResult {
  success: boolean;
  errorCodes: string[];
}

// siteverify 不可达/超时/非 200 时抛出：宁可拒绝登录（fail closed），不能静默放行
export class TurnstileUnavailableError extends Error {
  constructor(public diagnostic: string) {
    super("human verification is temporarily unavailable");
  }
}

export async function verifyTurnstileToken(input: {
  secretKey: string;
  token: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}): Promise<TurnstileVerifyResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(SITEVERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret: input.secretKey, response: input.token }),
      redirect: "error",
      signal: AbortSignal.timeout(input.timeoutMs),
    });
  } catch (err) {
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      throw new TurnstileUnavailableError("siteverify request timed out");
    }
    throw new TurnstileUnavailableError(`siteverify request failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!response.ok) {
    throw new TurnstileUnavailableError(`siteverify returned HTTP ${response.status}`);
  }
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw new TurnstileUnavailableError("siteverify returned invalid JSON");
  }
  const record = (parsed ?? {}) as Record<string, unknown>;
  const rawCodes = record["error-codes"];
  return {
    success: record.success === true,
    errorCodes: Array.isArray(rawCodes) ? rawCodes.filter((c): c is string => typeof c === "string") : [],
  };
}
