import { Component, FormEvent, ReactNode, useEffect, useState } from "react";
import { Navigate, NavLink, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { api, clearToken, fetchMe, fetchSetupNeeded, getRole, getToken, QUOTA_EVENT, setRole, type Me } from "./api";
import { APP_VERSION, GIT_HASH } from "./version";
import FormDialog from "./pages/FormDialog";
import Admin from "./pages/Admin";
import Guide from "./pages/Guide";
import History from "./pages/History";
import Plaza from "./pages/Plaza";
import Login from "./pages/Login";
import Playground from "./pages/Playground";
import Register from "./pages/Register";
import Setup from "./pages/Setup";
import Status from "./pages/Status";

function RequireToken({ children, setupNeeded }: { children: React.ReactElement; setupNeeded: boolean }) {
  if (!getToken()) return <Navigate to={setupNeeded ? "/setup" : "/login"} replace />;
  return children;
}

function RequireAdmin({ children, setupNeeded }: { children: React.ReactElement; setupNeeded: boolean }) {
  if (!getToken()) return <Navigate to={setupNeeded ? "/setup" : "/login"} replace />;
  if (getRole() !== "admin") return <Navigate to="/" replace />;
  return children;
}

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div className="card">
          <h2>页面出错了</h2>
          <p className="mono">{this.state.error.message}</p>
          <button className="btn" onClick={() => window.location.reload()}>
            刷新页面
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

const TITLES: Record<string, string> = {
  "/": "Playground",
  "/status": "模型状态",
  "/history": "历史",
  "/plaza": "广场",
  "/admin": "管理后台",
  "/guide": "API 指南",
  "/login": "登录",
  "/register": "注册",
};

function Marquee() {
  return (
    <div className="marquee" aria-hidden="true">
      <div className="marquee-track">
        <span className="c1">★ Welcome to tiny-images 95 ★</span>
        <span className="c2">OpenAI 兼容生图网关</span>
        <span className="c3">一个 Key，接全部上游渠道</span>
        <span className="c4">NEW! 流式 SSE 生成已上线</span>
        <span className="c5">Best viewed at 800x600</span>
        <span className="c1">★ Sign my guestbook ★</span>
      </div>
    </div>
  );
}

export default function App() {
  const navigate = useNavigate();
  const location = useLocation();
  const [me, setMe] = useState<Me | null>(null);
  const [setupNeeded, setSetupNeeded] = useState(false);
  const [pwdOpen, setPwdOpen] = useState(false);
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [pwdError, setPwdError] = useState<string | null>(null);

  useEffect(() => {
    document.title = `${TITLES[location.pathname] ?? "tiny-images"} · tiny-images 95`;
  }, [location.pathname]);

  useEffect(() => {
    if (getToken()) return;
    // 未登录时探测是否需要首次设置 admin
    fetchSetupNeeded()
      .then(setSetupNeeded)
      .catch(() => setSetupNeeded(false));
  }, [location.pathname]);

  useEffect(() => {
    if (!getToken()) return;
    fetchMe()
      .then(setMe)
      .catch(() => setMe(null));
  }, [location.pathname]);

  // 生成结束等时机刷新顶栏额度
  useEffect(() => {
    const refresh = (): void => {
      if (!getToken()) return;
      fetchMe()
        .then(setMe)
        .catch(() => undefined);
    };
    window.addEventListener(QUOTA_EVENT, refresh);
    return () => window.removeEventListener(QUOTA_EVENT, refresh);
  }, []);

  const logout = () => {
    clearToken();
    setRole(null);
    navigate("/login");
  };

  const closePwdDialog = (): void => {
    setPwdOpen(false);
    setOldPassword("");
    setNewPassword("");
    setPwdError(null);
  };

  const submitPassword = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setPwdError(null);
    try {
      await api("/admin/auth/password", { method: "PUT", body: { oldPassword, newPassword } });
      closePwdDialog();
      window.alert("密码已修改");
    } catch (err) {
      setPwdError(err instanceof Error ? err.message : "修改失败");
    }
  };
  return (
    <div className="app">
      <header className="titlebar">
        <span className="brand">🪶 tiny-images 95</span>
        <span className="win-buttons" aria-hidden="true">
          <span>_</span>
          <span>□</span>
          <span>×</span>
        </span>
      </header>
      <div className="menubar">
        <nav>
          <NavLink to="/" end className={({ isActive }) => `nav-btn ${isActive ? "active" : ""}`}>
            Playground
          </NavLink>
          <NavLink to="/status" className={({ isActive }) => `nav-btn ${isActive ? "active" : ""}`}>
            模型状态
          </NavLink>
          <NavLink to="/guide" className={({ isActive }) => `nav-btn ${isActive ? "active" : ""}`}>
            API 指南 <span className="badge-new">NEW!</span>
          </NavLink>
          <NavLink to="/history" className={({ isActive }) => `nav-btn ${isActive ? "active" : ""}`}>
            历史
          </NavLink>
          <NavLink to="/plaza" className={({ isActive }) => `nav-btn ${isActive ? "active" : ""}`}>
            广场 <span className="badge-new">NEW!</span>
          </NavLink>
          {getRole() === "admin" && (
            <NavLink to="/admin" className={({ isActive }) => `nav-btn ${isActive ? "active" : ""}`}>
              管理后台
            </NavLink>
          )}
        </nav>
        {getToken() && me && (
          <span className="muted">
            {me.email}
            {me.quotaRemaining !== null ? ` · 剩余额度 ${me.quotaRemaining}/${me.quotaTotal}` : ""}
          </span>
        )}
        {getToken() && (
          <span className="tip" data-tip="修改当前账号的登录密码">
            <button className="btn small" onClick={() => setPwdOpen(true)}>
              改密码
            </button>
          </span>
        )}
        {getToken() && (
          <button className="btn small" onClick={logout}>
            登出
          </button>
        )}
      </div>
      <Marquee />
      {pwdOpen && (
        <FormDialog title="修改密码" onClose={closePwdDialog}>
          {pwdError && (
            <div className="error" role="alert">
              {pwdError}
            </div>
          )}
          <form onSubmit={submitPassword}>
            <label htmlFor="pwd-old">当前密码</label>
            <input id="pwd-old" type="password" value={oldPassword} onChange={(e) => setOldPassword(e.target.value)} required autoComplete="current-password" />
            <label htmlFor="pwd-new">新密码（至少 6 位）</label>
            <input id="pwd-new" type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required minLength={6} autoComplete="new-password" />
            <div className="row">
              <button className="btn primary" type="submit">
                确认修改
              </button>
              <button className="btn ghost" type="button" onClick={closePwdDialog}>
                取消
              </button>
            </div>
          </form>
        </FormDialog>
      )}
      <main>
        <ErrorBoundary>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/register" element={<Register />} />
            <Route path="/setup" element={<Setup />} />
            <Route path="/guide" element={<Guide />} />
            <Route
              path="/"
              element={
                <RequireToken setupNeeded={setupNeeded}>
                  <Playground />
                </RequireToken>
              }
            />
            <Route
              path="/status"
              element={
                <RequireToken setupNeeded={setupNeeded}>
                  <Status />
                </RequireToken>
              }
            />
            <Route
              path="/history"
              element={
                <RequireToken setupNeeded={setupNeeded}>
                  <History />
                </RequireToken>
              }
            />
            <Route
              path="/plaza"
              element={
                <RequireToken setupNeeded={setupNeeded}>
                  <Plaza />
                </RequireToken>
              }
            />
            <Route
              path="/admin"
              element={
                <RequireAdmin setupNeeded={setupNeeded}>
                  <Admin />
                </RequireAdmin>
              }
            />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </ErrorBoundary>
      </main>
      <footer className="app-footer">
        <span className="hit-counter">Visitors: 0001997 | Since 1995</span>
        <span className="hit-counter version-badge tip" data-tip={`Commit ${GIT_HASH}`}>
          {APP_VERSION}
        </span>
        <span>Best viewed in Netscape Navigator 3.0 at 800×600</span>
      </footer>
    </div>
  );
}
