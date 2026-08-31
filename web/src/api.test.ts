import { afterEach, describe, expect, it, vi } from "vitest";
import { createEditJob } from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
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
});
