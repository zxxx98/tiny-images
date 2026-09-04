/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as apiModule from "../api";
import type { OfficialTemplate } from "../api";
import TemplateLibrary from "./TemplateLibrary";

const OFFICIAL: OfficialTemplate[] = [
  { id: 1, type: "text2image", name: "极简线条狼", prompt: "minimal line-art wolf tattoo", exampleImage: "/files/templates/a.png", exampleBefore: null, exampleAfter: null, mine: false },
  { id: 2, type: "text2image", name: "纯文字模板", prompt: "blackwork snake", exampleImage: null, exampleBefore: null, exampleAfter: null, mine: false },
  { id: 3, type: "image2image", name: "风格化纹身", prompt: "turn this into a tattoo", exampleImage: null, exampleBefore: "/files/templates/b.png", exampleAfter: "/files/templates/c.png", mine: false },
];

const MINE: OfficialTemplate = { id: 9, type: "text2image", name: "我的模板", prompt: "my own prompt", exampleImage: null, exampleBefore: null, exampleAfter: null, mine: true };

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll("button")).find((item) => item.textContent?.trim() === label);
  if (!found) throw new Error(`button not found: ${label}`);
  return found;
}

// React 受控输入必须经原生 setter 赋值，否则内部 value tracker 会吞掉 change
function setInputValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("TemplateLibrary dialog", () => {
  let container: HTMLDivElement;
  let root: Root;
  let onSelect: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    onSelect = vi.fn();
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.spyOn(apiModule, "fetchTemplates").mockResolvedValue(OFFICIAL);
    // 录入时把捕获图片转成 File 的过程在单测里直接桩掉，避免真实 fetch
    vi.spyOn(apiModule, "fetchImageAsFile").mockImplementation(async (url: string) => {
      const ext = url.includes("before") ? "before" : url.includes("after") ? "after" : "example";
      return new File([new Uint8Array([1, 2, 3])], `template-${ext}.png`, { type: "image/png" });
    });
    Object.defineProperty(window, "confirm", { configurable: true, value: vi.fn(() => true) });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  async function renderLibrary(props: Partial<Parameters<typeof TemplateLibrary>[0]> = {}): Promise<void> {
    await act(async () => {
      root.render(<TemplateLibrary onClose={() => undefined} onSelect={onSelect} {...props} />);
      await flush();
    });
  }

  it("groups templates by type with example images; official templates have no delete button", async () => {
    await renderLibrary();

    expect(container.querySelector('[role="dialog"]')?.textContent).toContain("文生图（2）");
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain("图生图（1）");
    expect(container.querySelector('img[alt="极简线条狼 生成示例"]')).not.toBeNull();
    expect(container.textContent).toContain("暂无生成示例图");
    expect(container.querySelector(".template-prompt")?.textContent).toBe("minimal line-art wolf tattoo");
    // 官方模板标记
    expect(container.textContent).toContain("官方");

    const deleteButtons = Array.from(container.querySelectorAll("button")).filter((b) => b.textContent?.trim() === "删除");
    expect(deleteButtons).toHaveLength(0);
  });

  it("shows before/after examples for image2image templates", async () => {
    await renderLibrary();
    await act(async () => {
      button(container, "图生图（1）").click();
      await flush();
    });
    expect(container.querySelector('img[alt="风格化纹身 生成前示例"]')).not.toBeNull();
    expect(container.querySelector('img[alt="风格化纹身 生成后示例"]')).not.toBeNull();
  });

  it("emits the selected template", async () => {
    await renderLibrary();
    await act(async () => {
      button(container, "用此模板生成").click();
      await flush();
    });
    expect(onSelect).toHaveBeenCalledWith(OFFICIAL[0]);
  });

  it("lets users delete their own templates but never official ones", async () => {
    vi.spyOn(apiModule, "fetchTemplates").mockResolvedValue([...OFFICIAL, MINE]);
    const deleteSpy = vi.spyOn(apiModule, "deleteMyTemplate").mockResolvedValue(undefined);
    await renderLibrary();

    const mineCard = Array.from(container.querySelectorAll(".template-card")).find((c) => c.textContent?.includes("我的模板"));
    expect(mineCard?.textContent).toContain("我的");
    const deleteButton = Array.from(mineCard!.querySelectorAll("button")).find((b) => b.textContent?.trim() === "删除")!;
    await act(async () => {
      deleteButton.click();
      await flush();
    });
    expect(window.confirm).toHaveBeenCalled();
    expect(deleteSpy).toHaveBeenCalledWith(9);
    expect(apiModule.deleteMyTemplate).toHaveBeenCalledTimes(1);
  });

  it("creates a text template without images when nothing was generated", async () => {
    const createSpy = vi.spyOn(apiModule, "createMyTemplate").mockResolvedValue({ ...MINE, id: 10, name: "新模板" });
    await renderLibrary({ initialPrompt: "wolf prompt" });

    await act(async () => {
      button(container, "录入模板").click();
      await flush();
    });
    expect(container.textContent).toContain("当前没有已生成的图片，将只录入文字模板。");
    await act(async () => {
      setInputValue(container.querySelector("#mytpl-name") as HTMLInputElement, "新模板");
      setInputValue(container.querySelector("#mytpl-prompt") as HTMLTextAreaElement, "wolf prompt");
      await flush();
    });
    await act(async () => {
      button(container, "录入模板").click();
      await flush();
    });
    expect(createSpy).toHaveBeenCalledTimes(1);
    const form = createSpy.mock.calls[0][0] as FormData;
    expect(form.get("type")).toBe("text2image");
    expect(form.get("name")).toBe("新模板");
    expect(form.get("prompt")).toBe("wolf prompt");
    expect(form.get("image")).toBeNull();
    expect(container.textContent).toContain("模板已录入（未生成图片，仅录入文字）");
  });

  it("includes the generated image when recording a template after generation", async () => {
    const createSpy = vi.spyOn(apiModule, "createMyTemplate").mockResolvedValue(MINE);
    await renderLibrary({
      initialPrompt: "wolf prompt",
      capture: { generated: "/files/templates/gen.png", source: null },
    });

    await act(async () => {
      button(container, "录入模板").click();
      await flush();
    });
    expect(container.querySelector('img[alt="将录入的生成示例"]')).not.toBeNull();
    await act(async () => {
      setInputValue(container.querySelector("#mytpl-name") as HTMLInputElement, "带图模板");
      await flush();
    });
    await act(async () => {
      button(container, "录入模板").click();
      await flush();
    });
    expect(createSpy).toHaveBeenCalledTimes(1);
    const form = createSpy.mock.calls[0][0] as FormData;
    expect(form.get("image")).toBeInstanceOf(File);
    expect(container.textContent).toContain("模板已录入（连同示例图片，保存后图片不可删除）");
  });

  it("captures before/after images for image2image templates in edit mode", async () => {
    const createSpy = vi.spyOn(apiModule, "createMyTemplate").mockResolvedValue(MINE);
    await renderLibrary({
      capture: { generated: "/files/templates/gen.png", source: "blob:source" },
    });

    await act(async () => {
      button(container, "录入模板").click();
      await flush();
    });
    // 默认类型为文生图，先切到图生图
    const typeSelect = container.querySelector("#mytpl-type") as HTMLSelectElement;
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
      setValue.call(typeSelect, "image2image");
      typeSelect.dispatchEvent(new Event("change", { bubbles: true }));
      await flush();
    });
    expect(container.querySelector('img[alt="将录入的生成前示例"]')).not.toBeNull();
    expect(container.querySelector('img[alt="将录入的生成后示例"]')).not.toBeNull();
    await act(async () => {
      setInputValue(container.querySelector("#mytpl-name") as HTMLInputElement, "前后对比");
      setInputValue(container.querySelector("#mytpl-prompt") as HTMLTextAreaElement, "turn this into a tattoo");
      await flush();
    });
    await act(async () => {
      button(container, "录入模板").click();
      await flush();
    });
    expect(createSpy).toHaveBeenCalledTimes(1);
    const form = createSpy.mock.calls[0][0] as FormData;
    expect(form.get("type")).toBe("image2image");
    expect(form.get("before")).toBeInstanceOf(File);
    expect(form.get("after")).toBeInstanceOf(File);
    expect(form.get("image")).toBeNull();
  });
});
