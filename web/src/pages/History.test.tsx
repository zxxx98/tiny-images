/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as apiModule from "../api";
import History, { historyItemLabel, isUpscaleHistoryItem } from "./History";

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function LocationProbe() {
  const location = useLocation();
  return <pre data-testid="location-state">{JSON.stringify(location.state)}</pre>;
}

const upscaleItem = {
  id: 7,
  createdAt: 1,
  model: "cloudflare-images-upscale",
  prompt: "",
  params: { operation: "upscale", scale: 4 },
  status: "ok" as const,
  latencyMs: 100,
  errorMessage: null,
  images: [{ file: "upscaled.webp", url: "/files/upscaled.webp" }],
};

describe("history upscale rows", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.spyOn(apiModule, "api").mockResolvedValue({ items: [upscaleItem] } as never);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("labels upscale rows by operation and scale", () => {
    expect(isUpscaleHistoryItem(upscaleItem)).toBe(true);
    expect(historyItemLabel(upscaleItem)).toBe("图片超分 · 4×");
  });

  it("omits prompt actions and navigates the image through upscaleImageUrl", async () => {
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={["/history"]}>
          <Routes>
            <Route path="/history" element={<History />} />
            <Route path="/" element={<LocationProbe />} />
          </Routes>
        </MemoryRouter>,
      );
      await flush();
    });

    expect(container.textContent).toContain("图片超分 · 4×");
    const tile = container.querySelector(".wall-tile") as HTMLButtonElement;
    await act(async () => tile.click());
    expect(container.textContent).not.toContain("复制 Prompt");
    expect(container.textContent).not.toContain("用此 Prompt 重新生成");

    const upscale = Array.from(container.querySelectorAll(".shot-actions button")).find((item) => item.textContent?.trim() === "超分") as HTMLButtonElement;
    await act(async () => {
      upscale.click();
      await flush();
    });

    expect(container.querySelector('[data-testid="location-state"]')?.textContent).toBe('{"upscaleImageUrl":"/files/upscaled.webp"}');
  });
});
