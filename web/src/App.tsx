import { Component, ReactNode, useEffect } from "react";
import { Navigate, NavLink, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { getToken } from "./api";
import Admin from "./pages/Admin";
import Guide from "./pages/Guide";
import History from "./pages/History";
import Login from "./pages/Login";
import Playground from "./pages/Playground";

function RequireToken({ children }: { children: React.ReactElement }) {
  if (!getToken()) return <Navigate to="/login" replace />;
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
  "/history": "历史",
  "/admin": "管理后台",
  "/guide": "API 指南",
  "/login": "登录",
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

  useEffect(() => {
    document.title = `${TITLES[location.pathname] ?? "tiny-images"} · tiny-images 95`;
  }, [location.pathname]);

  const logout = () => {
    localStorage.removeItem("tiny-admin-token");
    navigate("/login");
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
          <NavLink to="/guide" className={({ isActive }) => `nav-btn ${isActive ? "active" : ""}`}>
            API 指南 <span className="badge-new">NEW!</span>
          </NavLink>
          <NavLink to="/history" className={({ isActive }) => `nav-btn ${isActive ? "active" : ""}`}>
            历史
          </NavLink>
          <NavLink to="/admin" className={({ isActive }) => `nav-btn ${isActive ? "active" : ""}`}>
            管理后台
          </NavLink>
        </nav>
        {getToken() && (
          <button className="btn small" onClick={logout}>
            登出
          </button>
        )}
      </div>
      <Marquee />
      <main>
        <ErrorBoundary>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/guide" element={<Guide />} />
            <Route
              path="/"
              element={
                <RequireToken>
                  <Playground />
                </RequireToken>
              }
            />
            <Route
              path="/history"
              element={
                <RequireToken>
                  <History />
                </RequireToken>
              }
            />
            <Route
              path="/admin"
              element={
                <RequireToken>
                  <Admin />
                </RequireToken>
              }
            />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </ErrorBoundary>
      </main>
      <footer className="app-footer">
        <span className="hit-counter">Visitors: 0001997 | Since 1995</span>
        <span>Best viewed in Netscape Navigator 3.0 at 800×600</span>
      </footer>
    </div>
  );
}
