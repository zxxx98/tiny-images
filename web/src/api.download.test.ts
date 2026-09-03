/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadImage, saveMyWatermark } from "./api";

const FILE_URL = "/files/abababababababababababababababab.png";

function stubAnchor(): { click: ReturnType<typeof vi.fn>; href: string; download: string } {
  const anchor = { click: vi.fn(), href: "", download: "" };
  vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
    if (tag === "a") return anchor as unknown as HTMLAnchorElement;
    return document.createElementNS(null, tag);
  }) as unknown as typeof document.createElement);
  return anchor;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (URL as unknown as { createObjectURL?: unknown }).createObjectURL;
  delete (URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL;
});

function stubObjectUrls(): { createObjectURL: ReturnType<typeof vi.fn>; revokeObjectURL: ReturnType<typeof vi.fn> } {
  const createObjectURL = vi.fn(() => "blob:download");
  const revokeObjectURL = vi.fn();
  // jsdom 未实现 createObjectURL，与 Playground 缩放测试同样用 defineProperty 打桩
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });
  return { createObjectURL, revokeObjectURL };
}

describe("saveMyWatermark", () => {
  it("saves the user watermark with authentication", async () => {
    vi.stubGlobal("localStorage", { getItem: () => "web-token" });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ enabled: true, text: "张三" }), { status: 200, headers: { "content-type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(saveMyWatermark({ enabled: true, text: "张三" })).resolves.toEqual({ enabled: true, text: "张三" });
    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/watermark",
      expect.objectContaining({
        method: "PUT",
        headers: expect.objectContaining({ authorization: "Bearer web-token" }),
      }),
    );
  });
});

describe("downloadImage", () => {
  it("routes /files results through the authed download endpoint", async () => {
    vi.stubGlobal("localStorage", { getItem: () => "web-token" });
    const fetchMock = vi.fn().mockResolvedValue(new Response("png-bytes", { status: 200, headers: { "content-type": "image/png" } }));
    vi.stubGlobal("fetch", fetchMock);
    const { createObjectURL, revokeObjectURL } = stubObjectUrls();
    const anchor = stubAnchor();

    await downloadImage(FILE_URL, "tiny-images-1-1.png");
    expect(fetchMock).toHaveBeenCalledWith(
      `/v1/download/${FILE_URL.slice("/files/".length)}`,
      expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer web-token" }) }),
    );
    expect(anchor.href).toBe("blob:download");
    expect(anchor.download).toBe("tiny-images-1-1.png");
    expect(anchor.click).toHaveBeenCalled();
    expect(createObjectURL).toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:download");
  });

  it("falls back to a plain anchor for non /files urls", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const anchor = stubAnchor();

    await downloadImage("https://upstream.example/img.png", "tiny-images-x.png");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(anchor.href).toBe("https://upstream.example/img.png");
    expect(anchor.download).toBe("tiny-images-x.png");
    expect(anchor.click).toHaveBeenCalled();
  });

  it("throws an ApiError when the download endpoint fails", async () => {
    vi.stubGlobal("localStorage", { getItem: () => "web-token" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: "file not found" } }), { status: 404 })));
    stubObjectUrls();
    stubAnchor();

    await expect(downloadImage(FILE_URL, "x.png")).rejects.toMatchObject({ status: 404 });
  });
});
