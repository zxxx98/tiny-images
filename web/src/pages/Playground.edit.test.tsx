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

describe("Playground edit mode", () => {
  let container: HTMLDivElement;
  let root: Root;
  let objectUrl = 0;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    vi.spyOn(apiModule, "fetchAnnouncement").mockResolvedValue({ announcement: "", version: 0 });
    vi.spyOn(apiModule, "fetchFeatures").mockResolvedValue({ upscale: false, promptOptimizer: false });
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => `blob:preview-${++objectUrl}`) });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    Object.defineProperty(window, "scrollTo", { configurable: true, value: vi.fn() });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("auto-selects an image-to-image model when entering edit from history", async () => {
    vi.spyOn(apiModule, "api").mockImplementation(async (path: string) => {
      if (path === "/v1/models") {
        return { data: [{ id: "text-model" }, { id: "edit-model", supportsImageToImage: true }] } as never;
      }
      throw new Error(`unexpected API: ${path}`);
    });
    const imageFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      blob: async () => new File(["image"], "source.png", { type: "image/png" }),
    });
    vi.stubGlobal("fetch", imageFetch);

    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={[{ pathname: "/", state: { editImageUrl: "/files/source.png" } }]}>
          <Playground />
        </MemoryRouter>,
      );
      await flush();
      await flush();
    });

    expect(imageFetch).toHaveBeenCalledWith("/files/source.png");
    expect((container.querySelector("#pg-model") as HTMLSelectElement).value).toBe("edit-model");
    expect(button(container, "图片编辑").getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector("#pg-edit-image")).not.toBeNull();
    expect(container.querySelector('img[alt="原图 1：edit-src.png"]')).not.toBeNull();
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 0 });
  });

  it("switches to an image-to-image model when the edit tab is clicked", async () => {
    vi.spyOn(apiModule, "api").mockImplementation(async (path: string) => {
      if (path === "/v1/models") {
        return { data: [{ id: "text-model" }, { id: "edit-model", supportsImageToImage: true }] } as never;
      }
      throw new Error(`unexpected API: ${path}`);
    });

    await act(async () => {
      root.render(<MemoryRouter><Playground /></MemoryRouter>);
      await flush();
    });

    const tab = button(container, "图片编辑");
    expect(tab.disabled).toBe(false);
    await act(async () => tab.click());

    expect(tab.getAttribute("aria-pressed")).toBe("true");
    expect((container.querySelector("#pg-model") as HTMLSelectElement).value).toBe("edit-model");
    expect(container.querySelector("#pg-edit-image")).not.toBeNull();
  });

  it("stays in generate mode with a hint when no model supports image-to-image", async () => {
    vi.spyOn(apiModule, "api").mockImplementation(async (path: string) => {
      if (path === "/v1/models") {
        return { data: [{ id: "text-model" }] } as never;
      }
      throw new Error(`unexpected API: ${path}`);
    });
    const imageFetch = vi.fn();
    vi.stubGlobal("fetch", imageFetch);

    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={[{ pathname: "/", state: { editImageUrl: "/files/source.png" } }]}>
          <Playground />
        </MemoryRouter>,
      );
      await flush();
      await flush();
    });

    expect(button(container, "文生图").getAttribute("aria-pressed")).toBe("true");
    expect(button(container, "图片编辑").disabled).toBe(true);
    expect(container.textContent).toContain("当前模型不支持图生图");
    expect(imageFetch).not.toHaveBeenCalled();
  });
});
