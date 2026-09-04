/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as apiModule from "../api";
import type { OfficialTemplate } from "../api";
import Playground from "./Playground";

const TEMPLATES: OfficialTemplate[] = [
  { id: 1, type: "text2image", name: "极简线条狼", prompt: "minimal line-art wolf tattoo", exampleImage: null, exampleBefore: null, exampleAfter: null, mine: false },
  { id: 2, type: "image2image", name: "风格化纹身", prompt: "turn this into a tattoo", exampleImage: null, exampleBefore: null, exampleAfter: null, mine: false },
];

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll("button")).find((item) => item.textContent?.trim() === label);
  if (!found) throw new Error(`button not found: ${label}`);
  return found;
}

describe("Playground template library", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    vi.spyOn(apiModule, "api").mockImplementation(async (path: string) => {
      if (path === "/v1/models") return { data: [{ id: "edit-model", supportsImageToImage: true }] } as never;
      throw new Error(`unexpected API: ${path}`);
    });
    vi.spyOn(apiModule, "fetchAnnouncement").mockResolvedValue({ announcement: "", version: 0 });
    vi.spyOn(apiModule, "fetchFeatures").mockResolvedValue({ upscale: false, promptOptimizer: false, promptReverse: false });
    vi.spyOn(apiModule, "fetchFavorites").mockResolvedValue([]);
    vi.spyOn(apiModule, "fetchTemplates").mockResolvedValue(TEMPLATES);
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

  function promptTextarea(): HTMLTextAreaElement {
    return container.querySelector("#pg-prompt") as HTMLTextAreaElement;
  }

  it("opens the library and fills the prompt from a text2image template", async () => {
    await renderPlayground();
    await act(async () => {
      button(container, "模板库").click();
      await flush();
    });
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain("文生图（1）");
    await act(async () => {
      button(container, "用此模板生成").click();
      await flush();
    });
    expect(promptTextarea().value).toBe("minimal line-art wolf tattoo");
    // 弹窗已关闭
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("switches to edit mode when applying an image2image template", async () => {
    await renderPlayground();
    await act(async () => {
      button(container, "模板库").click();
      await flush();
    });
    await act(async () => {
      button(container, "图生图（1）").click();
      await flush();
    });
    await act(async () => {
      button(container, "用此模板编辑").click();
      await flush();
    });
    expect(promptTextarea().value).toBe("turn this into a tattoo");
    // 图片编辑模式被激活
    const editButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "图片编辑",
    ) as HTMLButtonElement;
    expect(editButton.getAttribute("aria-pressed")).toBe("true");
  });

  it("switches back to generate mode when applying a text2image template from edit mode", async () => {
    await renderPlayground();
    await act(async () => {
      button(container, "图片编辑").click();
      await flush();
    });
    await act(async () => {
      button(container, "模板库").click();
      await flush();
    });
    await act(async () => {
      button(container, "用此模板生成").click();
      await flush();
    });
    expect(promptTextarea().value).toBe("minimal line-art wolf tattoo");
    // 文生图模板把用户带回文生图模式
    const editButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "图片编辑",
    ) as HTMLButtonElement;
    expect(editButton.getAttribute("aria-pressed")).toBe("false");
  });
});
