import { FormEvent, useEffect, useState } from "react";
import {
  DEFAULT_WATERMARK_STYLE,
  fetchSettings,
  saveSettings,
  type PromptOptimizerSettings,
  type RegistrationSettings,
  type WatermarkStyle,
} from "../../api";

const EMPTY_OPTIMIZER: PromptOptimizerSettings = { baseUrl: "", apiKey: "", model: "" };
const DEFAULT_REGISTRATION: RegistrationSettings = { enabled: false, dailyQuota: 30 };
const EMPTY_REVERSE: PromptOptimizerSettings = { baseUrl: "", apiKey: "", model: "" };

export default function SettingsTab() {
  const [globalPrompt, setGlobalPrompt] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const [optimizer, setOptimizer] = useState<PromptOptimizerSettings>(EMPTY_OPTIMIZER);
  const [registration, setRegistration] = useState<RegistrationSettings>(DEFAULT_REGISTRATION);
  const [quotaText, setQuotaText] = useState(String(DEFAULT_REGISTRATION.dailyQuota));
  const [reverse, setReverse] = useState<PromptOptimizerSettings>(EMPTY_REVERSE);
  const [watermarkStyle, setWatermarkStyle] = useState<WatermarkStyle>(DEFAULT_WATERMARK_STYLE);
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
        setReverse(settings.promptReverse ?? EMPTY_REVERSE);
        setWatermarkStyle(settings.watermarkStyle ?? DEFAULT_WATERMARK_STYLE);
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
    if (!Number.isInteger(watermarkStyle.fontSize) || watermarkStyle.fontSize < 12 || watermarkStyle.fontSize > 128) {
      setError("水印字号必须是 12–128 的整数");
      return;
    }
    if (Number.isNaN(watermarkStyle.opacity) || watermarkStyle.opacity < 0.1 || watermarkStyle.opacity > 1) {
      setError("水印不透明度必须在 0.1–1 之间");
      return;
    }
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const next: RegistrationSettings = { ...registration, dailyQuota };
      const settings = await saveSettings({ globalPrompt, announcement, promptOptimizer: optimizer, promptReverse: reverse, registration: next, watermarkStyle });
      setGlobalPrompt(settings.globalPrompt);
      setAnnouncement(settings.announcement);
      setOptimizer(settings.promptOptimizer ?? EMPTY_OPTIMIZER);
      setReverse(settings.promptReverse ?? EMPTY_REVERSE);
      setWatermarkStyle(settings.watermarkStyle ?? watermarkStyle);
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
        <fieldset className="settings-group">
          <legend>生成与 AI</legend>
          <div className="settings-group-body">
            <label htmlFor="settings-global-prompt">全局提示词</label>
            <textarea
              id="settings-global-prompt"
              rows={8}
              value={globalPrompt}
              disabled={!loaded || saving}
              onChange={(event) => setGlobalPrompt(event.target.value)}
            />
            <p className="muted">会前置到全部图片生成和编辑请求；留空则不处理。</p>

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

            <h3>AI 图片反推</h3>
            <label htmlFor="settings-reverse-base-url">反推接口地址（OpenAI 兼容 chat 接口，需支持视觉）</label>
            <input
              id="settings-reverse-base-url"
              type="text"
              value={reverse.baseUrl}
              disabled={!loaded || saving}
              onChange={(event) => setReverse((cur) => ({ ...cur, baseUrl: event.target.value }))}
              placeholder="https://api.openai.com/v1"
              spellCheck={false}
            />
            <label htmlFor="settings-reverse-api-key">API Key</label>
            <input
              id="settings-reverse-api-key"
              type="password"
              value={reverse.apiKey}
              disabled={!loaded || saving}
              onChange={(event) => setReverse((cur) => ({ ...cur, apiKey: event.target.value }))}
              placeholder="sk-…"
              autoComplete="off"
              spellCheck={false}
            />
            <label htmlFor="settings-reverse-model">模型</label>
            <input
              id="settings-reverse-model"
              type="text"
              value={reverse.model}
              disabled={!loaded || saving}
              onChange={(event) => setReverse((cur) => ({ ...cur, model: event.target.value }))}
              placeholder="gpt-4o-mini / qwen-vl …"
              spellCheck={false}
            />
            <p className="muted">配置后 Playground 会出现「图片反推」模式，由视觉模型反推图片提示词；留空时使用上方「AI 提示词优化」的接口配置。</p>
          </div>
        </fieldset>

        <fieldset className="settings-group">
          <legend>站点公告</legend>
          <div className="settings-group-body">
            <label htmlFor="settings-announcement">公告</label>
            <textarea
              id="settings-announcement"
              rows={8}
              value={announcement}
              disabled={!loaded || saving}
              onChange={(event) => setAnnouncement(event.target.value)}
            />
            <p className="muted">仅在 Playground 自动弹出；留空则不展示。</p>
          </div>
        </fieldset>

        <fieldset className="settings-group">
          <legend>用户注册</legend>
          <div className="settings-group-body">
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
          </div>
        </fieldset>

        <fieldset className="settings-group">
          <legend>下载水印</legend>
          <div className="settings-group-body">
            <label htmlFor="settings-wm-position">水印位置</label>
            <select
              id="settings-wm-position"
              value={watermarkStyle.position}
              disabled={!loaded || saving}
              onChange={(event) => setWatermarkStyle((cur) => ({ ...cur, position: event.target.value as WatermarkStyle["position"] }))}
            >
              <option value="tl">左上</option>
              <option value="tc">中上</option>
              <option value="tr">右上</option>
              <option value="bl">左下</option>
              <option value="bc">中下</option>
              <option value="br">右下</option>
            </select>
            <label htmlFor="settings-wm-font-size">字号（12–128）</label>
            <input
              id="settings-wm-font-size"
              type="number"
              min={12}
              max={128}
              step={1}
              value={watermarkStyle.fontSize}
              disabled={!loaded || saving}
              onChange={(event) => setWatermarkStyle((cur) => ({ ...cur, fontSize: Number(event.target.value) }))}
              spellCheck={false}
            />
            <label htmlFor="settings-wm-opacity">不透明度（0.1–1）</label>
            <input
              id="settings-wm-opacity"
              type="number"
              min={0.1}
              max={1}
              step={0.05}
              value={watermarkStyle.opacity}
              disabled={!loaded || saving}
              onChange={(event) => setWatermarkStyle((cur) => ({ ...cur, opacity: Number(event.target.value) }))}
              spellCheck={false}
            />
            <label htmlFor="settings-wm-color">文字颜色</label>
            <input
              id="settings-wm-color"
              type="color"
              value={watermarkStyle.color}
              disabled={!loaded || saving}
              onChange={(event) => setWatermarkStyle((cur) => ({ ...cur, color: event.target.value }))}
            />
            <label htmlFor="settings-wm-prefix">固定前缀（如站名，可空）</label>
            <input
              id="settings-wm-prefix"
              type="text"
              maxLength={40}
              value={watermarkStyle.prefix}
              disabled={!loaded || saving}
              onChange={(event) => setWatermarkStyle((cur) => ({ ...cur, prefix: event.target.value }))}
              spellCheck={false}
            />
            <p className="muted">
              用户在顶栏「水印」弹窗开启后，下载的副本会以该样式附加「前缀 · 署名」文字；原图与 API 返回始终无水印。Docker 部署需包含 CJK 字体（默认 Dockerfile 已安装）。
            </p>
          </div>
        </fieldset>

        <button className="btn primary" type="submit" disabled={!loaded || saving}>
          {saving ? "保存中…" : "保存设置"}
        </button>
      </form>
    </div>
  );
}
