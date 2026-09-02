/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as apiModule from "../api";
import { buildLogQuery, type AppliedLogFilter } from "./Admin";
import type { LogRow } from "../api";
import Admin from "./Admin";

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

const LOGS: LogRow[] = [
  { id: 3, ts: 1700000000000, model: "img-1", channelId: 1, apiKeyId: null, status: "ok", httpStatus: 200, latencyMs: 120, errorMessage: null },
  { id: 2, ts: 1699999000000, model: "img-2", channelId: 2, apiKeyId: null, status: "error", httpStatus: 500, latencyMs: 80, errorMessage: "boom" },
];

describe("buildLogQuery", () => {
  it("serializes only non-empty filter fields", () => {
    expect(buildLogQuery({})).toBe("");
    expect(buildLogQuery({ model: " flux ", q: "", status: "error", channelId: "2" })).toBe("&model=+flux+&status=error&channelId=2");
    const filter: AppliedLogFilter = { q: "a,b" };
    expect(buildLogQuery(filter)).toBe("&q=a%2Cb");
  });
});

describe("Admin logs tab", () => {
  let container: HTMLDivElement;
  let root: Root;
  let apiCalls: string[];

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    localStorage.setItem("tiny-admin-token", "test-token");
    apiCalls = [];
    vi.spyOn(apiModule, "api").mockImplementation(async (path: string) => {
      apiCalls.push(path);
      if (path === "/admin/channels")
        return [
          { id: 1, name: "openai" },
          { id: 2, name: "horde" },
        ] as never;
      if (path.startsWith("/admin/logs")) {
        const query = path.split("?")[1] ?? "";
        const params = new URLSearchParams(query);
        const model = params.get("model");
        return LOGS.filter((l) => !model || l.model.includes(model)) as never;
      }
      throw new Error(`unexpected API: ${path}`);
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function openLogsTab(): Promise<void> {
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={["/admin?tab=logs"]}>
          <Admin />
        </MemoryRouter>,
      );
      await flush();
    });
  }

  it("lists logs and applies the model filter on 筛选", async () => {
    await openLogsTab();
    expect(apiCalls.some((p) => p.startsWith("/admin/logs?limit=50&"))).toBe(false);

    const input = container.querySelector('input[aria-label="按模型筛选"]') as HTMLInputElement;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setValue.call(input, "img-2");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await flush();
    });
    const apply = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "筛选")!;
    await act(async () => apply.click());
    await flush();

    const logCalls = apiCalls.filter((p) => p.startsWith("/admin/logs"));
    expect(logCalls.some((p) => p.includes("model=img-2"))).toBe(true);
    expect(container.textContent).toContain("筛选已启用");
    expect(container.textContent).not.toContain("img-1");
  });

  it("resets filters with 重置", async () => {
    await openLogsTab();
    const apply = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "筛选")!;
    const reset = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "重置")!;
    await act(async () => {
      const input = container.querySelector('input[aria-label="按模型筛选"]') as HTMLInputElement;
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setValue.call(input, "img-2");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await flush();
    });
    await act(async () => apply.click());
    await flush();
    await act(async () => reset.click());
    await flush();

    const lastCall = apiCalls.filter((p) => p.startsWith("/admin/logs")).at(-1)!;
    expect(lastCall).not.toContain("model=");
    expect(container.textContent).not.toContain("筛选已启用");
  });

  it("downloads the CSV export through a fetch with the current filters", async () => {
    await openLogsTab();
    const clicked: string[] = [];
    const anchorClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement) {
      clicked.push(this.download);
    };
    const fetchMock = vi.fn(async (url: string | URL, _init?: RequestInit) => {
      expect(String(url)).toContain("/admin/logs/export?limit=500");
      return new Response("\uFEFFid,ts\r\n", { status: 200, headers: { "content-type": "text/csv" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    URL.createObjectURL = vi.fn(() => "blob:mock") as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn() as typeof URL.revokeObjectURL;

    const exportBtn = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "导出 CSV")!;
    await act(async () => exportBtn.click());
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ headers: { authorization: "Bearer test-token" } });
    expect(clicked).toEqual([expect.stringContaining("tiny-images-logs-")]);
    HTMLAnchorElement.prototype.click = anchorClick;
  });
});
