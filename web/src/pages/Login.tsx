import { FormEvent, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ApiError, clearToken, fetchRegistrationEnabled, fetchTurnstileConfig, loginRequest, setRole, setToken } from "../api";
import Turnstile from "./Turnstile";

// 服务端 403/503 的 captcha 错误统一映射为中文提示
function turnstileErrorMessage(err: ApiError): string | null {
  if (!err.message.includes("human verification")) return null;
  return err.status === 503 ? "人机验证服务暂时不可用，请稍后重试" : "人机验证未通过，请重新完成验证";
}

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [registrationEnabled, setRegistrationEnabled] = useState(false);
  const [turnstileSiteKey, setTurnstileSiteKey] = useState<string | null>(null);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [turnstileAttempt, setTurnstileAttempt] = useState(0);
  const navigate = useNavigate();

  // 探测注册入口开关与 Turnstile 配置；失败按未开启/未启用处理
  useEffect(() => {
    let alive = true;
    Promise.all([
      fetchRegistrationEnabled().catch(() => undefined),
      fetchTurnstileConfig().catch(() => undefined),
    ]).then(([registration, ts]) => {
      if (!alive) return;
      setRegistrationEnabled(registration === true);
      setTurnstileSiteKey(ts?.enabled && ts.siteKey ? ts.siteKey : null);
    });
    return () => {
      alive = false;
    };
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const r = await loginRequest(email.trim(), password, turnstileToken ?? undefined);
      clearToken();
      setToken(r.token);
      setRole(r.role);
      navigate("/");
    } catch (err) {
      const captcha = err instanceof ApiError ? turnstileErrorMessage(err) : null;
      setError(
        captcha ??
          (err instanceof ApiError && err.status === 401
            ? "邮箱或密码不正确"
            : err instanceof ApiError
              ? err.message
              : "连接服务失败，请确认服务可用后重试"),
      );
      // token 一次性，任何失败后重挂组件换新验证
      if (turnstileSiteKey) {
        setTurnstileToken(null);
        setTurnstileAttempt((n) => n + 1);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const needsTurnstile = turnstileSiteKey !== null && !turnstileToken;

  return (
    <div className="login-wrap">
      <form className="card login-card" onSubmit={submit}>
        <div className="login-hero">
          <h1 className="rainbow">tiny-images 95</h1>
          <p className="muted">使用邮箱和密码登录</p>
        </div>
        <label htmlFor="login-email">邮箱</label>
        <input id="login-email" type="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
        <label htmlFor="login-password">密码</label>
        <input id="login-password" type="password" placeholder="密码" value={password} onChange={(e) => setPassword(e.target.value)} />
        {turnstileSiteKey && <Turnstile key={turnstileAttempt} siteKey={turnstileSiteKey} onToken={setTurnstileToken} />}
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        <button className="btn primary" type="submit" disabled={!email.trim() || !password || submitting || needsTurnstile}>
          {submitting ? "登录中…" : "登录"}
        </button>
        {registrationEnabled && (
          <p className="muted register-alt">
            没有账号？<Link to="/register">注册新账号</Link>
          </p>
        )}
      </form>
    </div>
  );
}
