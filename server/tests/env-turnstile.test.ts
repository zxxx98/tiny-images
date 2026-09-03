import { describe, expect, it } from "vitest";
import { loadEnv } from "../src/env.js";

describe("Turnstile environment", () => {
  it("defaults disabled when no keys are set", () => {
    expect(loadEnv({}).turnstile).toEqual({
      enabled: false,
      siteKey: null,
      secretKey: null,
      timeoutMs: 10_000,
    });
  });

  it("enables when both keys are configured", () => {
    const env = loadEnv({ TURNSTILE_SITE_KEY: "site", TURNSTILE_SECRET_KEY: "secret", TURNSTILE_TIMEOUT_MS: "5000" });
    expect(env.turnstile).toEqual({ enabled: true, siteKey: "site", secretKey: "secret", timeoutMs: 5_000 });
  });

  it("rejects partially configured keys", () => {
    expect(() => loadEnv({ TURNSTILE_SITE_KEY: "site" })).toThrow(/must be configured together/);
    expect(() => loadEnv({ TURNSTILE_SECRET_KEY: "secret" })).toThrow(/must be configured together/);
  });

  it("treats empty strings as unset and validates timeout bounds", () => {
    expect(loadEnv({ TURNSTILE_SITE_KEY: "", TURNSTILE_SECRET_KEY: "" }).turnstile?.enabled).toBe(false);
    expect(() => loadEnv({ TURNSTILE_SITE_KEY: "s", TURNSTILE_SECRET_KEY: "x", TURNSTILE_TIMEOUT_MS: "999" })).toThrow(/TURNSTILE_TIMEOUT_MS/);
    expect(() => loadEnv({ TURNSTILE_SITE_KEY: "s", TURNSTILE_SECRET_KEY: "x", TURNSTILE_TIMEOUT_MS: "60001" })).toThrow(/TURNSTILE_TIMEOUT_MS/);
    expect(() => loadEnv({ TURNSTILE_SITE_KEY: "s", TURNSTILE_SECRET_KEY: "x", TURNSTILE_TIMEOUT_MS: "abc" })).toThrow(/TURNSTILE_TIMEOUT_MS/);
  });
});
