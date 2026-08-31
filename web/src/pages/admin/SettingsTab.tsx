import { FormEvent, useEffect, useState } from "react";
import { fetchSettings, saveSettings } from "../../api";

export default function SettingsTab() {
  const [globalPrompt, setGlobalPrompt] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchSettings()
      .then((settings) => {
        setGlobalPrompt(settings.globalPrompt);
        setAnnouncement(settings.announcement);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, []);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const settings = await saveSettings({ globalPrompt, announcement });
      setGlobalPrompt(settings.globalPrompt);
      setAnnouncement(settings.announcement);
      setMessage("设置已保存");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card">
      <h2>全局设置</h2>
      {message && <div className="ok" role="status">{message}</div>}
      {error && <div className="error" role="alert">{error}</div>}
      {loading && <div className="muted" role="status">正在加载设置…</div>}
      <form className="inline-form" onSubmit={submit}>
        <label htmlFor="settings-global-prompt">全局提示词</label>
        <textarea
          id="settings-global-prompt"
          rows={8}
          value={globalPrompt}
          disabled={loading || saving}
          onChange={(event) => setGlobalPrompt(event.target.value)}
        />
        <p className="muted">会前置到全部图片生成和编辑请求；留空则不处理。</p>

        <label htmlFor="settings-announcement">公告</label>
        <textarea
          id="settings-announcement"
          rows={8}
          value={announcement}
          disabled={loading || saving}
          onChange={(event) => setAnnouncement(event.target.value)}
        />
        <p className="muted">仅在 Playground 自动弹出；留空则不展示。</p>

        <button className="btn primary" type="submit" disabled={loading || saving}>
          {saving ? "保存中…" : "保存设置"}
        </button>
      </form>
    </div>
  );
}
