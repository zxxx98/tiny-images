import { afterEach, describe, expect, it, vi } from "vitest";
import { createEditJob, createUpscaleJob, fetchAnnouncement, fetchChannelHealth, fetchFeatures, fetchModelHealth, fetchSettings, optimizePrompt, saveSettings } from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("channel health API", () => {
  it("fetches channel health with authentication", async () => {
    vi.stubGlobal("localStorage", { getItem: () => "web-token" });
    const fetchMock = vi.fn().mockResolvedValue(new Response("[]", { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchChannelHealth()).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledWith("/admin/channel-health", expect.objectContaining({ method: "GET" }));
  });
});
describe("model health API", () => {
  it("fetches model health with the current JWT", async () => {
    vi.stubGlobal("localStorage", { getItem: () => "web-token" });
    const payload = { generatedAt: 123, sampleLimit: 50, models: [] };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchModelHealth()).resolves.toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/model-health",
      expect.objectContaining({ method: "GET", headers: expect.objectContaining({ authorization: "Bearer web-token" }) }),
    );
  });

  it("surfaces model health errors", async () => {
    vi.stubGlobal("localStorage", { getItem: () => "web-token" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: "health unavailable" } }), {
          status: 503,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await expect(fetchModelHealth()).rejects.toThrow("health unavailable");
  });
});

describe("features API", () => {
  it("fetches authenticated frontend feature flags", async () => {
    vi.stubGlobal("localStorage", { getItem: () => "web-token" });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ upscale: true, promptOptimizer: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchFeatures()).resolves.toEqual({ upscale: true, promptOptimizer: false });
    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/features",
      expect.objectContaining({ method: "GET", headers: expect.objectContaining({ authorization: "Bearer web-token" }) }),
    );
  });
});

describe("optimizePrompt", () => {
  it("posts the prompt to the optimize endpoint and returns the rewritten text", async () => {
    vi.stubGlobal("localStorage", { getItem: () => "web-token" });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ prompt: "optimized" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(optimizePrompt("a cat")).resolves.toEqual({ prompt: "optimized" });
    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/prompt/optimize",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ prompt: "a cat" }) }),
    );
  });

  it("surfaces optimizer errors (e.g. 429 rate limit)", async () => {
    vi.stubGlobal("localStorage", { getItem: () => "web-token" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: "提示词优化上游 rate limited" } }), {
          status: 429,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await expect(optimizePrompt("a cat")).rejects.toThrow("rate limited");
  });
});

describe("createUpscaleJob", () => {
  it("posts multipart image, scale and response format to the upscale endpoint", async () => {
    vi.stubGlobal("localStorage", { getItem: () => "web-token" });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ jobId: "upscale-job-1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const form = new FormData();
    form.append("image", new File(["image"], "source.png", { type: "image/png" }));
    form.append("scale", "4");
    form.append("response_format", "url");

    await expect(createUpscaleJob(form)).resolves.toEqual({ jobId: "upscale-job-1" });
    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/images/upscale-jobs",
      expect.objectContaining({ method: "POST", body: form, headers: { authorization: "Bearer web-token" } }),
    );
  });

  it("surfaces upscale validation errors", async () => {
    vi.stubGlobal("localStorage", { getItem: () => "web-token" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: "'scale' must be 2 or 4" } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await expect(createUpscaleJob(new FormData())).rejects.toThrow("'scale' must be 2 or 4");
  });
});

describe("createEditJob", () => {
  it("posts multipart data to the detached edit-job endpoint", async () => {
    vi.stubGlobal("localStorage", { getItem: () => "web-token" });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ jobId: "job-1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const form = new FormData();
    form.append("prompt", "add an airship");

    await expect(createEditJob(form)).resolves.toEqual({ jobId: "job-1" });
    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/images/edit-jobs",
      expect.objectContaining({
        method: "POST",
        body: form,
        headers: { authorization: "Bearer web-token" },
      }),
    );
  });

  it("surfaces edit-job validation errors", async () => {
    vi.stubGlobal("localStorage", { getItem: () => "web-token" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: "'image' file is required" } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await expect(createEditJob(new FormData())).rejects.toThrow("'image' file is required");
  });

  it("clears an expired token and redirects to login", async () => {
    const removeItem = vi.fn();
    const assign = vi.fn();
    vi.stubGlobal("localStorage", { getItem: () => "expired-token", removeItem });
    vi.stubGlobal("window", { location: { pathname: "/", assign } });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: "invalid token" } }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await expect(createEditJob(new FormData())).rejects.toThrow("invalid token");
    expect(removeItem).toHaveBeenCalledWith("tiny-admin-token");
    expect(assign).toHaveBeenCalledWith("/login");
  });
});

describe("application settings API", () => {
  it("fetches and saves settings with authentication", async () => {
    vi.stubGlobal("localStorage", { getItem: () => "web-token" });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ globalPrompt: "", announcement: "", announcementVersion: 0 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ globalPrompt: "style", announcement: "hello", announcementVersion: 1 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchSettings()).resolves.toMatchObject({ announcementVersion: 0 });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/admin/settings",
      expect.objectContaining({ method: "GET", headers: expect.objectContaining({ authorization: "Bearer web-token" }) }),
    );

    await expect(saveSettings({ globalPrompt: "style", announcement: "hello" })).resolves.toMatchObject({ announcementVersion: 1 });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/admin/settings",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ globalPrompt: "style", announcement: "hello" }),
        headers: expect.objectContaining({ authorization: "Bearer web-token" }),
      }),
    );
  });

  it("fetches the current announcement", async () => {
    vi.stubGlobal("localStorage", { getItem: () => "web-token" });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ announcement: "hello", version: 2 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchAnnouncement()).resolves.toEqual({ announcement: "hello", version: 2 });
    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/announcement",
      expect.objectContaining({ method: "GET", headers: expect.objectContaining({ authorization: "Bearer web-token" }) }),
    );
  });
});
