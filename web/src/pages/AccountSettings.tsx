import { FormEvent, useEffect, useState } from "react";
import { api, fetchMyWatermark, saveMyWatermark, type WatermarkConfig } from "../api";

// 个人设置：登录用户自助维护账号相关配置（下载水印署名、登录密码）。
// 水印样式（位置/字号/颜色/前缀）由管理员在「管理后台 → 设置」集中配置，这里只管开关与署名。
export default function AccountSettings() {
  const [wm, setWm] = useState<WatermarkConfig>({ enabled: false, text: "" });
  const [wmLoading, setWmLoading] = useState(true);
  const [wmSaving, setWmSaving] = useState(false);
  const [wmMessage, setWmMessage] = useState<string | null>(null);
  const [wmError, setWmError] = useState<string | null>(null);

  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [pwdSaving, setPwdSaving] = useState(false);
  const [pwdMessage, setPwdMessage] = useState<string | null>(null);
  const [pwdError, setPwdError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setWmLoading(true);
    fetchMyWatermark()
      .then((config) => {
        if (active) setWm(config);
      })
      .catch((err) => {
        if (active) setWmError(err instanceof Error ? err.message : "加载水印设置失败");
      })
      .finally(() => {
        if (active) setWmLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const submitWatermark = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setWmSaving(true);
    setWmMessage(null);
    setWmError(null);
    try {
      const saved = await saveMyWatermark({ enabled: wm.enabled, text: wm.text.trim() });
      setWm(saved);
      setWmMessage("水印设置已保存");
    } catch (err) {
      setWmError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setWmSaving(false);
    }
  };

  const submitPassword = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setPwdMessage(null);
    setPwdError(null);
    if (newPassword.length < 6) {
      setPwdError("新密码至少 6 位");
      return;
    }
    setPwdSaving(true);
    try {
      await api("/admin/auth/password", { method: "PUT", body: { oldPassword, newPassword } });
      setOldPassword("");
      setNewPassword("");
      setPwdMessage("密码已修改");
    } catch (err) {
      setPwdError(err instanceof Error ? err.message : "修改失败");
    } finally {
      setPwdSaving(false);
    }
  };

  return (
    <div className="account-settings">
      <div className="card">
        <h2>下载水印</h2>
        {wmMessage && (
          <div className="ok" role="status">
            {wmMessage}
          </div>
        )}
        {wmError && (
          <div className="error" role="alert">
            {wmError}
          </div>
        )}
        {wmLoading && (
          <div className="muted" role="status">
            正在加载水印设置…
          </div>
        )}
        <form className="inline-form" onSubmit={submitWatermark}>
          <div className="check-row">
            <input
              id="wm-enabled"
              type="checkbox"
              checked={wm.enabled}
              disabled={wmLoading || wmSaving}
              onChange={(event) => setWm((cur) => ({ ...cur, enabled: event.target.checked }))}
            />
            <label htmlFor="wm-enabled" className="check-label">
              下载图片时附加我的水印
            </label>
          </div>
          <label htmlFor="wm-text">署名文字</label>
          <input
            id="wm-text"
            type="text"
            value={wm.text}
            maxLength={60}
            disabled={wmLoading || wmSaving}
            onChange={(event) => setWm((cur) => ({ ...cur, text: event.target.value }))}
            placeholder="如：张三"
            spellCheck={false}
          />
          <p className="muted">样式（位置、字号、颜色、前缀）由管理员统一配置；水印只加在下载的副本上，原图与 API 返回不受影响。</p>
          <button className="btn primary" type="submit" disabled={wmLoading || wmSaving}>
            {wmSaving ? "保存中…" : "保存水印设置"}
          </button>
        </form>
      </div>
      <div className="card">
        <h2>修改密码</h2>
        {pwdMessage && (
          <div className="ok" role="status">
            {pwdMessage}
          </div>
        )}
        {pwdError && (
          <div className="error" role="alert">
            {pwdError}
          </div>
        )}
        <form className="inline-form" onSubmit={submitPassword}>
          <label htmlFor="pwd-old">当前密码</label>
          <input
            id="pwd-old"
            type="password"
            value={oldPassword}
            required
            autoComplete="current-password"
            disabled={pwdSaving}
            onChange={(event) => setOldPassword(event.target.value)}
          />
          <label htmlFor="pwd-new">新密码（至少 6 位）</label>
          <input
            id="pwd-new"
            type="password"
            value={newPassword}
            required
            minLength={6}
            autoComplete="new-password"
            disabled={pwdSaving}
            onChange={(event) => setNewPassword(event.target.value)}
          />
          <button className="btn primary" type="submit" disabled={pwdSaving}>
            {pwdSaving ? "提交中…" : "确认修改"}
          </button>
        </form>
      </div>
    </div>
  );
}
