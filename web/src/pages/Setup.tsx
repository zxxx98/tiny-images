import { FormEvent, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError, clearToken, setRole, setToken, setupAdmin } from "../api";

export default function Setup() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);
  const navigate = useNavigate();

  // 已存在 admin 时无需设置，直接去登录页
  useEffect(() => {
    fetch("/admin/auth/setup")
      .then((r) => r.json())
      .then((r: { needed?: boolean }) => {
        if (!r.needed) navigate("/login", { replace: true });
      })
      .catch(() => undefined)
      .finally(() => setChecking(false));
  }, [navigate]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError("两次输入的密码不一致");
      return;
    }
    setSubmitting(true);
    try {
      const r = await setupAdmin(email.trim(), password);
      clearToken();
      setToken(r.token);
      setRole(r.role);
      navigate("/", { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "设置失败，请重试");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="login-wrap">
      <form className="card login-card" onSubmit={submit}>
        <div className="login-hero">
          <h1 className="rainbow">tiny-images 95</h1>
          <p className="muted">首次使用：创建管理员账号</p>
        </div>
        <label htmlFor="setup-email">管理员邮箱</label>
        <input id="setup-email" type="email" placeholder="admin@example.com" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
        <label htmlFor="setup-password">密码（至少 6 位）</label>
        <input id="setup-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <label htmlFor="setup-confirm">确认密码</label>
        <input id="setup-confirm" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        <button className="btn primary" type="submit" disabled={checking || !email.trim() || password.length < 6 || submitting}>
          {submitting ? "创建中…" : "创建管理员并进入"}
        </button>
      </form>
    </div>
  );
}
