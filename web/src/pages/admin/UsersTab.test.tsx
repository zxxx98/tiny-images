/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import UsersTab from "./UsersTab";

const apiMock = vi.hoisted(() => vi.fn());
vi.mock("../../api", () => ({ api: apiMock }));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  apiMock.mockReset();
  apiMock.mockImplementation((path: string) => {
    if (path === "/admin/users") return Promise.resolve([{
      id: 1, email: "admin@x.com", role: "admin", enabled: true, createdAt: 1,
      quotaTotal: null, quotaUsed: 0, quotaRemaining: null, groupIds: [], allowNsfw: false,
    }]);
    if (path === "/admin/groups") return Promise.resolve([]);
    return Promise.resolve({});
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("shows a default-off user NSFW permission and administrator toggle", async () => {
  await act(async () => {
    root.render(<UsersTab />);
    await Promise.resolve();
  });
  const allowAdmin = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "允许 NSFW")!;
  await act(async () => {
    allowAdmin.click();
    await Promise.resolve();
  });
  expect(apiMock).toHaveBeenCalledWith("/admin/users/1", { method: "PATCH", body: { allowNsfw: true } });
  const adminRow = Array.from(container.querySelectorAll("tbody tr")).find((row) => row.textContent?.includes("admin@x.com"))!;
  const cells = adminRow.querySelectorAll("td");
  expect(cells[3].textContent).toBe("不限");
  expect(cells[4].textContent).toBe("不限");
  expect(cells[5].textContent).toContain("禁止");
  const newUser = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "新建用户")!;
  await act(async () => newUser.click());

  const checkbox = Array.from(container.querySelectorAll("label")).find((label) => label.textContent?.includes("允许使用 NSFW 模型"))?.querySelector("input");
  expect(checkbox).toBeTruthy();
  expect(checkbox?.checked).toBe(false);
  expect(container.textContent).toContain("NSFW 权限");
  expect(container.textContent).toContain("允许 NSFW");
});
