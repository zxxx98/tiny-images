/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import Admin from "./Admin";

const mocks = vi.hoisted(() => ({ api: vi.fn(), fetchChannelHealth: vi.fn() }));
vi.mock("../api", () => ({ ...mocks }));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  mocks.api.mockReset();
  mocks.api.mockImplementation((path: string) => {
    if (path === "/admin/models") return Promise.resolve([]);
    if (path === "/admin/channels") return Promise.resolve([{
      id: 1, name: "mock", type: "openai-compat", baseUrl: "https://x.test/v1",
      timeoutMs: 120000, concurrency: 2, editMode: "auto", extraHeaders: {},
      enabled: true, createdAt: 1, keys: [],
    }]);
    return Promise.resolve([]);
  });
  mocks.fetchChannelHealth.mockResolvedValue({ generatedAt: 1, sampleLimit: 50, channels: [] });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("shows a default-off NSFW capability on model mappings", async () => {
  await act(async () => {
    root.render(<MemoryRouter initialEntries={["/admin?tab=models"]}><Admin /></MemoryRouter>);
    await Promise.resolve();
  });
  const create = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "新建映射")!;
  await act(async () => create.click());

  const checkbox = Array.from(container.querySelectorAll("label")).find((label) => label.textContent?.includes("支持 NSFW"))?.querySelector("input");
  expect(checkbox).toBeTruthy();
  expect(checkbox?.checked).toBe(false);
  expect(container.textContent).toContain("NSFW");

  const publicName = container.querySelector<HTMLInputElement>("#m-public")!;
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setValue.call(publicName, "adult");
    publicName.dispatchEvent(new Event("input", { bubbles: true }));
    checkbox!.click();
  });
  await act(async () => {
    container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
  expect(mocks.api).toHaveBeenCalledWith("/admin/models", expect.objectContaining({
    method: "POST",
    body: expect.objectContaining({ publicName: "adult", supportsNsfw: true }),
  }));
});
