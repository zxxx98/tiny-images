import { FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, setToken } from "../api";

export default function Login() {
  const [token, setLocalToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const prev = localStorage.getItem("tiny-admin-token");
    setToken(token.trim());
    try {
      await api("/admin/whoami");
      navigate("/");
    } catch {
      localStorage.setItem("tiny-admin-token", prev ?? "");
      setError("令牌无效或无权访问管理接口");
    }
  };

  return (
    <div className="login-wrap">
      <form className="card login-card" onSubmit={submit}>
        <h1>登录 tiny-images</h1>
        <p className="muted">输入 ADMIN_TOKEN 访问 Playground 与管理后台</p>
        <input
          type="password"
          placeholder="ADMIN_TOKEN"
          value={token}
          onChange={(e) => setLocalToken(e.target.value)}
          autoFocus
        />
        {error && <div className="error">{error}</div>}
        <button className="btn primary" type="submit" disabled={!token.trim()}>
          登录
        </button>
      </form>
    </div>
  );
}
