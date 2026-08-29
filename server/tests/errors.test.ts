import { describe, expect, it } from "vitest";
import {
  ModelNotFoundError,
  UpstreamError,
  ValidationError,
  mapUpstreamFailure,
  toOpenAIError,
  wrapNetworkError,
} from "../src/core/errors.js";

describe("mapUpstreamFailure", () => {
  it("401 keeps upstream message and marks invalid_api_key", () => {
    const e = mapUpstreamFailure(401, { error: { message: "bad key", type: "invalid_request_error" } }, "ch1");
    expect(e.httpStatus).toBe(401);
    expect(e.code).toBe("invalid_api_key");
    expect(e.message).toContain("ch1");
    expect(e.message).toContain("bad key");
  });
  it("429 maps to rate_limit_error", () => {
    const e = mapUpstreamFailure(429, null, "ch1");
    expect(e.type).toBe("rate_limit_error");
    expect(e.httpStatus).toBe(429);
  });
  it("5xx becomes 502 upstream_error", () => {
    const e = mapUpstreamFailure(503, { error: { message: "boom" } }, "ch1");
    expect(e.httpStatus).toBe(502);
    expect(e.type).toBe("upstream_error");
  });
  it("400 keeps status and code", () => {
    const e = mapUpstreamFailure(400, { error: { message: "bad size", code: "invalid_size" } }, "ch1");
    expect(e.httpStatus).toBe(400);
    expect(e.code).toBe("invalid_size");
  });
});

describe("toOpenAIError", () => {
  it("maps domain errors", () => {
    expect(toOpenAIError(new ValidationError("no prompt")).status).toBe(400);
    const nf = toOpenAIError(new ModelNotFoundError("m"));
    expect(nf.status).toBe(404);
    expect(nf.body.error.code).toBe("model_not_found");
    const up = toOpenAIError(new UpstreamError(504, "timeout", "t"));
    expect(up.status).toBe(504);
    expect(up.body.error.type).toBe("timeout");
    expect(toOpenAIError(new Error("x")).body.error.type).toBe("internal_error");
  });
  it("wraps network failures", () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    expect(wrapNetworkError(abort, "c").httpStatus).toBe(504);
    expect(wrapNetworkError(abort, "c").type).toBe("timeout");
    expect(wrapNetworkError(new Error("ECONNREFUSED"), "c").httpStatus).toBe(502);
  });
});
