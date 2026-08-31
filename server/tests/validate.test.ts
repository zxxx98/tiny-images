import { describe, expect, it } from "vitest";
import { validateGenBody } from "../src/server/generations.js";

describe("AI Horde request options", () => {
  it("parses horde into providerOptions instead of passthrough", () => {
    const parsed = validateGenBody({ model: "img-1", prompt: "cat", horde: { nsfw: true, params: { steps: 20 } } });
    expect(parsed.req.providerOptions?.horde).toEqual({ nsfw: true, params: { steps: 20 } });
    expect(parsed.req.passthrough).not.toHaveProperty("horde");
  });

  it("parses multipart JSON strings", () => {
    const parsed = validateGenBody({ model: "img-1", prompt: "cat", horde: JSON.stringify({ shared: false }) });
    expect(parsed.req.providerOptions?.horde).toEqual({ shared: false });
  });

  it("rejects malformed and unsupported horde options", () => {
    expect(() => validateGenBody({ model: "img-1", prompt: "cat", horde: [] })).toThrow("'horde' must be an object");
    expect(() => validateGenBody({ model: "img-1", prompt: "cat", horde: { params: [] } })).toThrow("'horde.params' must be an object");
    expect(() => validateGenBody({ model: "img-1", prompt: "cat", horde: { models: ["override"] } })).toThrow("unsupported horde field 'models'");
    expect(() => validateGenBody({ model: "img-1", prompt: "cat", horde: { nsfw: "yes" } })).toThrow("'horde.nsfw' must be a boolean");
  });
});
