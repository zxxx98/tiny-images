import { useEffect, useRef, useState } from "react";

interface TurnstileRenderParams {
  sitekey: string;
  theme?: "light" | "dark" | "auto";
  callback?: (token: string) => void;
  "expired-callback"?: () => void;
  "error-callback"?: () => boolean | void;
}

interface TurnstileApi {
  render: (el: HTMLElement, params: TurnstileRenderParams) => string;
  remove: (widgetId: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

let scriptPromise: Promise<TurnstileApi> | null = null;

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SCRIPT_SRC;
    script.async = true;
    script.onload = () => {
      if (window.turnstile) resolve(window.turnstile);
      else reject(new Error("turnstile api missing after script load"));
    };
    script.onerror = () => {
      scriptPromise = null; // 允许下次挂载重试
      reject(new Error("failed to load turnstile script"));
    };
    document.head.appendChild(script);
  });
  return scriptPromise;
}

// Cloudflare Turnstile 人机验证组件；onToken 在拿到/过期/出错时回传 token（null 表示尚未通过）
export default function Turnstile({ siteKey, onToken }: { siteKey: string; onToken: (token: string | null) => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const onTokenRef = useRef(onToken);
  onTokenRef.current = onToken;

  useEffect(() => {
    let widgetId: string | null = null;
    let cancelled = false;
    loadTurnstile()
      .then((turnstile) => {
        if (cancelled || !containerRef.current) return;
        widgetId = turnstile.render(containerRef.current, {
          sitekey: siteKey,
          theme: "light",
          callback: (token) => onTokenRef.current(token),
          "expired-callback": () => onTokenRef.current(null),
          "error-callback": () => {
            onTokenRef.current(null);
            return true;
          },
        });
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      if (widgetId !== null) window.turnstile?.remove(widgetId);
    };
  }, [siteKey]);

  if (failed) {
    return <div className="muted turnstile-slot">人机验证组件加载失败，请检查网络后刷新重试</div>;
  }
  return (
    <div className="turnstile-slot">
      <div ref={containerRef} />
    </div>
  );
}
