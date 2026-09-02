/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SettingsTab from "./SettingsTab";

const apiMocks = vi.hoisted(() => ({
  fetchSettings: vi.fn(),
  saveSettings: vi.fn(),
}));

vi.mock("../../api", () => apiMocks);

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  apiMocks.fetchSettings.mockReset();
  apiMocks.saveSettings.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function renderTab(): Promise<void> {
  await act(async () => {
    root.render(<SettingsTab />);
    await Promise.resolve();
  });
}

describe("SettingsTab", () => {
  it("loads and saves edited settings", async () => {
    apiMocks.fetchSettings.mockResolvedValue({
      globalPrompt: "old",
      announcement: "notice",
      announcementVersion: 1,
      promptOptimizer: { baseUrl: "https://api.test/v1", apiKey: "sk-1", model: "gpt-4o-mini" },
      registration: { enabled: false, dailyQuota: 30 },
    });
    apiMocks.saveSettings.mockResolvedValue({
      globalPrompt: "new",
      announcement: "notice",
      announcementVersion: 1,
      promptOptimizer: { baseUrl: "https://api.test/v1", apiKey: "sk-1", model: "gpt-4o-mini" },
      registration: { enabled: false, dailyQuota: 30 },
    });
    await renderTab();

    const prompt = container.querySelector<HTMLTextAreaElement>("#settings-global-prompt")!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => {
      setValue.call(prompt, "new");
      prompt.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(apiMocks.saveSettings).toHaveBeenCalledWith({
      globalPrompt: "new",
      announcement: "notice",
      promptOptimizer: { baseUrl: "https://api.test/v1", apiKey: "sk-1", model: "gpt-4o-mini" },
      registration: { enabled: false, dailyQuota: 30 },
    });
    expect(container.textContent).toContain("设置已保存");
  });

  it("edits and saves the prompt optimizer AI configuration", async () => {
    apiMocks.fetchSettings.mockResolvedValue({
      globalPrompt: "",
      announcement: "",
      announcementVersion: 0,
      promptOptimizer: { baseUrl: "", apiKey: "", model: "" },
      registration: { enabled: false, dailyQuota: 30 },
    });
    apiMocks.saveSettings.mockResolvedValue({
      globalPrompt: "",
      announcement: "",
      announcementVersion: 0,
      promptOptimizer: { baseUrl: "https://api.test/v1", apiKey: "sk-2", model: "gpt-4o-mini" },
      registration: { enabled: true, dailyQuota: 30 },
    });
    await renderTab();

    const setInput = (id: string, value: string): void => {
      const input = container.querySelector<HTMLInputElement>(id)!;
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setValue.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    await act(async () => {
      setInput("#settings-ai-base-url", "https://api.test/v1");
      setInput("#settings-ai-api-key", "sk-2");
      setInput("#settings-ai-model", "gpt-4o-mini");
    });
    await act(async () => {
      container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(apiMocks.saveSettings).toHaveBeenCalledWith({
      globalPrompt: "",
      announcement: "",
      promptOptimizer: { baseUrl: "https://api.test/v1", apiKey: "sk-2", model: "gpt-4o-mini" },
      registration: { enabled: false, dailyQuota: 30 },
    });
  });

  it("toggles registration and saves the daily quota", async () => {
    apiMocks.fetchSettings.mockResolvedValue({
      globalPrompt: "",
      announcement: "",
      announcementVersion: 0,
      promptOptimizer: { baseUrl: "", apiKey: "", model: "" },
      registration: { enabled: false, dailyQuota: 30 },
    });
    apiMocks.saveSettings.mockResolvedValue({
      globalPrompt: "",
      announcement: "",
      announcementVersion: 0,
      promptOptimizer: { baseUrl: "", apiKey: "", model: "" },
      registration: { enabled: true, dailyQuota: 45 },
    });
    await renderTab();

    const toggle = container.querySelector<HTMLInputElement>("#settings-registration-enabled")!;
    expect(toggle.checked).toBe(false);
    await act(async () => {
      toggle.click();
    });
    expect(toggle.checked).toBe(true);

    const quota = container.querySelector<HTMLInputElement>("#settings-registration-daily-quota")!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setValue.call(quota, "45");
      quota.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(apiMocks.saveSettings).toHaveBeenCalledWith({
      globalPrompt: "",
      announcement: "",
      promptOptimizer: { baseUrl: "", apiKey: "", model: "" },
      registration: { enabled: true, dailyQuota: 45 },
    });
    expect(container.textContent).toContain("设置已保存");
  });

  it("rejects a non-positive registration quota without saving", async () => {
    apiMocks.fetchSettings.mockResolvedValue({
      globalPrompt: "",
      announcement: "",
      announcementVersion: 0,
      promptOptimizer: { baseUrl: "", apiKey: "", model: "" },
      registration: { enabled: false, dailyQuota: 30 },
    });
    await renderTab();

    const quota = container.querySelector<HTMLInputElement>("#settings-registration-daily-quota")!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setValue.call(quota, "0");
      quota.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(apiMocks.saveSettings).not.toHaveBeenCalled();
    expect(container.textContent).toContain("注册用户每日额度必须是正整数");
  });

  it("keeps saving disabled after a load failure and retries safely", async () => {
    apiMocks.fetchSettings
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ globalPrompt: "existing", announcement: "notice", announcementVersion: 1, registration: { enabled: false, dailyQuota: 30 } });
    await renderTab();

    const saveButton = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "保存设置")!;
    expect(saveButton.disabled).toBe(true);
    expect(container.textContent).toContain("offline");

    await act(async () => {
      container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(apiMocks.saveSettings).not.toHaveBeenCalled();

    const retry = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "重试")!;
    await act(async () => {
      retry.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(apiMocks.fetchSettings).toHaveBeenCalledTimes(2);
    expect(container.querySelector<HTMLTextAreaElement>("#settings-global-prompt")!.value).toBe("existing");
    expect(saveButton.disabled).toBe(false);
  });
});
