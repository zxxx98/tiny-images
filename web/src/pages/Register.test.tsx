/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Register from "./Register";

const apiMocks = vi.hoisted(() => ({
  fetchRegistrationEnabled: vi.fn(),
  registerRequest: vi.fn(),
  clearToken: vi.fn(),
  setToken: vi.fn(),
  setRole: vi.fn(),
  ApiError: class ApiError extends Error {
    constructor(
      public status: number,
      public body: { error?: { message?: string } },
    ) {
      super(body?.error?.message ?? `HTTP ${status}`);
    }
  },
}));

vi.mock("../api", () => apiMocks);

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  apiMocks.fetchRegistrationEnabled.mockReset();
  apiMocks.registerRequest.mockReset();
  apiMocks.clearToken.mockReset();
  apiMocks.setToken.mockReset();
  apiMocks.setRole.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function renderPage(): Promise<void> {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={["/register"]}>
        <Register />
      </MemoryRouter>,
    );
    await Promise.resolve();
    await Promise.resolve();
  });
}

function type(id: string, value: string): void {
  const input = container.querySelector<HTMLInputElement>(id)!;
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setValue.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function submit(): Promise<void> {
  await act(async () => {
    container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("Register", () => {
  it("shows the closed-state notice when registration is disabled", async () => {
    apiMocks.fetchRegistrationEnabled.mockResolvedValue(false);
    await renderPage();
    expect(container.textContent).toContain("当前未开放注册");
    expect(container.querySelector("form")).toBeNull();
    expect(apiMocks.registerRequest).not.toHaveBeenCalled();
  });

  it("registers, stores the token, and navigates to the playground", async () => {
    apiMocks.fetchRegistrationEnabled.mockResolvedValue(true);
    apiMocks.registerRequest.mockResolvedValue({ token: "reg-token", role: "user", email: "new@x.com" });
    await renderPage();
    expect(container.querySelector("#register-email")).not.toBeNull();

    type("#register-email", "new@x.com");
    type("#register-password", "secret1");
    type("#register-confirm", "secret1");
    await submit();

    expect(apiMocks.registerRequest).toHaveBeenCalledWith("new@x.com", "secret1");
    expect(apiMocks.setToken).toHaveBeenCalledWith("reg-token");
    expect(apiMocks.setRole).toHaveBeenCalledWith("user");
  });

  it("shows a mismatch error before calling the API", async () => {
    apiMocks.fetchRegistrationEnabled.mockResolvedValue(true);
    await renderPage();
    type("#register-email", "new@x.com");
    type("#register-password", "secret1");
    type("#register-confirm", "secret2");
    await submit();
    expect(container.textContent).toContain("两次输入的密码不一致");
    expect(apiMocks.registerRequest).not.toHaveBeenCalled();
  });

  it("maps a duplicate email to a friendly message", async () => {
    apiMocks.fetchRegistrationEnabled.mockResolvedValue(true);
    apiMocks.registerRequest.mockRejectedValue(new apiMocks.ApiError(409, { error: { message: "user 'new@x.com' already exists" } }));
    await renderPage();
    type("#register-email", "new@x.com");
    type("#register-password", "secret1");
    type("#register-confirm", "secret1");
    await submit();
    expect(container.textContent).toContain("该邮箱已被注册");
  });
});
