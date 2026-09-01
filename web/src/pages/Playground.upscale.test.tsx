/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as apiModule from "../api";
import Playground from "./Playground";

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll("button")).find((item) => item.textContent?.trim() === label);
  if (!found) throw new Error(`button not found: ${label}`);
  return found;
}

describe("Playground upscale mode", () => {
  let container: HTMLDivElement;
  let root: Root;
  let objectUrl = 0;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    vi.spyOn(apiModule, "api").mockImplementation(async (path: string) => {
      if (path === "/v1/models") return { data: [{ id: "image-model", supportsImageToImage: true }] } as never;
      throw new Error(`unexpected API: ${path}`);
    });
    vi.spyOn(apiModule, "fetchAnnouncement").mockResolvedValue({ announcement: "", version: 0 });
    vi.spyOn(apiModule, "fetchFeatures").mockResolvedValue({ upscale: true });
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => `blob:preview-${++objectUrl}`) });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    Object.defineProperty(window, "scrollTo", { configurable: true, value: vi.fn() });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("feature-gates the third top-level mode", async () => {
    vi.mocked(apiModule.fetchFeatures).mockResolvedValueOnce({ upscale: false });

    await act(async () => {
      root.render(<MemoryRouter><Playground /></MemoryRouter>);
      await flush();
    });

    expect(container.textContent).toContain("文生图");
    expect(container.textContent).toContain("图片编辑");
    expect(container.textContent).not.toContain("图片超分");
  });

  it("shows only single-image upload, preview and scale in upscale mode", async () => {
    await act(async () => {
      root.render(<MemoryRouter><Playground /></MemoryRouter>);
      await flush();
    });

    await act(async () => button(container, "图片超分").click());
    expect(container.querySelector("#pg-upscale-image")).not.toBeNull();
    expect(container.querySelector("#pg-upscale-scale")).not.toBeNull();
    expect(container.querySelector("#pg-prompt")).toBeNull();
    expect(container.querySelector("#pg-model")).toBeNull();
    expect(container.querySelector("#pg-n")).toBeNull();
    expect(container.querySelector("#pg-size")).toBeNull();
    expect(container.textContent).not.toContain("高级参数");

    const file = new File(["image"], "source.png", { type: "image/png" });
    const input = container.querySelector("#pg-upscale-image") as HTMLInputElement;
    await act(async () => {
      Object.defineProperty(input, "files", { configurable: true, value: [file] });
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await flush();
    });
    expect(container.querySelector('img[alt="超分原图：source.png"]')).not.toBeNull();
  });

  it("submits one image with scale and uses one upscale placeholder", async () => {
    const create = vi.spyOn(apiModule, "createUpscaleJob").mockResolvedValue({ jobId: "upscale-job-1" });
    vi.spyOn(apiModule, "fetchJob").mockResolvedValue({
      kind: "upscale",
      status: "running",
      progress: null,
      channel: null,
      latencyMs: null,
      error: null,
      createdAt: 1,
      images: [],
    });

    await act(async () => {
      root.render(<MemoryRouter><Playground /></MemoryRouter>);
      await flush();
    });
    await act(async () => button(container, "图片超分").click());

    const file = new File(["image"], "source.png", { type: "image/png" });
    const input = container.querySelector("#pg-upscale-image") as HTMLInputElement;
    const scale = container.querySelector("#pg-upscale-scale") as HTMLSelectElement;
    await act(async () => {
      Object.defineProperty(input, "files", { configurable: true, value: [file] });
      input.dispatchEvent(new Event("change", { bubbles: true }));
      scale.value = "4";
      scale.dispatchEvent(new Event("change", { bubbles: true }));
      await flush();
      (input.closest("form") as HTMLFormElement).dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await flush();
    });

    expect(create).toHaveBeenCalledTimes(1);
    const submitted = create.mock.calls[0][0];
    expect((submitted.get("image") as File).name).toBe("source.png");
    expect(submitted.get("scale")).toBe("4");
    expect(submitted.get("response_format")).toBe("url");
    expect(container.querySelectorAll(".loading-tile")).toHaveLength(1);
    expect(container.textContent).toContain("正在进行 AI 超分");
  });

  it("prefills from history at 2x without auto-submitting", async () => {
    const imageFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      blob: async () => new File(["image"], "download.webp", { type: "image/webp" }),
    });
    vi.stubGlobal("fetch", imageFetch);
    const create = vi.spyOn(apiModule, "createUpscaleJob");

    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={[{ pathname: "/", state: { upscaleImageUrl: "/files/source.webp" } }]}>
          <Playground />
        </MemoryRouter>,
      );
      await flush();
      await flush();
    });

    expect(imageFetch).toHaveBeenCalledWith("/files/source.webp");
    expect((container.querySelector("#pg-upscale-scale") as HTMLSelectElement).value).toBe("2");
    expect(container.querySelector('img[alt="超分原图：upscale-src.webp"]')).not.toBeNull();
    expect(create).not.toHaveBeenCalled();
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 0 });
  });

  it("keeps current results and mode when result prefill fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("missing", { status: 404 })));
    vi.spyOn(apiModule, "createJob").mockResolvedValue({ jobId: "generate-job-1" });
    vi.spyOn(apiModule, "fetchJob").mockResolvedValue({
      kind: "generate",
      status: "ok",
      progress: null,
      channel: "channel",
      latencyMs: 10,
      error: null,
      createdAt: 1,
      images: [{ file: "result.png", url: "/files/result.png" }],
    });

    await act(async () => {
      root.render(<MemoryRouter><Playground /></MemoryRouter>);
      await flush();
    });
    const prompt = container.querySelector("#pg-prompt") as HTMLTextAreaElement;
    await act(async () => {
      prompt.value = "cat";
      prompt.dispatchEvent(new Event("input", { bubbles: true }));
      prompt.dispatchEvent(new Event("change", { bubbles: true }));
      await flush();
      (prompt.closest("form") as HTMLFormElement).dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await flush();
    });
    const result = container.querySelector('img[src="/files/result.png"]');
    expect(result).not.toBeNull();

    await act(async () => {
      const action = Array.from(container.querySelectorAll(".shot-actions button")).find((item) => item.textContent?.trim() === "超分") as HTMLButtonElement;
      action.click();
      await flush();
    });

    expect(container.querySelector('img[src="/files/result.png"]')).not.toBeNull();
    expect(button(container, "文生图").getAttribute("aria-pressed")).toBe("true");
    expect(container.textContent).toContain("载入图片到超分模式失败：HTTP 404");
  });
});
