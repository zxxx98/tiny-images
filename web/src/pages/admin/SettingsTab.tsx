import { FormEvent, useEffect, useState } from "react";
import { fetchSettings, saveSettings, type PromptOptimizerSettings, type RegistrationSettings } from "../../api";

const EMPTY_OPTIMIZER: PromptOptimizerSettings = { baseUrl: "", apiKey: "", model: "" };
const DEFAULT_REGISTRATION: RegistrationSettings = { enabled: false, dailyQuota: 30 };

export default function SettingsTab() {
  const [globalPrompt, setGlobalPrompt] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const [optimizer, setOptimizer] = useState<PromptOptimizerSettings>(EMPTY_OPTIMIZER);
  const [registration, setRegistration] = useState<RegistrationSettings>(DEFAULT_REGISTRATION);
  const [quotaText, setQuotaText] = useState(String(DEFAULT_REGISTRATION.dailyQuota));
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = (): void => {
    setLoading(true);
    setLoaded(false);
    setError(null);
    fetchSettings()
      .then((settings) => {
        setGlobalPrompt(settings.globalPrompt);
        setAnnouncement(settings.announcement);
        setOptimizer(settings.promptOptimizer ?? EMPTY_OPTIMIZER);
        const reg = settings.registration ?? DEFAULT_REGISTRATION;
        setRegistration(reg);
        setQuotaText(String(reg.dailyQuota));
        setLoaded(true);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
    // 初次进入设置页时加载一次；后续失败重试由按钮触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!loaded) return;
    const dailyQuota = Number(quotaText);
    if (!Number.isInteger(dailyQuota) || dailyQuota <= 0) {
      setError("注册用户每日额度必须是正整数");
      return;
    }
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const next: RegistrationSettings = { ...registration, dailyQuota };
      const settings = await saveSettings({ globalPrompt, announcement, promptOptimizer: optimizer, registration: next });
      setGlobalPrompt(settings.globalPrompt);
      setAnnouncement(settings.announcement);
      setOptimizer(settings.promptOptimizer ?? EMPTY_OPTIMIZER);
      const reg = settings.registration ?? next;
      setRegistration(reg);
      setQuotaText(String(reg.dailyQuota));
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
      {!loading && !loaded && (
        <button className="btn" type="button" onClick={load}>
          重试
        </button>
      )}
      <form className="inline-form" onSubmit={submit}>
        <label htmlFor="settings-global-prompt">全局提示词</label>
        <textarea
          id="settings-global-prompt"
          rows={8}
          value={globalPrompt}
          disabled={!loaded || saving}
          onChange={(event) => setGlobalPrompt(event.target.value)}
        />
        <p className="muted">会前置到全部图片生成和编辑请求；留空则不处理。</p>

        <label htmlFor="settings-announcement">公告</label>
        <textarea
          id="settings-announcement"
          rows={8}
          value={announcement}
          disabled={!loaded || saving}
          onChange={(event) => setAnnouncement(event.target.value)}
        />
        <p className="muted">仅在 Playground 自动弹出；留空则不展示。</p>

        <h3>AI 提示词优化</h3>
        <label htmlFor="settings-ai-base-url">AI 接口地址（OpenAI 兼容 chat 接口）</label>
        <input
          id="settings-ai-base-url"
          type="text"
          value={optimizer.baseUrl}
          disabled={!loaded || saving}
          onChange={(event) => setOptimizer((cur) => ({ ...cur, baseUrl: event.target.value }))}
          placeholder="https://api.openai.com/v1"
          spellCheck={false}
        />
        <label htmlFor="settings-ai-api-key">API Key</label>
        <input
          id="settings-ai-api-key"
          type="password"
          value={optimizer.apiKey}
          disabled={!loaded || saving}
          onChange={(event) => setOptimizer((cur) => ({ ...cur, apiKey: event.target.value }))}
          placeholder="sk-…"
          autoComplete="off"
          spellCheck={false}
        />
        <label htmlFor="settings-ai-model">模型</label>
        <input
          id="settings-ai-model"
          type="text"
          value={optimizer.model}
          disabled={!loaded || saving}
          onChange={(event) => setOptimizer((cur) => ({ ...cur, model: event.target.value }))}
          placeholder="gpt-4o-mini"
          spellCheck={false}
        />
        <p className="muted">配置后 Playground 的 Prompt 输入框会出现「AI 优化」按钮；接口地址与模型任一留空则不启用。</p>

        <h3>用户注册</h3>
        <div className="check-row">
          <input
            id="settings-registration-enabled"
            type="checkbox"
            checked={registration.enabled}
            disabled={!loaded || saving}
            onChange={(event) => setRegistration((cur) => ({ ...cur, enabled: event.target.checked }))}
          />
          <label htmlFor="settings-registration-enabled" className="check-label">启用用户注册</label>
        </div>
        <label htmlFor="settings-registration-daily-quota">注册用户每日额度（张）</label>
        <input
          id="settings-registration-daily-quota"
          type="number"
          min={1}
          step={1}
          value={quotaText}
          disabled={!loaded || saving}
          onChange={(event) => setQuotaText(event.target.value)}
          spellCheck={false}
        />
        <p className="muted">启用后登录页出现「注册」入口，访客可用邮箱和密码自助注册，新账号默认每天可生成该数量的图片；关闭只影响新注册，已有账号不受影响。</p>

        <button className="btn primary" type="submit" disabled={!loaded || saving}>
          {saving ? "保存中…" : "保存设置"}
        </button>
      </form>
    </div>
  );
}
