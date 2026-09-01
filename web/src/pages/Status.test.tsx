/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelHealthResponse } from "../api";
import * as apiModule from "../api";
import Status from "./Status";

const generatedAt = new Date("2026-09-01T08:00:00Z").getTime();

function response(models: ModelHealthResponse["models"] = []): ModelHealthResponse {
  return { generatedAt, sampleLimit: 50, models };
}

function model(overrides: Partial<ModelHealthResponse["models"][number]> = {}): ModelHealthResponse["models"][number] {
  return {
    model: "image-model",
    status: "healthy",
    supportsImageToImage: true,
    routes: { total: 2, available: 1 },
    requests: {
      sampleSize: 2,
      successful: 1,
      failed: 1,
      successRate: 0.5,
      averageLatencyMs: 1250,
      lastRequestAt: generatedAt - 1000,
    },
    recent: [
      { ts: generatedAt - 1000, status: "ok", latencyMs: 1000 },
      { ts: generatedAt - 2000, status: "error", latencyMs: 1500 },
    ],
    ...overrides,
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("Status page", () => {
  let container: HTMLDivElement;
  let root: Root;
  let visibility: DocumentVisibilityState;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    visibility = "visible";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("shows initial loading and then the empty account state", async () => {
    let resolveRequest!: (value: ModelHealthResponse) => void;
    vi.spyOn(apiModule, "fetchModelHealth").mockReturnValue(new Promise((resolve) => { resolveRequest = resolve; }));

    await act(async () => root.render(<Status />));
    expect(container.textContent).toContain("正在读取近期真实调用数据");

    await act(async () => {
      resolveRequest(response());
      await flush();
    });
    expect(container.textContent).toContain("没有可用模型");
    expect(container.textContent).toContain("请联系管理员");
    expect(container.textContent).toContain("最近 50 条真实调用");
  });

  it("renders all Chinese statuses, capabilities, metrics and accessible probe symbols", async () => {
    vi.spyOn(apiModule, "fetchModelHealth").mockResolvedValue(
      response([
        model({ model: "healthy-model", status: "healthy" }),
        model({ model: "degraded-model", status: "degraded", supportsImageToImage: false }),
        model({ model: "unavailable-model", status: "unavailable" }),
        model({ model: "unknown-model", status: "unknown", requests: { ...model().requests, sampleSize: 0, successRate: null, averageLatencyMs: null, lastRequestAt: null }, recent: [] }),
      ]),
    );

    await act(async () => {
      root.render(<Status />);
      await flush();
    });

    expect(container.textContent).toContain("正常 1");
    expect(container.textContent).toContain("波动 1");
    expect(container.textContent).toContain("不可用 1");
    expect(container.textContent).toContain("暂无样本 1");
    expect(container.textContent).toContain("文生图");
    expect(container.textContent).toContain("不支持图生图");
    expect(container.textContent).toContain("50%");
    expect(container.textContent).toContain("1250 ms");
    expect(container.textContent).toContain("1 / 2 可用");
    expect(container.querySelector('[role="img"][aria-label*="成功"]')).not.toBeNull();
    expect(container.querySelector(".probe-cell.success")?.textContent).toBe("✓");
    expect(container.querySelector(".probe-cell.failure")?.textContent).toBe("×");
  });

  it("keeps old data when a manual refresh fails", async () => {
    const fetchMock = vi.spyOn(apiModule, "fetchModelHealth")
      .mockResolvedValueOnce(response([model({ model: "kept-model" })]))
      .mockRejectedValueOnce(new Error("network down"));

    await act(async () => {
      root.render(<Status />);
      await flush();
    });
    const button = Array.from(container.querySelectorAll("button")).find((item) => item.textContent === "手动刷新")!;

    await act(async () => {
      button.click();
      await flush();
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("kept-model");
    expect(container.textContent).toContain("刷新失败，继续显示上次数据：network down");
  });

  it("refreshes every five seconds, pauses while hidden, resumes when visible, and cleans up", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.spyOn(apiModule, "fetchModelHealth").mockResolvedValue(response([model()]));
    const removeListener = vi.spyOn(document, "removeEventListener");

    await act(async () => {
      root.render(<Status />);
      await flush();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    visibility = "hidden";
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    visibility = "visible";
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await flush();
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);

    await act(async () => root.unmount());
    expect(removeListener).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    root = createRoot(container);
  });
});
