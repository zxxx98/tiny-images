import { FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError, clearToken, loginRequest, setRole, setToken } from "../api";

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const r = await loginRequest(email.trim(), password);
      clearToken();
      setToken(r.token);
      setRole(r.role);
      navigate("/");
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 401
          ? "邮箱或密码不正确"
          : err instanceof ApiError
            ? err.message
            : "连接服务失败，请确认服务可用后重试",
      );
    } finally {
      setSubmitting(false);
    }
  };

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
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        <button className="btn primary" type="submit" disabled={!email.trim() || !password || submitting}>
          {submitting ? "登录中…" : "登录"}
        </button>
      </form>
    </div>
  );
}
