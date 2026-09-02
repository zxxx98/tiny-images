import { FormEvent, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ApiError, clearToken, fetchRegistrationEnabled, registerRequest, setRole, setToken } from "../api";

export default function Register() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [closed, setClosed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  // 注册入口未开启时展示提示；探测失败则保留表单，提交时由服务端判定
  useEffect(() => {
    let alive = true;
    fetchRegistrationEnabled()
      .then((enabled) => {
        if (alive && !enabled) setClosed(true);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError("两次输入的密码不一致");
      return;
    }
    setSubmitting(true);
    try {
      const r = await registerRequest(email.trim(), password);
      clearToken();
      setToken(r.token);
      setRole(r.role);
      navigate("/", { replace: true });
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 409
          ? "该邮箱已被注册"
          : err instanceof ApiError && err.status === 403
            ? "当前未开放注册"
            : err instanceof ApiError
              ? err.message
              : "连接服务失败，请确认服务可用后重试",
      );
    } finally {
      setSubmitting(false);
    }
  };

  if (closed) {
    return (
      <div className="login-wrap">
        <div className="card login-card">
          <div className="login-hero">
            <h1 className="rainbow">tiny-images 95</h1>
            <p className="muted">当前未开放注册</p>
          </div>
          <p className="muted register-closed-tip">管理员未开启用户注册，如需账号请联系管理员。</p>
          <Link className="btn primary register-link" to="/login">
            返回登录
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="login-wrap">
      <form className="card login-card" onSubmit={submit}>
        <div className="login-hero">
          <h1 className="rainbow">tiny-images 95</h1>
          <p className="muted">注册新账号</p>
        </div>
        <label htmlFor="register-email">邮箱</label>
        <input id="register-email" type="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
        <label htmlFor="register-password">密码（至少 6 位）</label>
        <input id="register-password" type="password" placeholder="密码" value={password} onChange={(e) => setPassword(e.target.value)} />
        <label htmlFor="register-confirm">确认密码</label>
        <input id="register-confirm" type="password" placeholder="再次输入密码" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        <button className="btn primary" type="submit" disabled={!email.trim() || password.length < 6 || submitting}>
          {submitting ? "注册中…" : "注册并进入"}
        </button>
        <p className="muted register-alt">
          已有账号？<Link to="/login">去登录</Link>
        </p>
      </form>
    </div>
  );
}
