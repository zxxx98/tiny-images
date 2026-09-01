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

function PathProbe() {
  const location = useLocation();
  return <pre data-testid="location-path">{location.pathname}</pre>;
}

const upscaleItem = {
  id: 7,
  createdAt: 1,
  model: "cloudflare-images-upscale",
  prompt: "",
  params: { operation: "upscale", scale: 4, targetWidth: 2048, targetHeight: 1536 },
  status: "ok" as const,
  latencyMs: 100,
  errorMessage: null,
  images: [{ file: "upscaled.webp", url: "/files/upscaled.webp" }],
};

const regularItem = {
  id: 8,
  createdAt: 2,
  model: "img-1",
  prompt: "a cat",
  params: { size: "1024x1536" },
  status: "ok" as const,
  latencyMs: 120,
  errorMessage: null,
  images: [{ file: "cat.png", url: "/files/cat.png" }],
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
            <Route path="/history" element={<><History /><PathProbe /></>} />
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

  it("keeps the detail open when clicking a history image", async () => {
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={["/history"]}>
          <Routes>
            <Route path="/history" element={<><History /><PathProbe /></>} />
            <Route path="/" element={<LocationProbe />} />
          </Routes>
        </MemoryRouter>,
      );
      await flush();
    });

    const tile = container.querySelector(".wall-tile") as HTMLButtonElement;
    await act(async () => tile.click());
    const image = container.querySelector(".detail-gallery img") as HTMLImageElement;
    await act(async () => image.click());

    expect(container.querySelector(".detail-overlay")).not.toBeNull();
    expect(container.querySelector('[data-testid="location-state"]')).toBeNull();
    expect(container.querySelector('[data-testid="location-path"]')?.textContent).toBe("/history");
  });

  it("navigates to edit mode only from the explicit edit action", async () => {
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={["/history"]}>
          <Routes>
            <Route path="/history" element={<><History /><PathProbe /></>} />
            <Route path="/" element={<LocationProbe />} />
          </Routes>
        </MemoryRouter>,
      );
      await flush();
    });

    const tile = container.querySelector(".wall-tile") as HTMLButtonElement;
    await act(async () => tile.click());
    const edit = Array.from(container.querySelectorAll(".shot-actions button")).find((item) => item.textContent?.trim() === "编辑此图") as HTMLButtonElement;
    await act(async () => {
      edit.click();
      await flush();
    });

    expect(container.querySelector('[data-testid="location-state"]')?.textContent).toBe('{"editImageUrl":"/files/upscaled.webp"}');
  });

  it("shows normal, fallback, and upscale output sizes in history", async () => {
    vi.mocked(apiModule.api).mockResolvedValue({
      items: [
        regularItem,
        { ...upscaleItem, id: 9, params: { operation: "upscale", scale: 2, targetWidth: 2048, targetHeight: 1536 } },
        { ...regularItem, id: 10, params: {} },
      ],
    } as never);

    await act(async () => {
      root.render(<MemoryRouter initialEntries={["/history"]}><History /></MemoryRouter>);
      await flush();
    });

    expect(container.textContent).toContain("尺寸: 1024x1536");
    expect(container.textContent).toContain("尺寸: 2048x1536");
    expect(container.textContent).toContain("尺寸: 未知");

    const normalTiles = Array.from(container.querySelectorAll('.wall-tile[title="a cat"]')) as HTMLButtonElement[];
    const upscaleTile = container.querySelector('.wall-tile[title="图片超分 · 2×"]') as HTMLButtonElement;

    await act(async () => normalTiles[0].click());
    expect(container.querySelector(".history-meta")?.textContent).toContain("尺寸: 1024x1536");

    await act(async () => (container.querySelector(".detail-overlay") as HTMLDivElement).click());
    await act(async () => upscaleTile.click());
    expect(container.querySelector(".history-meta")?.textContent).toContain("尺寸: 2048x1536");

    await act(async () => (container.querySelector(".detail-overlay") as HTMLDivElement).click());
    await act(async () => normalTiles[1].click());
    expect(container.querySelector(".history-meta")?.textContent).toContain("尺寸: 未知");
  });

  it("prefers persisted image dimensions when the request size is auto", async () => {
    vi.mocked(apiModule.api).mockResolvedValue({
      items: [{
        ...regularItem,
        id: 11,
        prompt: "persisted auto",
        params: {},
        images: [{ ...regularItem.images[0], width: 640, height: 480 }],
      }],
    } as never);

    await act(async () => {
      root.render(<MemoryRouter initialEntries={["/history"]}><History /></MemoryRouter>);
      await flush();
    });

    expect(container.textContent).toContain("尺寸: 640x480");
    expect(container.textContent).not.toContain("尺寸: auto");
  });

  it("learns real dimensions from a legacy image load and reuses them in detail", async () => {
    vi.mocked(apiModule.api).mockResolvedValue({
      items: [{
        ...regularItem,
        id: 12,
        prompt: "legacy auto",
        params: {},
      }],
    } as never);

    await act(async () => {
      root.render(<MemoryRouter initialEntries={["/history"]}><History /></MemoryRouter>);
      await flush();
    });

    expect(container.textContent).toContain("尺寸: 未知");
    const tile = container.querySelector('.wall-tile[title="legacy auto"]') as HTMLButtonElement;
    const image = tile.querySelector("img") as HTMLImageElement;
    Object.defineProperty(image, "naturalWidth", { configurable: true, value: 320 });
    Object.defineProperty(image, "naturalHeight", { configurable: true, value: 240 });
    await act(async () => {
      image.dispatchEvent(new Event("load"));
      await flush();
    });

    expect(container.textContent).toContain("尺寸: 320x240");
    await act(async () => tile.click());
    expect(container.querySelector(".history-meta")?.textContent).toContain("尺寸: 320x240");
  });
});
