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

describe("Playground prompt optimizer", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    vi.spyOn(apiModule, "api").mockImplementation(async (path: string) => {
      if (path === "/v1/models") return { data: [{ id: "image-model" }] } as never;
      throw new Error(`unexpected API: ${path}`);
    });
    vi.spyOn(apiModule, "fetchAnnouncement").mockResolvedValue({ announcement: "", version: 0 });
    vi.spyOn(apiModule, "fetchFeatures").mockResolvedValue({ upscale: false, promptOptimizer: true });
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

  it("hides the optimize button when the feature is disabled", async () => {
    vi.mocked(apiModule.fetchFeatures).mockResolvedValueOnce({ upscale: false, promptOptimizer: false });
    await renderPlayground();
    expect(container.querySelector("#pg-prompt")).not.toBeNull();
    expect(container.textContent).not.toContain("AI 优化");
  });

  it("replaces the prompt with the optimized text and supports undo", async () => {
    vi.spyOn(apiModule, "optimizePrompt").mockResolvedValue({ prompt: "一只橘猫在窗台晒太阳，电影感光线" });
    await renderPlayground();
    await typePrompt(container, "橘猫 晒太阳");

    await act(async () => button(container, "AI 优化").click());
    await flush();

    const optimize = vi.mocked(apiModule.optimizePrompt);
    expect(optimize).toHaveBeenCalledWith("橘猫 晒太阳");
    expect((container.querySelector("#pg-prompt") as HTMLTextAreaElement).value).toBe("一只橘猫在窗台晒太阳，电影感光线");
    expect(container.textContent).toContain("撤销");

    await act(async () => button(container, "撤销").click());
    await flush();
    expect((container.querySelector("#pg-prompt") as HTMLTextAreaElement).value).toBe("橘猫 晒太阳");
    expect(container.textContent).not.toContain("撤销");
  });

  it("clears the undo snapshot when the prompt is edited manually", async () => {
    vi.spyOn(apiModule, "optimizePrompt").mockResolvedValue({ prompt: "optimized text" });
    await renderPlayground();
    await typePrompt(container, "draft");

    await act(async () => button(container, "AI 优化").click());
    await flush();
    expect(container.textContent).toContain("撤销");

    await typePrompt(container, "edited by hand");
    expect(container.textContent).not.toContain("撤销");
  });

  it("shows an error and keeps the prompt when optimization fails", async () => {
    vi.spyOn(apiModule, "optimizePrompt").mockRejectedValue(new Error("rate limited"));
    await renderPlayground();
    await typePrompt(container, "draft");

    await act(async () => button(container, "AI 优化").click());
    await flush();

    expect((container.querySelector("#pg-prompt") as HTMLTextAreaElement).value).toBe("draft");
    expect(container.querySelector('[role="alert"]')!.textContent).toContain("AI 优化失败：rate limited");
  });

  it("disables optimizing with an empty prompt and while a request is in flight", async () => {
    let release!: (value: { prompt: string }) => void;
    vi.spyOn(apiModule, "optimizePrompt").mockReturnValue(new Promise<{ prompt: string }>((resolve) => (release = resolve)));
    await renderPlayground();

    expect(button(container, "AI 优化").disabled).toBe(true);

    await typePrompt(container, "draft");
    const optimizeButton = button(container, "AI 优化");
    expect(optimizeButton.disabled).toBe(false);

    await act(async () => optimizeButton.click());
    expect(button(container, "优化中…").disabled).toBe(true);
    expect(apiModule.optimizePrompt).toHaveBeenCalledTimes(1);

    await act(async () => release({ prompt: "done" }));
    await flush();
    expect((container.querySelector("#pg-prompt") as HTMLTextAreaElement).value).toBe("done");
  });

  it("translates the prompt and supports undo", async () => {
    const translate = vi.spyOn(apiModule, "translatePrompt").mockResolvedValue({ prompt: "an orange cat sunbathing", target: "en" });
    await renderPlayground();
    await typePrompt(container, "一只橘猫在晒太阳");

    await act(async () => button(container, "翻译").click());
    await flush();

    expect(translate).toHaveBeenCalledWith("一只橘猫在晒太阳");
    expect((container.querySelector("#pg-prompt") as HTMLTextAreaElement).value).toBe("an orange cat sunbathing");
    expect(container.textContent).toContain("撤销");

    await act(async () => button(container, "撤销").click());
    await flush();
    expect((container.querySelector("#pg-prompt") as HTMLTextAreaElement).value).toBe("一只橘猫在晒太阳");
  });

  it("shows an error and keeps the prompt when translation fails", async () => {
    vi.spyOn(apiModule, "translatePrompt").mockRejectedValue(new Error("upstream 500"));
    await renderPlayground();
    await typePrompt(container, "draft");

    await act(async () => button(container, "翻译").click());
    await flush();

    expect((container.querySelector("#pg-prompt") as HTMLTextAreaElement).value).toBe("draft");
    expect(container.querySelector('[role="alert"]')!.textContent).toContain("AI 翻译失败：upstream 500");
  });
});
