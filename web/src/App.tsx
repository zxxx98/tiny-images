import { Navigate, NavLink, Route, Routes, useNavigate } from "react-router-dom";
import { getToken } from "./api";
import Admin from "./pages/Admin";
import Login from "./pages/Login";
import Playground from "./pages/Playground";

function RequireToken({ children }: { children: React.ReactElement }) {
  if (!getToken()) return <Navigate to="/login" replace />;
  return children;
}

export default function App() {
  const navigate = useNavigate();
  const logout = () => {
    localStorage.removeItem("tiny-admin-token");
    navigate("/login");
  };
  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">🪶 tiny-images</span>
        <nav>
          <NavLink to="/" end>
            Playground
          </NavLink>
          <NavLink to="/admin">管理后台</NavLink>
        </nav>
        {getToken() && (
          <button className="btn ghost small" onClick={logout}>
            登出
          </button>
        )}
      </header>
      <main>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route
            path="/"
            element={
              <RequireToken>
                <Playground />
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
      </main>
    </div>
  );
}
