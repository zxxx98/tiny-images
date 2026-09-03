/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AccountSettings from "./AccountSettings";

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
  it("loads the per-user watermark config on mount", async () => {
    apiMocks.fetchMyWatermark.mockResolvedValue({ enabled: true, text: "张三" });
    await renderPage();

    expect(container.querySelector<HTMLInputElement>("#wm-enabled")!.checked).toBe(true);
    expect(container.querySelector<HTMLInputElement>("#wm-text")!.value).toBe("张三");
    expect(apiMocks.fetchMyWatermark).toHaveBeenCalledTimes(1);
  });

  it("saves the watermark settings and shows inline confirmation", async () => {
    apiMocks.fetchMyWatermark.mockResolvedValue({ enabled: false, text: "" });
    apiMocks.saveMyWatermark.mockResolvedValue({ enabled: true, text: "李四" });
    await renderPage();

    await act(async () => {
      container.querySelector<HTMLInputElement>("#wm-enabled")!.click();
      typeInput("#wm-text", "  李四  ");
    });
    await submitForm(0);

    expect(apiMocks.saveMyWatermark).toHaveBeenCalledWith({ enabled: true, text: "李四" });
    expect(container.textContent).toContain("水印设置已保存");
  });

  it("changes the password through the auth API and clears the form", async () => {
    apiMocks.fetchMyWatermark.mockResolvedValue({ enabled: false, text: "" });
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
    apiMocks.fetchMyWatermark.mockResolvedValue({ enabled: false, text: "" });
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
