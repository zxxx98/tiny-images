/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as apiModule from "./api";
import App from "./App";
import { APP_VERSION, GIT_HASH } from "./version";

function storage(token: string, role: "admin" | "user" | null = "user") {
  return {
    getItem: (key: string) => {
      if (key === apiModule.TOKEN_KEY) return token;
      if (key === apiModule.ROLE_KEY) return role;
      return null;
    },
    setItem: vi.fn(),
    removeItem: vi.fn(),
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("App model status route", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.spyOn(apiModule, "fetchMe").mockResolvedValue({
      role: "user",
      email: "user@example.test",
      quotaTotal: null,
      quotaUsed: 0,
      quotaRemaining: null,
    });
    vi.spyOn(apiModule, "fetchModelHealth").mockResolvedValue({ generatedAt: 1, sampleLimit: 50, models: [] });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("places model status immediately after Playground and lets a user navigate there", async () => {
    vi.stubGlobal("localStorage", storage("user-token"));

    await act(async () => {
      root.render(<MemoryRouter initialEntries={["/"]}><App /></MemoryRouter>);
      await flush();
    });

    const links = Array.from(container.querySelectorAll("nav a"));
    expect(links.slice(0, 2).map((link) => link.textContent?.trim())).toEqual(["Playground", "模型状态"]);

    await act(async () => {
      (links[1] as HTMLAnchorElement).click();
      await flush();
    });
    expect(container.textContent).toContain("模型网络探针");
    expect(document.title).toBe("模型状态 · tiny-images 95");
  });

  it("guards the status page when no token is present", async () => {
    vi.stubGlobal("localStorage", storage("", null));
    vi.spyOn(apiModule, "fetchSetupNeeded").mockResolvedValue(false);

    await act(async () => {
      root.render(<MemoryRouter initialEntries={["/status"]}><App /></MemoryRouter>);
      await flush();
    });

    expect(container.textContent).not.toContain("模型网络探针");
    expect(container.textContent).toContain("登录");
    expect(apiModule.fetchModelHealth).not.toHaveBeenCalled();
  });

  it("shows the auto-generated version in the footer", async () => {
    vi.stubGlobal("localStorage", storage("", null));
    vi.spyOn(apiModule, "fetchSetupNeeded").mockResolvedValue(false);

    await act(async () => {
      root.render(<MemoryRouter initialEntries={["/"]}><App /></MemoryRouter>);
      await flush();
    });

    const badge = container.querySelector<HTMLElement>(".version-badge");
    expect(badge?.textContent).toBe(APP_VERSION);
    expect(badge?.title).toBe(`Commit ${GIT_HASH}`);
  });
});
