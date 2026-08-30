import { FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError, api, setToken } from "../api";

export default function Login() {
  const [token, setLocalToken] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const prev = localStorage.getItem("tiny-admin-token");
    setToken(token.trim());
    setSubmitting(true);
    try {
      await api("/admin/whoami");
      navigate("/");
    } catch (err) {
      localStorage.setItem("tiny-admin-token", prev ?? "");
      setError(
        err instanceof ApiError && err.status === 401
          ? "令牌不正确，请核对后重试"
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
          <p className="muted">输入 ADMIN_TOKEN 访问 Playground 与管理后台</p>
        </div>
        <label htmlFor="login-token">ADMIN_TOKEN</label>
        <input
          id="login-token"
          type="password"
          placeholder="ADMIN_TOKEN"
          value={token}
          onChange={(e) => setLocalToken(e.target.value)}
          autoFocus
        />
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        <button className="btn primary" type="submit" disabled={!token.trim() || submitting}>
          {submitting ? "登录中…" : "登录"}
        </button>
      </form>
    </div>
  );
}
