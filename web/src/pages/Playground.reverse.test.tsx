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
  // FileReader 回调与其后的 promise 链依赖宏任务，多轮等待保证状态落地
  for (let i = 0; i < 3; i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll("button")).find((item) => item.textContent?.trim() === label);
  if (!found) throw new Error(`button not found: ${label}`);
  return found;
}

async function selectFile(input: HTMLInputElement, file: File): Promise<void> {
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
  });
}

async function renderPlayground(root: Root, container: HTMLDivElement, features?: apiModule.Features): Promise<void> {
  if (features) vi.mocked(apiModule.fetchFeatures).mockResolvedValue(features);
  await act(async () => {
    root.render(
      <MemoryRouter>
        <Playground />
      </MemoryRouter>,
    );
    await flush();
  });
}

describe("Playground prompt reverse", () => {
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
    vi.spyOn(apiModule, "fetchFeatures").mockResolvedValue({ upscale: false, promptOptimizer: false, promptReverse: true });
    Object.defineProperty(window, "scrollTo", { configurable: true, value: vi.fn() });
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:preview") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("hides the reverse tab when the feature is disabled", async () => {
    await renderPlayground(root, container, { upscale: false, promptOptimizer: false, promptReverse: false });
    expect(container.textContent).not.toContain("图片反推");
  });

  it("switches to the reverse view with upload, style choice and a text result panel", async () => {
    await renderPlayground(root, container);
    await act(async () => button(container, "图片反推").click());
    await flush();

    expect(container.querySelector("#pg-prompt")).toBeNull();
    expect(container.querySelector("#pg-reverse-image")).not.toBeNull();
    expect(container.querySelector("#pg-model")).toBeNull();
    expect(container.textContent).toContain("从历史导入");
    expect(container.textContent).toContain("简洁版");
    expect(container.textContent).toContain("详细版");
    expect(container.textContent).toContain("极致风格版");
    expect(Array.from(container.querySelectorAll("h2")).map((h) => h.textContent)).toContain("反推结果");
    expect(container.textContent).toContain("开始反推");
    // 简洁版默认选中
    expect(button(container, "简洁版").getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector(".reverse-result") as Element | null).toBeNull();
  });

  it("reverses an uploaded image and shows the text result with actions", async () => {
    vi.spyOn(apiModule, "reverseImagePrompt").mockResolvedValue({ prompt: "a fluffy orange cat sitting on a windowsill" });
    await renderPlayground(root, container);
    await act(async () => button(container, "图片反推").click());
    await flush();

    await selectFile(container.querySelector("#pg-reverse-image") as HTMLInputElement, new File(["image"], "cat.png", { type: "image/png" }));
    const start = button(container, "开始反推");
    expect(start.disabled).toBe(false);

    await act(async () => {
      start.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await flush();
    });

    expect(apiModule.reverseImagePrompt).toHaveBeenCalledWith(expect.stringMatching(/^data:image\/png;base64,/), "concise");
    expect(container.querySelector(".reverse-result-text")!.textContent).toBe("a fluffy orange cat sitting on a windowsill");
    expect(container.textContent).toContain("复制");
    expect(container.textContent).toContain("填入 Prompt");
  });

  it("supports choosing a style and filling the result back into the prompt", async () => {
    vi.spyOn(apiModule, "reverseImagePrompt").mockResolvedValue({ prompt: "cinematic still of a lighthouse at dusk" });
    await renderPlayground(root, container);
    await act(async () => button(container, "图片反推").click());
    await flush();

    await act(async () => button(container, "极致风格版").click());
    await flush();
    expect(button(container, "极致风格版").getAttribute("aria-pressed")).toBe("true");
    expect(button(container, "简洁版").getAttribute("aria-pressed")).toBe("false");

    await selectFile(container.querySelector("#pg-reverse-image") as HTMLInputElement, new File(["image"], "sea.png", { type: "image/png" }));
    await act(async () => {
      button(container, "开始反推").closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await flush();
    });
    expect(apiModule.reverseImagePrompt).toHaveBeenCalledWith(expect.any(String), "cinematic");

    await act(async () => button(container, "填入 Prompt").click());
    await flush();

    expect((container.querySelector("#pg-prompt") as HTMLTextAreaElement).value).toBe("cinematic still of a lighthouse at dusk");
    // 填入后回到文生图视图
    expect(container.querySelector("#pg-reverse-image")).toBeNull();
  });

  it("shows an error and keeps the view when the reverse request fails", async () => {
    vi.spyOn(apiModule, "reverseImagePrompt").mockRejectedValue(new Error("rate limited"));
    await renderPlayground(root, container);
    await act(async () => button(container, "图片反推").click());
    await flush();

    await selectFile(container.querySelector("#pg-reverse-image") as HTMLInputElement, new File(["image"], "cat.png", { type: "image/png" }));
    await act(async () => {
      button(container, "开始反推").closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await flush();
    });

    expect(container.querySelector('[role="alert"]')!.textContent).toContain("反推失败：rate limited");
    expect(container.querySelector(".reverse-result") as Element | null).toBeNull();
  });

  it("imports images from history into the reverse view", async () => {
    vi.spyOn(apiModule, "api").mockImplementation(async (path: string) => {
      if (path === "/v1/models") return { data: [{ id: "image-model" }] } as never;
      if (path === "/v1/history?limit=24") {
        return { items: [{ id: 7, prompt: "an old record", images: [{ url: "/files/old.png" }] }] } as never;
      }
      throw new Error(`unexpected API: ${path}`);
    });
    const imageFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      blob: async () => new File(["image"], "old.png", { type: "image/png" }),
    } as unknown as Response);
    await renderPlayground(root, container);
    await act(async () => button(container, "图片反推").click());
    await flush();

    await act(async () => button(container, "从历史导入").click());
    await flush();

    expect(container.querySelector(".reverse-history-tile")).not.toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>(".reverse-history-tile")!.click());
    await flush();

    expect(imageFetch).toHaveBeenCalledWith("/files/old.png");
    expect(container.querySelector('img[alt="待反推图片：reverse-src.png"]')).not.toBeNull();
    // 导入成功后选择器收起，可以开始反推
    expect(container.querySelector(".reverse-history")).toBeNull();
    expect(button(container, "开始反推").disabled).toBe(false);
  });

  it("shows an empty hint when history has no importable images", async () => {
    vi.spyOn(apiModule, "api").mockImplementation(async (path: string) => {
      if (path === "/v1/models") return { data: [{ id: "image-model" }] } as never;
      if (path === "/v1/history?limit=24") return { items: [] } as never;
      throw new Error(`unexpected API: ${path}`);
    });
    await renderPlayground(root, container);
    await act(async () => button(container, "图片反推").click());
    await flush();

    await act(async () => button(container, "从历史导入").click());
    await flush();

    expect(container.textContent).toContain("暂无可导入的历史图片。");
  });
});
