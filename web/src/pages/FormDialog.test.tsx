/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import FormDialog from "./FormDialog";

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

it("renders a modal dialog with title and focuses the first field", async () => {
  await act(async () => {
    root.render(
      <FormDialog title="新建渠道" onClose={() => undefined}>
        <form>
          <label htmlFor="a">A</label>
          <input id="a" />
          <button type="submit">保存</button>
        </form>
      </FormDialog>,
    );
  });
  const dialog = container.querySelector('[role="dialog"]')!;
  expect(dialog).toBeTruthy();
  expect(dialog.textContent).toContain("新建渠道");
  expect(container.querySelector<HTMLAnchorElement>("#a") ?? container.querySelector<HTMLInputElement>("#a")).toBe(document.activeElement);
});

it("closes on Escape and on the × button, but not on overlay click", async () => {
  let closed = 0;
  const onClose = (): void => {
    closed += 1;
  };
  await act(async () => {
    root.render(
      <FormDialog title="编辑" onClose={onClose}>
        <input id="only" />
      </FormDialog>,
    );
  });

  // 点击遮罩不关闭，避免误触丢表单
  await act(async () => (container.querySelector(".detail-overlay") as HTMLDivElement).click());
  expect(closed).toBe(0);

  await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
  expect(closed).toBe(1);

  await act(async () => (container.querySelector('[aria-label="关闭"]') as HTMLSpanElement).click());
  expect(closed).toBe(2);
});
