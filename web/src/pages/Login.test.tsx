/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Login from "./Login";

const apiMocks = vi.hoisted(() => ({
  fetchRegistrationEnabled: vi.fn(),
  fetchTurnstileConfig: vi.fn(),
  loginRequest: vi.fn(),
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

// 假 Turnstile 组件：issue 非 null 时在 effect 里自动发一个 token，模拟通过验证
const turnstileFake = vi.hoisted(() => ({ issue: "captcha-token" as string | null }));

vi.mock("../api", () => apiMocks);
vi.mock("./Turnstile", async () => {
  const { useEffect } = await import("react");
  return {
    default: ({ onToken }: { onToken: (token: string | null) => void }) => {
      useEffect(() => {
        if (turnstileFake.issue) onToken(turnstileFake.issue);
      }, [onToken]);
      return null;
    },
  };
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  apiMocks.fetchRegistrationEnabled.mockReset();
  apiMocks.fetchTurnstileConfig.mockReset();
  apiMocks.loginRequest.mockReset();
  apiMocks.clearToken.mockReset();
  apiMocks.setToken.mockReset();
  apiMocks.setRole.mockReset();
  apiMocks.fetchRegistrationEnabled.mockResolvedValue(false);
  apiMocks.fetchTurnstileConfig.mockResolvedValue({ enabled: false, siteKey: null });
  turnstileFake.issue = "captcha-token";
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
      <MemoryRouter initialEntries={["/login"]}>
        <Login />
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

describe("Login", () => {
  it("logs in without a turnstile token when the feature is off", async () => {
    apiMocks.loginRequest.mockResolvedValue({ token: "jwt", role: "admin", email: "a@x.com" });
    await renderPage();
    type("#login-email", "a@x.com");
    type("#login-password", "pw");
    await submit();
    expect(apiMocks.loginRequest).toHaveBeenCalledWith("a@x.com", "pw", undefined);
    expect(apiMocks.setToken).toHaveBeenCalledWith("jwt");
    expect(apiMocks.setRole).toHaveBeenCalledWith("admin");
  });

  it("maps invalid credentials to a friendly message", async () => {
    apiMocks.loginRequest.mockRejectedValue(new apiMocks.ApiError(401, { error: { message: "invalid email or password" } }));
    await renderPage();
    type("#login-email", "a@x.com");
    type("#login-password", "nope");
    await submit();
    expect(container.textContent).toContain("邮箱或密码不正确");
    expect(apiMocks.setToken).not.toHaveBeenCalled();
  });

  describe("with turnstile enabled", () => {
    beforeEach(() => {
      apiMocks.fetchTurnstileConfig.mockResolvedValue({ enabled: true, siteKey: "site-key" });
    });

    it("disables submit until the widget issues a token", async () => {
      turnstileFake.issue = null;
      await renderPage();
      type("#login-email", "a@x.com");
      type("#login-password", "pw");
      expect((container.querySelector("button[type=submit]") as HTMLButtonElement).disabled).toBe(true);
      expect(apiMocks.loginRequest).not.toHaveBeenCalled();
    });

    it("sends the turnstile token with the login", async () => {
      apiMocks.loginRequest.mockResolvedValue({ token: "jwt", role: "user", email: "a@x.com" });
      await renderPage();
      type("#login-email", "a@x.com");
      type("#login-password", "pw");
      await submit();
      expect(apiMocks.loginRequest).toHaveBeenCalledWith("a@x.com", "pw", "captcha-token");
      expect(apiMocks.setToken).toHaveBeenCalledWith("jwt");
    });

    it("maps a captcha rejection to a friendly message", async () => {
      apiMocks.loginRequest.mockRejectedValue(new apiMocks.ApiError(403, { error: { message: "human verification failed" } }));
      await renderPage();
      type("#login-email", "a@x.com");
      type("#login-password", "pw");
      await submit();
      expect(container.textContent).toContain("人机验证未通过，请重新完成验证");
      expect(apiMocks.setToken).not.toHaveBeenCalled();
    });
  });
});
