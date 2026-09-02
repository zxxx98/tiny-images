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

describe("Playground result lightbox", () => {
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
    vi.spyOn(apiModule, "fetchFeatures").mockResolvedValue({ upscale: false, promptOptimizer: false, promptReverse: false });
    vi.spyOn(apiModule, "fetchMe").mockResolvedValue({
      role: "user",
      email: "user@example.test",
      quotaTotal: null,
      quotaUsed: 0,
      quotaRemaining: null,
    });
    Object.defineProperty(window, "scrollTo", { configurable: true, value: vi.fn() });
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => `blob:preview-${++objectUrl}`) });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("image", { headers: { "Content-Type": "image/png" } })),
    );
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function renderWithResult(): Promise<void> {
    vi.spyOn(apiModule, "createJob").mockResolvedValue({ jobId: "job-1" });
    vi.spyOn(apiModule, "fetchJob").mockResolvedValue({
      kind: "generate",
      status: "ok",
      progress: null,
      channel: null,
      latencyMs: 100,
      error: null,
      createdAt: 1,
      images: [{ file: "cat.png", url: "/files/cat.png" }],
    });

    await act(async () => {
      root.render(<MemoryRouter><Playground /></MemoryRouter>);
      await flush();
    });

    const form = container.querySelector("form") as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await flush();
    });
  }

  it("opens a lightbox when clicking a result image and closes on click or Escape", async () => {
    await renderWithResult();

    const result = container.querySelector('.gallery img[alt="生成结果 1"]') as HTMLImageElement;
    expect(result).not.toBeNull();
    expect(container.querySelector(".lightbox")).toBeNull();

    await act(async () => result.click());
    const lightbox = container.querySelector(".lightbox img") as HTMLImageElement;
    expect(lightbox).not.toBeNull();
    expect(lightbox.getAttribute("src")).toBe("/files/cat.png");

    await act(async () => (lightbox.closest(".lightbox") as HTMLDivElement).click());
    expect(container.querySelector(".lightbox")).toBeNull();

    await act(async () => result.click());
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(container.querySelector(".lightbox")).toBeNull();
  });

  it("keeps edit on the explicit button instead of the image click", async () => {
    await renderWithResult();

    const result = container.querySelector(".gallery img") as HTMLImageElement;
    await act(async () => result.click());

    // 点击图片只开灯箱，不进入编辑模式
    expect(container.querySelector(".lightbox")).not.toBeNull();
    expect(container.textContent).not.toContain("蒙版 mask");
    await act(async () => (container.querySelector(".lightbox") as HTMLDivElement).click());

    const edit = Array.from(container.querySelectorAll(".shot-actions button")).find((item) => item.textContent?.trim() === "编辑") as HTMLButtonElement;
    await act(async () => edit.click());
    expect(container.textContent).toContain("蒙版 mask");
    expect(container.querySelector(".lightbox")).toBeNull();
  });
});
