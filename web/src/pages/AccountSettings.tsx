import { FormEvent, useEffect, useState } from "react";
import { api, fetchMyWatermark, saveMyWatermark, type UserWatermarkStyle, type WatermarkConfig } from "../api";

// 个人设置：登录用户自助维护账号相关配置（下载水印署名与样式、登录密码）。
// 固定前缀由管理员集中配置；位置/字号/不透明度/颜色可在下方自定义，未设置前跟随管理员默认。
function mergedStyle(config: WatermarkConfig): UserWatermarkStyle {
  return {
    position: config.style?.position ?? config.styleDefaults.position,
    fontSize: config.style?.fontSize ?? config.styleDefaults.fontSize,
    opacity: config.style?.opacity ?? config.styleDefaults.opacity,
    color: config.style?.color ?? config.styleDefaults.color,
  };
}

export default function AccountSettings() {
  const [wm, setWm] = useState<{ enabled: boolean; text: string; style: UserWatermarkStyle }>({
    enabled: false,
    text: "",
    style: { position: "br", fontSize: 20, opacity: 0.6, color: "#ffffff" },
  });
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
        if (active) setWm({ enabled: config.enabled, text: config.text, style: mergedStyle(config) });
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
    setWmMessage(null);
    setWmError(null);
    if (!Number.isInteger(wm.style.fontSize) || wm.style.fontSize < 12 || wm.style.fontSize > 128) {
      setWmError("水印字号必须是 12–128 的整数");
      return;
    }
    if (Number.isNaN(wm.style.opacity) || wm.style.opacity < 0.1 || wm.style.opacity > 1) {
      setWmError("水印不透明度必须在 0.1–1 之间");
      return;
    }
    setWmSaving(true);
    try {
      const saved = await saveMyWatermark({ enabled: wm.enabled, text: wm.text.trim(), style: wm.style });
      setWm({ enabled: saved.enabled, text: saved.text, style: mergedStyle(saved) });
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
          <label htmlFor="wm-position">水印位置</label>
          <select
            id="wm-position"
            value={wm.style.position}
            disabled={wmLoading || wmSaving}
            onChange={(event) => setWm((cur) => ({ ...cur, style: { ...cur.style, position: event.target.value as UserWatermarkStyle["position"] } }))}
          >
            <option value="tl">左上</option>
            <option value="tc">中上</option>
            <option value="tr">右上</option>
            <option value="bl">左下</option>
            <option value="bc">中下</option>
            <option value="br">右下</option>
          </select>
          <label htmlFor="wm-font-size">字号（12–128）</label>
          <input
            id="wm-font-size"
            type="number"
            min={12}
            max={128}
            step={1}
            value={wm.style.fontSize}
            disabled={wmLoading || wmSaving}
            onChange={(event) => setWm((cur) => ({ ...cur, style: { ...cur.style, fontSize: Number(event.target.value) } }))}
            spellCheck={false}
          />
          <label htmlFor="wm-opacity">不透明度（0.1–1）</label>
          <input
            id="wm-opacity"
            type="number"
            min={0.1}
            max={1}
            step={0.05}
            value={wm.style.opacity}
            disabled={wmLoading || wmSaving}
            onChange={(event) => setWm((cur) => ({ ...cur, style: { ...cur.style, opacity: Number(event.target.value) } }))}
            spellCheck={false}
          />
          <label htmlFor="wm-color">文字颜色</label>
          <input
            id="wm-color"
            type="color"
            value={wm.style.color}
            disabled={wmLoading || wmSaving}
            onChange={(event) => setWm((cur) => ({ ...cur, style: { ...cur.style, color: event.target.value } }))}
          />
          <p className="muted">
            位置、字号、不透明度、颜色可自行调整，未自定义前跟随管理员的默认配置；「固定前缀」（如站名）始终由管理员统一附加。水印只加在下载的副本上，原图与
            API 返回不受影响。
          </p>
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
