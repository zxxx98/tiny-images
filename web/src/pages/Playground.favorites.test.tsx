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

async function typePrompt(container: HTMLElement, text: string): Promise<void> {
  const prompt = container.querySelector("#pg-prompt") as HTMLTextAreaElement;
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => {
    setValue.call(prompt, text);
    prompt.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
  });
}

describe("Playground prompt favorites", () => {
  let container: HTMLDivElement;
  let root: Root;
  let favorites: apiModule.PromptFavorite[];

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    favorites = [
      { id: 1, content: "一只橘猫在窗台晒太阳", createdAt: 1 },
      { id: 2, content: "a corgi running on the grass", createdAt: 2 },
    ];
    vi.spyOn(apiModule, "api").mockImplementation(async (path: string) => {
      if (path === "/v1/models") return { data: [{ id: "image-model" }] } as never;
      throw new Error(`unexpected API: ${path}`);
    });
    vi.spyOn(apiModule, "fetchAnnouncement").mockResolvedValue({ announcement: "", version: 0 });
    vi.spyOn(apiModule, "fetchFeatures").mockResolvedValue({ upscale: false, promptOptimizer: false, promptReverse: false });
    vi.spyOn(apiModule, "fetchFavorites").mockImplementation(async () => favorites);
    vi.spyOn(apiModule, "addFavorite").mockImplementation(async (prompt: string) => {
      const row = { id: favorites.length + 10, content: prompt, createdAt: 3 };
      favorites = [row, ...favorites];
      return row;
    });
    vi.spyOn(apiModule, "deleteFavorite").mockImplementation(async (id: number) => {
      favorites = favorites.filter((f) => f.id !== id);
    });
    Object.defineProperty(window, "scrollTo", { configurable: true, value: vi.fn() });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  async function renderPlayground(): Promise<void> {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <Playground />
        </MemoryRouter>,
      );
      await flush();
    });
    const summary = Array.from(container.querySelectorAll("summary")).find((s) => s.textContent?.includes("收藏夹"))! as HTMLElement;
    await act(async () => summary.click());
    await flush();
  }

  it("lists favorites and fills the prompt when one is clicked", async () => {
    await renderPlayground();
    expect(container.textContent).toContain("收藏夹（2）");
    expect(container.textContent).toContain("一只橘猫在窗台晒太阳");

    const item = Array.from(container.querySelectorAll<HTMLElement>(".favorite-content")).find(
      (b) => b.textContent === "一只橘猫在窗台晒太阳",
    )!;
    await act(async () => item.click());
    await flush();
    expect((container.querySelector("#pg-prompt") as HTMLTextAreaElement).value).toBe("一只橘猫在窗台晒太阳");
  });

  it("saves the current prompt via the favorite button", async () => {
    await renderPlayground();
    await typePrompt(container, "neon skyline at night");

    await act(async () => button(container, "收藏").click());
    await flush();

    expect(apiModule.addFavorite).toHaveBeenCalledWith("neon skyline at night");
    expect(container.textContent).toContain("收藏夹（3）");
    expect(container.textContent).toContain("neon skyline at night");
  });

  it("deletes a favorite from the list", async () => {
    await renderPlayground();
    expect(container.textContent).toContain("收藏夹（2）");

    const del = Array.from(container.querySelectorAll(".favorite-list .link.danger"))[0] as HTMLButtonElement;
    await act(async () => del.click());
    await flush();

    expect(apiModule.deleteFavorite).toHaveBeenCalledWith(1);
    expect(container.textContent).toContain("收藏夹（1）");
    expect(container.textContent).not.toContain("一只橘猫在窗台晒太阳");
  });

  it("disables the favorite button with an empty prompt", async () => {
    await renderPlayground();
    expect(button(container, "收藏").disabled).toBe(true);
  });
});
