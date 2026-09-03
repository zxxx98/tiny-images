/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Pager, usePager } from "./Pager";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

type PagerState = ReturnType<typeof usePager<number>>;

// 挂载一个可反复更新数据集的探针，观察同一 hook 实例的分页状态
function mountHarness(): { setItems: (count: number) => void; current: PagerState } {
  const handle: { current: PagerState | null } = { current: null };
  let count = 0;
  function Probe(): null {
    handle.current = usePager(Array.from({ length: count }, (_, i) => i), 20);
    return null;
  }
  act(() => {
    root.render(<Probe />);
  });
  return {
    setItems(next: number): void {
      count = next;
      act(() => {
        root.render(<Probe />);
      });
    },
    get current(): PagerState {
      return handle.current!;
    },
  };
}

describe("usePager", () => {
  it("slices the current page and clamps when the dataset shrinks", () => {
    const harness = mountHarness();

    harness.setItems(45);
    expect(harness.current.page).toBe(1);
    expect(harness.current.pageCount).toBe(3);
    expect(harness.current.slice).toEqual(Array.from({ length: 20 }, (_, i) => i));

    act(() => harness.current.setPage(3));
    expect(harness.current.page).toBe(3);
    expect(harness.current.slice).toEqual([40, 41, 42, 43, 44]);

    // 数据减少后页码收敛回有效范围
    harness.setItems(1);
    expect(harness.current.page).toBe(1);
    expect(harness.current.pageCount).toBe(1);
    expect(harness.current.slice).toEqual([0]);
  });
});

describe("Pager", () => {
  it("hides on a single page and steps forward from the first page", async () => {
    let page = -1;
    const onPage = (p: number): void => {
      page = p;
    };
    act(() => {
      root.render(<Pager page={1} pageCount={1} total={5} label="测试" onPage={onPage} />);
    });
    expect(container.querySelector(".pager")).toBeNull();

    act(() => {
      root.render(<Pager page={1} pageCount={3} total={58} label="测试" onPage={onPage} />);
    });
    const buttons = Array.from(container.querySelectorAll("button"));
    expect(buttons[0].disabled).toBe(true);
    expect(container.textContent).toContain("第 1 / 3 页 · 共 58 条");

    await act(async () => buttons[1].click());
    expect(page).toBe(2);
  });

  it("disables next on the last page", () => {
    act(() => {
      root.render(<Pager page={3} pageCount={3} total={58} label="测试" onPage={() => undefined} />);
    });
    const buttons = Array.from(container.querySelectorAll("button"));
    expect(buttons[0].disabled).toBe(false);
    expect(buttons[1].disabled).toBe(true);
  });
});
