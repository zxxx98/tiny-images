/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as apiModule from "../api";
import { PRESETS_KEY } from "./presets";
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

describe("Playground parameter presets", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    vi.spyOn(apiModule, "api").mockImplementation(async (path: string) => {
      if (path === "/v1/models")
        return { data: [{ id: "image-model" }, { id: "fast-model" }] } as never;
      throw new Error(`unexpected API: ${path}`);
    });
    vi.spyOn(apiModule, "fetchAnnouncement").mockResolvedValue({ announcement: "", version: 0 });
    vi.spyOn(apiModule, "fetchFeatures").mockResolvedValue({ upscale: false, promptOptimizer: false, promptReverse: false });
    vi.spyOn(apiModule, "fetchFavorites").mockResolvedValue([]);
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
  }

  function seedPreset(): void {
    localStorage.setItem(
      PRESETS_KEY,
      JSON.stringify([
        { id: "p-seed", name: "横版快速", params: { model: "fast-model", n: 2, size: "1792x1024", responseFormat: "url", extra: '{"quality":"medium"}' } },
      ]),
    );
  }

  it("applies a preset to the form controls", async () => {
    seedPreset();
    await renderPlayground();

    const select = container.querySelector("#pg-preset") as HTMLSelectElement;
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
      setValue.call(select, "p-seed");
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await flush();
    });

    expect((container.querySelector("#pg-model") as HTMLSelectElement).value).toBe("fast-model");
    expect((container.querySelector("#pg-n") as HTMLInputElement).value).toBe("2");
    expect((container.querySelector("#pg-size") as HTMLSelectElement).value).toBe("1792x1024");
    expect((container.querySelector("#pg-rf") as HTMLSelectElement).value).toBe("url");
    expect(container.querySelector('textarea[aria-label="高级参数 JSON"]')!.textContent).toBe('{"quality":"medium"}');
    expect(button(container, "删除预设")).toBeTruthy();
  });

  it("saves the current form as a new preset", async () => {
    await renderPlayground();
    vi.spyOn(window, "prompt").mockReturnValue("我的预设");

    await act(async () => button(container, "存为预设").click());
    await flush();

    const stored = JSON.parse(localStorage.getItem(PRESETS_KEY)!) as { name: string; params: Record<string, unknown> }[];
    expect(stored.length).toBe(1);
    expect(stored[0].name).toBe("我的预设");
    expect(stored[0].params.model).toBe("image-model");
    const select = container.querySelector("#pg-preset") as HTMLSelectElement;
    expect(select.value).not.toBe("");
  });

  it("does not save when the name dialog is cancelled", async () => {
    await renderPlayground();
    vi.spyOn(window, "prompt").mockReturnValue(null);

    await act(async () => button(container, "存为预设").click());
    await flush();

    expect(localStorage.getItem(PRESETS_KEY)).toBeNull();
  });

  it("deletes the selected preset", async () => {
    seedPreset();
    await renderPlayground();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const select = container.querySelector("#pg-preset") as HTMLSelectElement;
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
      setValue.call(select, "p-seed");
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await flush();
    });

    await act(async () => button(container, "删除预设").click());
    await flush();

    expect(localStorage.getItem(PRESETS_KEY)).toBe("[]");
    expect((container.querySelector("#pg-preset") as HTMLSelectElement).textContent).toContain("暂无预设");
  });
});
