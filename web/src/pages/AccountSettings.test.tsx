/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AccountSettings from "./AccountSettings";

const STYLE_DEFAULTS = { position: "br", fontSize: 20, opacity: 0.6, color: "#ffffff", prefix: "" };

const apiMocks = vi.hoisted(() => ({
  api: vi.fn(),
  fetchMyWatermark: vi.fn(),
  saveMyWatermark: vi.fn(),
}));

vi.mock("../api", () => apiMocks);

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  apiMocks.api.mockReset();
  apiMocks.fetchMyWatermark.mockReset();
  apiMocks.saveMyWatermark.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function renderPage(): Promise<void> {
  await act(async () => {
    root.render(<AccountSettings />);
    await Promise.resolve();
  });
}

function typeInput(selector: string, value: string): void {
  const input = container.querySelector<HTMLInputElement>(selector)!;
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setValue.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function submitForm(index: number): Promise<void> {
  await act(async () => {
    container.querySelectorAll("form")[index]!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
}

describe("AccountSettings", () => {
  it("loads the per-user watermark config on mount and falls back to admin defaults", async () => {
    apiMocks.fetchMyWatermark.mockResolvedValue({ enabled: true, text: "张三", style: null, styleDefaults: STYLE_DEFAULTS });
    await renderPage();

    expect(container.querySelector<HTMLInputElement>("#wm-enabled")!.checked).toBe(true);
    expect(container.querySelector<HTMLInputElement>("#wm-text")!.value).toBe("张三");
    expect(container.querySelector<HTMLSelectElement>("#wm-position")!.value).toBe("br");
    expect(container.querySelector<HTMLInputElement>("#wm-font-size")!.value).toBe("20");
    expect(apiMocks.fetchMyWatermark).toHaveBeenCalledTimes(1);
  });

  it("prefers the user's saved style over the admin defaults", async () => {
    apiMocks.fetchMyWatermark.mockResolvedValue({
      enabled: true,
      text: "张三",
      style: { position: "tl", fontSize: 48, opacity: 0.9, color: "#ffcc00" },
      styleDefaults: STYLE_DEFAULTS,
    });
    await renderPage();

    expect(container.querySelector<HTMLSelectElement>("#wm-position")!.value).toBe("tl");
    expect(container.querySelector<HTMLInputElement>("#wm-font-size")!.value).toBe("48");
    expect(container.querySelector<HTMLInputElement>("#wm-opacity")!.value).toBe("0.9");
    expect(container.querySelector<HTMLInputElement>("#wm-color")!.value).toBe("#ffcc00");
  });

  it("saves the watermark settings with the chosen style", async () => {
    apiMocks.fetchMyWatermark.mockResolvedValue({ enabled: false, text: "", style: null, styleDefaults: STYLE_DEFAULTS });
    apiMocks.saveMyWatermark.mockResolvedValue({
      enabled: true,
      text: "李四",
      style: { position: "tl", fontSize: 20, opacity: 0.6, color: "#ffffff" },
      styleDefaults: STYLE_DEFAULTS,
    });
    await renderPage();

    await act(async () => {
      container.querySelector<HTMLInputElement>("#wm-enabled")!.click();
      typeInput("#wm-text", "  李四  ");
      container.querySelector<HTMLSelectElement>("#wm-position")!.value = "tl";
      container.querySelector<HTMLSelectElement>("#wm-position")!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await submitForm(0);

    expect(apiMocks.saveMyWatermark).toHaveBeenCalledWith({
      enabled: true,
      text: "李四",
      style: { position: "tl", fontSize: 20, opacity: 0.6, color: "#ffffff" },
    });
    expect(container.textContent).toContain("水印设置已保存");
  });

  it("rejects an out-of-range font size without saving", async () => {
    apiMocks.fetchMyWatermark.mockResolvedValue({ enabled: false, text: "", style: null, styleDefaults: STYLE_DEFAULTS });
    await renderPage();

    await act(async () => {
      typeInput("#wm-font-size", "8");
    });
    await submitForm(0);

    expect(apiMocks.saveMyWatermark).not.toHaveBeenCalled();
    expect(container.textContent).toContain("水印字号必须是 12–128 的整数");
  });

  it("changes the password through the auth API and clears the form", async () => {
    apiMocks.fetchMyWatermark.mockResolvedValue({ enabled: false, text: "", style: null, styleDefaults: STYLE_DEFAULTS });
    apiMocks.api.mockResolvedValue(undefined);
    await renderPage();

    await act(async () => {
      typeInput("#pwd-old", "old-pass");
      typeInput("#pwd-new", "new-pass");
    });
    await submitForm(1);

    expect(apiMocks.api).toHaveBeenCalledWith("/admin/auth/password", {
      method: "PUT",
      body: { oldPassword: "old-pass", newPassword: "new-pass" },
    });
    expect(container.querySelector<HTMLInputElement>("#pwd-old")!.value).toBe("");
    expect(container.querySelector<HTMLInputElement>("#pwd-new")!.value).toBe("");
    expect(container.textContent).toContain("密码已修改");
  });

  it("rejects a short new password without calling the API", async () => {
    apiMocks.fetchMyWatermark.mockResolvedValue({ enabled: false, text: "", style: null, styleDefaults: STYLE_DEFAULTS });
    await renderPage();

    await act(async () => {
      typeInput("#pwd-old", "old-pass");
      typeInput("#pwd-new", "123");
    });
    await submitForm(1);

    expect(apiMocks.api).not.toHaveBeenCalled();
    expect(container.textContent).toContain("新密码至少 6 位");
  });

  it("surfaces a watermark load failure without blocking the password form", async () => {
    apiMocks.fetchMyWatermark.mockRejectedValue(new Error("offline"));
    await renderPage();

    expect(container.textContent).toContain("offline");
    expect(container.querySelector("#pwd-old")).not.toBeNull();
  });
});
