import { describe, expect, it } from "vitest";
import { loadEnv } from "../src/env.js";

describe("Cloudflare Images environment", () => {
  it("defaults disabled with conservative limits", () => {
    expect(loadEnv({}).cloudflareImages).toEqual({
      enabled: false,
      baseUrl: null,
      timeoutMs: 120_000,
      maxInputBytes: 20 * 1024 * 1024,
      maxInputPixels: 40_000_000,
      maxDimension: 8192,
      maxOutputBytes: 50 * 1024 * 1024,
      concurrency: 2,
    });
  });

  it("requires an HTTPS public root URL when enabled", () => {
    expect(() => loadEnv({ CLOUDFLARE_IMAGES_ENABLED: "true" })).toThrow(/BASE_URL is required/);
    for (const base of [
      "http://images.example.com",
      "https://localhost",
      "https://127.0.0.1",
      "https://images.example.com/path",
      "https://user@images.example.com",
      "https://images.example.com?x=1",
    ]) {
      expect(() => loadEnv({ CLOUDFLARE_IMAGES_ENABLED: "true", CLOUDFLARE_IMAGES_BASE_URL: base })).toThrow();
    }
  });

  it("normalizes valid configuration and validates numeric bounds", () => {
    const env = loadEnv({
      CLOUDFLARE_IMAGES_ENABLED: "true",
      CLOUDFLARE_IMAGES_BASE_URL: "https://images.example.com/",
      CLOUDFLARE_IMAGES_TIMEOUT_MS: "10000",
      UPSCALE_MAX_INPUT_BYTES: "1234",
      UPSCALE_MAX_INPUT_PIXELS: "5678",
      UPSCALE_MAX_DIMENSION: "4096",
      UPSCALE_MAX_OUTPUT_BYTES: "9999",
      UPSCALE_CONCURRENCY: "3",
    });
    expect(env.cloudflareImages).toEqual({
      enabled: true,
      baseUrl: "https://images.example.com",
      timeoutMs: 10_000,
      maxInputBytes: 1234,
      maxInputPixels: 5678,
      maxDimension: 4096,
      maxOutputBytes: 9999,
      concurrency: 3,
    });
    expect(() => loadEnv({ CLOUDFLARE_IMAGES_TIMEOUT_MS: "9999" })).toThrow(/TIMEOUT/);
    expect(() => loadEnv({ CLOUDFLARE_IMAGES_ENABLED: "yes" })).toThrow(/true.*false/);
  });
});
