import { FormEvent, KeyboardEvent, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, fetchChannelHealth, getToken, type ApiKey, type Channel, type ChannelHealth, type ChannelKey, type LogRow, type ModelMapping, type UserView } from "../api";
import FormDialog from "./FormDialog";
import { Pager, usePager } from "./Pager";
import GroupsTab from "./admin/GroupsTab";
import UsersTab from "./admin/UsersTab";
import SettingsTab from "./admin/SettingsTab";
import TemplatesTab from "./admin/TemplatesTab";

type Tab = "channels" | "models" | "keys" | "logs" | "groups" | "users" | "templates" | "settings";

const TABS: [Tab, string][] = [
  ["channels", "渠道"],
  ["groups", "分组"],
  ["models", "模型映射"],
  ["keys", "API Keys"],
  ["users", "用户"],
  ["templates", "模板库"],
  ["logs", "请求日志"],
  ["settings", "设置"],
];

const TABLE_PAGE_SIZE = 20;

const fmtTime = (ts: number): string => new Date(ts).toLocaleString();

export default function Admin() {
  const [sp, setSp] = useSearchParams();
  const raw = sp.get("tab");
  const tab: Tab = TABS.some(([id]) => id === raw) ? (raw as Tab) : "channels";
  const switchTab = (id: Tab): void => {
    setSp(id === "channels" ? {} : { tab: id }, { replace: true });
  };

  return (
    <div className="admin">
      <div className="tabs" role="tablist" aria-label="管理后台分区">
        {TABS.map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={`tab ${tab === id ? "active" : ""}`} onClick={() => switchTab(id)}>
            {label}
          </button>
        ))}
      </div>
      <div role="tabpanel">
        {tab === "channels" && <ChannelsTab />}
        {tab === "groups" && <GroupsTab />}
        {tab === "models" && <ModelsTab />}
        {tab === "keys" && <ApiKeysTab />}
        {tab === "users" && <UsersTab />}
        {tab === "templates" && <TemplatesTab />}
        {tab === "logs" && <LogsTab />}
        {tab === "settings" && <SettingsTab />}
      </div>
    </div>
  );
}

// ---- 渠道 ----

export function newChannelDraft(): Partial<Channel> {
  return { type: "openai-compat", generationMode: "images", editMode: "auto", timeoutMs: 120000, concurrency: 2, allowPrivateImageFetch: false, enabled: true };
}

export function changeChannelType(draft: Partial<Channel>, type: Channel["type"]): Partial<Channel> {
  const addHordeDefault = type === "ai-horde" && draft.id === undefined && !draft.baseUrl;
  return { ...draft, type, ...(addHordeDefault ? { baseUrl: "https://aihorde.net/api/v2" } : {}) };
}

const healthLabel: Record<ChannelHealth["status"], string> = {
  disabled: "停用",
  "no-key": "无可用 Key",
  "circuit-open": "熔断中",
  unknown: "暂无样本",
  error: "有失败",
  healthy: "正常",
};

const healthClass = (status: ChannelHealth["status"]): string =>
  status === "healthy" ? "" : status === "unknown" ? "off" : "error";

const fmtRate = (rate: number | null): string => (rate === null ? "—" : `${Math.round(rate * 100)}%`);
const fmtLatency = (latency: number | null): string => (latency === null ? "—" : `${latency} ms`);

function ChannelsTab() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [health, setHealth] = useState<ChannelHealth[]>([]);
  const [editing, setEditing] = useState<Partial<Channel> | null>(null);
  const [headersText, setHeadersText] = useState("{}");
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = (): void => {
    Promise.all([api<Channel[]>("/admin/channels"), fetchChannelHealth()])
      .then(([nextChannels, nextHealth]) => {
        setChannels(nextChannels);
        setHealth(nextHealth);
      })
      .catch((e) => setError(e.message));
  };
  useEffect(() => {
    load();
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") load();
    }, 5000);
    return () => window.clearInterval(timer);
  }, []);

  // 编辑器里的 Headers 用独立草稿文本，失焦/保存时才解析，避免输入过程被重置
  const openEdit = (c: Partial<Channel> | null): void => {
    const target = c ?? newChannelDraft();
    setEditing(target);
    setHeadersText(JSON.stringify(target.extraHeaders ?? {}));
  };

  const save = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!editing) return;
    setError(null);
    let extraHeaders: Record<string, string> = {};
    const rawText = headersText.trim();
    if (rawText && rawText !== "{}") {
      try {
        const parsed: unknown = JSON.parse(rawText);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
        extraHeaders = parsed as Record<string, string>;
      } catch {
        setError('额外 Headers 不是合法的 JSON 对象，例如 {"x-foo":"bar"}');
        return;
      }
    }
    try {
      const body = { ...editing, extraHeaders };
      if (editing.id) await api(`/admin/channels/${editing.id}`, { method: "PATCH", body });
      else await api("/admin/channels", { method: "POST", body });
      setEditing(null);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const remove = async (id: number): Promise<void> => {
    if (!confirm("删除该渠道会同时删除其 keys 与模型映射，确认？")) return;
    await api(`/admin/channels/${id}`, { method: "DELETE" });
    load();
  };

  const toggle = async (c: Channel): Promise<void> => {
    await api(`/admin/channels/${c.id}`, { method: "PATCH", body: { enabled: !c.enabled } });
    load();
  };

  const testChannel = async (id: number): Promise<void> => {
    setMsg(null);
    setError(null);
    try {
      const r = await api<{ ok: boolean; message: string }>(`/admin/channels/${id}/test`, { method: "POST" });
      setMsg(r.ok ? `连通性测试通过：${r.message}` : `测试失败：${r.message}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const addKey = async (channelId: number, apiKey: string): Promise<void> => {
    if (!apiKey.trim()) return;
    await api(`/admin/channels/${channelId}/keys`, { method: "POST", body: { apiKey } });
    load();
  };
  const removeKey = async (keyId: number): Promise<void> => {
    if (!confirm("确认删除该上游 key？")) return;
    await api(`/admin/keys/${keyId}`, { method: "DELETE" });
    load();
  };
  const toggleKey = async (key: ChannelKey): Promise<void> => {
    await api(`/admin/keys/${key.id}`, { method: "PATCH", body: { enabled: !key.enabled } });
    load();
  };

  const healthByChannel = new Map(health.map((item) => [item.channelId, item]));
  const healthyCount = health.filter((item) => item.status === "healthy").length;
  const errorCount = health.filter((item) => item.status === "error" || item.status === "circuit-open" || item.status === "no-key").length;
  const availableKeys = health.reduce((sum, item) => sum + item.keys.available, 0);

  return (
    <div className="card">
      {msg && (
        <div className="ok" role="status">
          {msg}
        </div>
      )}
      {error && !editing && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      <div className="health-overview" aria-label="渠道健康度总览">
        <strong>健康度</strong>
        <span className="pill">渠道 {channels.length}</span>
        <span className="pill">正常 {healthyCount}</span>
        <span className={`pill ${errorCount ? "error" : ""}`}>需关注 {errorCount}</span>
        <span className="pill">可用 Key {availableKeys}</span>
        <button className="btn small tip" onClick={load} data-tip="重新拉取渠道列表与健康度">
          刷新
        </button>
      </div>
      <button className="btn primary tip" onClick={() => openEdit(null)} data-tip="添加一个上游生图服务">
        新建渠道
      </button>
      {editing && (
        <FormDialog title={editing.id ? "编辑渠道" : "新建渠道"} onClose={() => setEditing(null)}>
          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}
          <form onSubmit={save}>
            <label htmlFor="ch-name">名称</label>
            <input id="ch-name" value={editing.name ?? ""} onChange={(e) => setEditing({ ...editing, name: e.target.value })} required />
            <label htmlFor="ch-type">渠道类型</label>
            <select
              id="ch-type"
              value={editing.type ?? "openai-compat"}
              onChange={(e) => setEditing(changeChannelType(editing, e.target.value as Channel["type"]))}
            >
              <option value="openai-compat">OpenAI Compatible</option>
              <option value="ai-horde">AI Horde</option>
            </select>
            <label htmlFor="ch-base-url">Base URL</label>
            <input
              id="ch-base-url"
              placeholder={editing.type === "ai-horde" ? "https://aihorde.net/api/v2" : "https://api.openai.com/v1"}
              value={editing.baseUrl ?? ""}
              onChange={(e) => setEditing({ ...editing, baseUrl: e.target.value })}
              required
            />
            <label htmlFor="ch-timeout" className="tip" data-tip="单次上游请求的最长等待时间">
              超时（毫秒）
            </label>
            <input
              id="ch-timeout"
              type="number"
              min={1000}
              step={1000}
              value={editing.timeoutMs ?? 120000}
              onChange={(e) => setEditing({ ...editing, timeoutMs: Number(e.target.value) })}
            />
            <label htmlFor="ch-concurrency" className="tip" data-tip="该渠道同时处理的最大请求数">
              并发数
            </label>
            <input
              id="ch-concurrency"
              type="number"
              min={1}
              step={1}
              value={editing.concurrency ?? 2}
              onChange={(e) => setEditing({ ...editing, concurrency: Number(e.target.value) })}
            />
            {editing.type === "ai-horde" ? (
              <p className="muted">
                AI Horde 是排队式异步服务，生成速度取决于在线 worker；图片编辑能力也取决于所选模型和 worker。可填写注册 key，匿名调用请使用 0000000000。
              </p>
            ) : (
              <>
                <label htmlFor="ch-generation-mode">图片生成请求方式</label>
                <select id="ch-generation-mode" value={editing.generationMode ?? "images"} onChange={(e) => setEditing({ ...editing, generationMode: e.target.value as Channel["generationMode"] })}>
                  <option value="images">Images API（/images/generations）</option>
                  <option value="chat">Chat API（/chat/completions）</option>
                </select>
                <p className="muted">Chat 模式会把现有图片生成请求转为 chat 请求，并把返回图片统一为 Images API 格式。</p>
                <label htmlFor="ch-edit-mode">图片编辑请求方式（edits）</label>
                <select id="ch-edit-mode" value={editing.editMode ?? "auto"} onChange={(e) => setEditing({ ...editing, editMode: e.target.value as Channel["editMode"] })}>
                  <option value="auto">auto（自动回退）</option>
                  <option value="multipart">multipart（标准表单上传）</option>
                  <option value="json-base64">json-base64（JSON + base64 图片）</option>
                </select>
              </>
            )}
            <label htmlFor="ch-headers" className="tip" data-tip="以 JSON 对象透传给上游的附加请求头">
              额外 Headers（JSON，可选）
            </label>
            <textarea
              id="ch-headers"
              className="mono"
              rows={2}
              value={headersText}
              onChange={(e) => setHeadersText(e.target.value)}
              placeholder='{"x-foo":"bar"}'
              spellCheck={false}
            />
            <label className="check" title="仅对可信的局域网上游启用；开启后该渠道返回的图片 URL 可以访问私网地址。">
              <input type="checkbox" checked={editing.allowPrivateImageFetch ?? false} onChange={(e) => setEditing({ ...editing, allowPrivateImageFetch: e.target.checked })} /> 允许抓取私网图片
            </label>
            <label className="check">
              <input type="checkbox" checked={editing.enabled ?? true} onChange={(e) => setEditing({ ...editing, enabled: e.target.checked })} /> 启用
            </label>
            <div className="row">
              <button className="btn primary" type="submit">
                保存
              </button>
              <button className="btn ghost" type="button" onClick={() => setEditing(null)}>
                取消
              </button>
            </div>
          </form>
        </FormDialog>
      )}
      {channels.length === 0 && <p className="muted">还没有渠道。点击「新建渠道」添加上游生图服务，然后为它录入 apiKey。</p>}
      {channels.map((c) => (
        <div key={c.id} className="entity">
          <div className="entity-head">
            <strong>{c.name}</strong>
            {healthByChannel.get(c.id) && (
              <span
                className={`pill tip ${healthClass(healthByChannel.get(c.id)!.status)}`}
                data-tip={`成功率 ${fmtRate(healthByChannel.get(c.id)!.requests.successRate)} · 平均延迟 ${fmtLatency(healthByChannel.get(c.id)!.requests.averageLatencyMs)}`}
              >
                {healthLabel[healthByChannel.get(c.id)!.status]}
              </span>
            )}
            <span className="pill">{c.type === "ai-horde" ? "AI Horde" : "OpenAI Compatible"}</span>
            <span className="pill">并发 {c.concurrency}</span>
            <span className={`pill ${c.enabled ? "" : "off"}`}>{c.enabled ? "启用" : "停用"}</span>
            <span className="muted mono">{c.baseUrl}</span>
            <span className="spacer" />
            <span className="tip tip-end" data-tip="向上游发送一次真实请求，验证配置与连通性">
              <button className="btn small" onClick={() => testChannel(c.id)}>
                测试连通性
              </button>
            </span>
            <span className="tip tip-end" data-tip="修改渠道配置">
              <button className="btn small" onClick={() => openEdit(c)}>
                编辑
              </button>
            </span>
            <span className="tip tip-end" data-tip={c.enabled ? "停用后不再向该渠道分发请求" : "重新启用该渠道"}>
              <button className="btn small" onClick={() => toggle(c)}>
                {c.enabled ? "停用" : "启用"}
              </button>
            </span>
            <span className="tip tip-end" data-tip="删除渠道会同时删除它的 keys 与模型映射">
              <button className="btn small danger" onClick={() => remove(c.id)}>
                删除
              </button>
            </span>
          </div>
          {healthByChannel.get(c.id) && (
            <div className="health-details muted">
              <span>请求样本 {healthByChannel.get(c.id)!.requests.sampleSize}</span>
              <span>成功率 {fmtRate(healthByChannel.get(c.id)!.requests.successRate)}</span>
              <span>平均延迟 {fmtLatency(healthByChannel.get(c.id)!.requests.averageLatencyMs)}</span>
              <span>Key {healthByChannel.get(c.id)!.keys.available}/{healthByChannel.get(c.id)!.keys.enabled} 可用</span>
              {healthByChannel.get(c.id)!.requests.lastError && <span className="error-cell">最近错误：{healthByChannel.get(c.id)!.requests.lastError}</span>}
            </div>
          )}
          <div className="keys">
            {(c.keys ?? []).map((k) => (
              <span key={k.id} className={`pill mono ${k.enabled ? "" : "off"}`}>
                {maskKey(k.apiKey)}
                <span className="tip" data-tip={k.enabled ? "停用该 key（不删除）" : "重新启用该 key"}>
                  <button className="link" onClick={() => toggleKey(k)}>
                    {k.enabled ? "停用" : "启用"}
                  </button>
                </span>
                <span className="tip" data-tip="从该渠道删除此 key">
                  <button className="link danger" onClick={() => removeKey(k.id)}>
                    删除
                  </button>
                </span>
              </span>
            ))}
            <KeyInput onAdd={(key) => addKey(c.id, key)} />
          </div>
        </div>
      ))}
    </div>
  );
}

function KeyInput({ onAdd }: { onAdd: (key: string) => void }) {
  const [value, setValue] = useState("");
  const add = (): void => {
    onAdd(value);
    setValue("");
  };
  return (
    <span className="key-input">
      <input
        aria-label="添加上游 apiKey"
        placeholder="添加上游 apiKey…"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") add();
        }}
      />
      <span className="tip" data-tip="回车或点击添加，key 仅在列表中脱敏显示">
        <button className="btn small" onClick={add}>
          添加
        </button>
      </span>
    </span>
  );
}

function maskKey(key: string): string {
  if (key.length <= 10) return `${key.slice(0, 2)}…${key.slice(-2)}`;
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

// ---- 模型映射 ----

function ModelsTab() {
  const [models, setModels] = useState<ModelMapping[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [editing, setEditing] = useState<Partial<ModelMapping> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pager = usePager(models, TABLE_PAGE_SIZE);

  const load = (): void => {
    api<ModelMapping[]>("/admin/models").then(setModels).catch((e) => setError(e.message));
    api<Channel[]>("/admin/channels").then(setChannels).catch(() => undefined);
  };
  useEffect(load, []);

  const save = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!editing) return;
    setError(null);
    try {
      if (editing.id) await api(`/admin/models/${editing.id}`, { method: "PATCH", body: editing });
      else await api("/admin/models", { method: "POST", body: editing });
      setEditing(null);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const remove = async (id: number): Promise<void> => {
    if (!confirm("确认删除该模型映射？删除后外部将无法再调用这个 model 名。")) return;
    await api(`/admin/models/${id}`, { method: "DELETE" });
    load();
  };

  return (
    <div className="card">
      {error && !editing && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      <span className="tip" data-tip={channels.length === 0 ? "请先在「渠道」页添加并启用一个渠道" : "把对外 model 名路由到某个渠道的上游模型"}>
        <button className="btn primary" onClick={() => setEditing({ enabled: true, supportsImageToImage: false, supportsNsfw: false })} disabled={channels.length === 0}>
          新建映射
        </button>
      </span>
      {channels.length === 0 && <p className="muted">还没有渠道。请先在「渠道」页添加并启用一个渠道，再建立模型映射。</p>}
      <p className="muted">同一个对外 model 名可建多条映射（如主备渠道），按优先级从小到大依次尝试；某渠道连续失败会自动熔断冷却。</p>
      {editing && (
        <FormDialog title={editing.id ? "编辑映射" : "新建映射"} onClose={() => setEditing(null)}>
          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}
          <form onSubmit={save}>
            <label htmlFor="m-public">对外 model 名（调用方使用）</label>
            <input id="m-public" value={editing.publicName ?? ""} onChange={(e) => setEditing({ ...editing, publicName: e.target.value })} required />
            <label htmlFor="m-channel">渠道</label>
            <select id="m-channel" value={editing.channelId ?? ""} onChange={(e) => setEditing({ ...editing, channelId: Number(e.target.value) })} required>
              <option value="" disabled>
                选择渠道…
              </option>
              {channels.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <label htmlFor="m-upstream">上游 model 名（留空则同对外名）</label>
            <input id="m-upstream" value={editing.upstreamName ?? ""} onChange={(e) => setEditing({ ...editing, upstreamName: e.target.value })} />

            <label htmlFor="m-priority" className="tip" data-tip="数字越小越先用；多条映射按此顺序故障转移">
              优先级（数字越小越先用，用于多渠道故障转移）
            </label>
            <input
              id="m-priority"
              type="number"
              step={1}
              value={editing.priority ?? 0}
              onChange={(e) => setEditing({ ...editing, priority: Number(e.target.value) })}
            />
            <label className="check tip" data-tip="勾选后该模型可用于图片编辑（图生图）">
              <input
                type="checkbox"
                checked={editing.supportsImageToImage ?? false}
                onChange={(e) => setEditing({ ...editing, supportsImageToImage: e.target.checked })}
              />{" "}
              支持图生图
            </label>
            <label className="check tip" data-tip="勾选后仅对开启 NSFW 权限的用户开放">
              <input
                type="checkbox"
                checked={editing.supportsNsfw ?? false}
                onChange={(e) => setEditing({ ...editing, supportsNsfw: e.target.checked })}
              />{" "}
              支持 NSFW
            </label>
            <label className="check">
              <input type="checkbox" checked={editing.enabled ?? true} onChange={(e) => setEditing({ ...editing, enabled: e.target.checked })} /> 启用
            </label>
            <div className="row">
              <button className="btn primary" type="submit">
                保存
              </button>
              <button className="btn ghost" type="button" onClick={() => setEditing(null)}>
                取消
              </button>
            </div>
          </form>
        </FormDialog>
      )}
      {models.length === 0 && <p className="muted">还没有模型映射。</p>}
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>对外 model</th>
              <th>优先级</th>
              <th>渠道</th>
              <th>上游 model</th>
              <th>图生图</th>
              <th>NSFW</th>
              <th>状态</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {pager.slice.map((m) => (
              <tr key={m.id}>
                <td className="mono">{m.publicName}</td>
                <td>{m.priority}</td>
                <td>{m.channelName ?? m.channelId}</td>
                <td className="mono">{m.upstreamName}</td>
                <td>
                  <span className={`pill ${m.supportsImageToImage ? "" : "off"}`}>{m.supportsImageToImage ? "支持" : "不支持"}</span>
                </td>
                <td>
                  <span className={`pill ${m.supportsNsfw ? "" : "off"}`}>{m.supportsNsfw ? "支持" : "不支持"}</span>
                </td>
                <td>
                  <span className={`pill ${m.enabled ? "" : "off"}`}>{m.enabled ? "启用" : "停用"}</span>
                </td>
                <td>
                  <span className="tip tip-end" data-tip="修改这条映射">
                    <button className="btn small" onClick={() => setEditing(m)}>
                      编辑
                    </button>
                  </span>{" "}
                  <span className="tip tip-end" data-tip="删除后外部无法再调用该 model 名">
                    <button className="btn small danger" onClick={() => remove(m.id)}>
                      删除
                    </button>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pager page={pager.page} pageCount={pager.pageCount} total={pager.total} label="模型映射" onPage={pager.setPage} />
    </div>
  );
}

// ---- API Keys ----

function ApiKeysTab() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [users, setUsers] = useState<UserView[]>([]);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [userId, setUserId] = useState<string>("");
  const [created, setCreated] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pager = usePager(keys, TABLE_PAGE_SIZE);

  const load = (): void => {
    api<ApiKey[]>("/admin/api-keys").then(setKeys).catch((e) => setError(e.message));
    api<UserView[]>("/admin/users")
      .then((list) => setUsers(list.filter((u) => u.role === "user" && u.enabled)))
      .catch(() => undefined);
  };
  useEffect(load, []);

  const create = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    setCopied(false);
    try {
      const k = await api<ApiKey>("/admin/api-keys", {
        method: "POST",
        body: { name, ...(userId ? { userId: Number(userId) } : {}) },
      });
      setCreated(k.key);
      setName("");
      setUserId("");
      setCreating(false);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const copyCreated = async (): Promise<void> => {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* 剪贴板不可用（如非安全上下文）时保持按钮原样 */
    }
  };

  return (
    <div className="card">
      {error && !creating && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {created && (
        <div className="ok" role="status">
          新 key（仅显示一次，请立即复制）：<code className="mono">{created}</code>{" "}
          <button className="btn small" onClick={copyCreated}>
            {copied ? "已复制 ✓" : "复制"}
          </button>
        </div>
      )}
      <span className="tip" data-tip="生成调用 /v1 接口所用的 API Key">
        <button className="btn primary" onClick={() => setCreating(true)}>
          生成新 Key
        </button>
      </span>
      {creating && (
        <FormDialog title="生成新 Key" onClose={() => setCreating(false)}>
          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}
          <form onSubmit={create}>
            <label htmlFor="ak-name">Key 名称</label>
            <input id="ak-name" placeholder="如 my-app-prod" value={name} onChange={(e) => setName(e.target.value)} required />
            <label htmlFor="ak-user" className="tip" data-tip="关联后该 key 的调用量计入用户额度；不关联则不限量">
              关联用户（可选）
            </label>
            <select id="ak-user" value={userId} onChange={(e) => setUserId(e.target.value)}>
              <option value="">不关联（不计额度）</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.email}
                </option>
              ))}
            </select>
            <div className="row">
              <button className="btn primary" type="submit">
                生成
              </button>
              <button className="btn ghost" type="button" onClick={() => setCreating(false)}>
                取消
              </button>
            </div>
          </form>
        </FormDialog>
      )}
      {keys.length === 0 && <p className="muted">还没有 API Key。未配置任何 key 时 /v1 接口不启用鉴权。</p>}
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>名称</th>
              <th>关联用户</th>
              <th>Key</th>
              <th>状态</th>
              <th>创建时间</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {pager.slice.map((k) => (
              <tr key={k.id}>
                <td>{k.name}</td>
                <td>{k.userEmail ?? <span className="muted">-</span>}</td>
                <td className="mono">{maskKey(k.key)}</td>
                <td>
                  <span className={`pill ${k.enabled ? "" : "off"}`}>{k.enabled ? "启用" : "停用"}</span>
                </td>
                <td className="muted">{fmtTime(k.createdAt)}</td>
                <td>
                  <span className="tip tip-end" data-tip={k.enabled ? "停用后该 key 立即失效，可再启用" : "重新启用该 key"}>
                    <button
                      className="btn small"
                      onClick={async () => {
                        await api(`/admin/api-keys/${k.id}`, { method: "PATCH", body: { enabled: !k.enabled } });
                        load();
                      }}
                    >
                      {k.enabled ? "停用" : "启用"}
                    </button>
                  </span>{" "}
                  <span className="tip tip-end" data-tip="使用它的客户端将立即失去访问权限">
                    <button
                      className="btn small danger"
                      onClick={async () => {
                        if (!confirm("确认删除该 key？使用它的客户端将立即失去访问权限。")) return;
                        await api(`/admin/api-keys/${k.id}`, { method: "DELETE" });
                        load();
                      }}
                    >
                      删除
                    </button>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pager page={pager.page} pageCount={pager.pageCount} total={pager.total} label="API Keys" onPage={pager.setPage} />
    </div>
  );
}

// ---- 日志 ----

export interface AppliedLogFilter {
  model?: string;
  q?: string;
  status?: string;
  channelId?: string;
}

// 由当前筛选条件拼出 /admin/logs 的 query（不含 limit）
export function buildLogQuery(filter: AppliedLogFilter): string {
  const params = new URLSearchParams();
  if (filter.model) params.set("model", filter.model);
  if (filter.q) params.set("q", filter.q);
  if (filter.status) params.set("status", filter.status);
  if (filter.channelId) params.set("channelId", filter.channelId);
  const s = params.toString();
  return s ? `&${s}` : "";
}

function LogsTab() {
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [modelInput, setModelInput] = useState("");
  const [qInput, setQInput] = useState("");
  const [statusInput, setStatusInput] = useState("");
  const [channelInput, setChannelInput] = useState("");
  const [applied, setApplied] = useState<AppliedLogFilter>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Channel[]>("/admin/channels")
      .then((rows) => setChannels(rows))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    let alive = true;
    const load = (): void => {
      // 后台标签页不轮询，回到前台后由下一次定时器接管
      if (document.visibilityState === "hidden") return;
      api<LogRow[]>(`/admin/logs?limit=50${buildLogQuery(applied)}`)
        .then((rows) => {
          if (!alive) return;
          setLogs(rows);
          setError(null);
        })
        .catch((e) => {
          if (alive) setError(e instanceof Error ? e.message : String(e));
        });
    };
    load();
    const t = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [applied]);

  const applyFilters = (): void => {
    setApplied({ model: modelInput.trim(), q: qInput.trim(), status: statusInput, channelId: channelInput });
  };

  const resetFilters = (): void => {
    setModelInput("");
    setQInput("");
    setStatusInput("");
    setChannelInput("");
    setApplied({});
  };

  const submitOnEnter = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Enter") applyFilters();
  };

  const exportCsv = async (): Promise<void> => {
    setError(null);
    try {
      const res = await fetch(`/admin/logs/export?limit=500${buildLogQuery(applied)}`, {
        headers: { authorization: `Bearer ${getToken()}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `tiny-images-logs-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const hasFilters = !!(applied.model || applied.q || applied.status || applied.channelId);

  return (
    <div className="card">
      <p className="muted">最近 500 条请求内可筛选，每 5 秒自动刷新。</p>
      <div className="row log-filters">
        <input
          aria-label="按模型筛选"
          placeholder="按 model 筛选…"
          value={modelInput}
          onChange={(e) => setModelInput(e.target.value)}
          onKeyDown={submitOnEnter}
        />
        <select aria-label="按状态筛选" value={statusInput} onChange={(e) => setStatusInput(e.target.value)}>
          <option value="">全部状态</option>
          <option value="ok">ok</option>
          <option value="error">error</option>
        </select>
        <select aria-label="按渠道筛选" value={channelInput} onChange={(e) => setChannelInput(e.target.value)}>
          <option value="">全部渠道</option>
          {channels.map((c) => (
            <option key={c.id} value={String(c.id)}>
              {c.name}
            </option>
          ))}
        </select>
        <input
          aria-label="搜索错误内容"
          placeholder="搜索 model / 错误内容…"
          value={qInput}
          onChange={(e) => setQInput(e.target.value)}
          onKeyDown={submitOnEnter}
        />
        <button className="btn small" onClick={applyFilters}>
          筛选
        </button>
        <button className="btn small" onClick={resetFilters}>
          重置
        </button>
        <button className="btn small" onClick={() => void exportCsv()}>
          导出 CSV
        </button>
        {hasFilters && <span className="muted">筛选已启用</span>}
      </div>
      {error && (
        <div className="error" role="status">
          日志加载失败：{error}（将自动重试）
        </div>
      )}
      {logs.length === 0 && !error && <p className="muted">{hasFilters ? "没有符合筛选条件的记录。" : "暂无请求记录。发起一次生成后这里会出现调用日志。"}</p>}
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>时间</th>
              <th>model</th>
              <th>状态</th>
              <th>HTTP</th>
              <th>耗时</th>
              <th>错误</th>
            </tr>
          </thead>
          <tbody>
            {logs.map((l) => (
              <tr key={l.id}>
                <td className="muted">{fmtTime(l.ts)}</td>
                <td className="mono">{l.model}</td>
                <td>
                  <span className={`pill ${l.status === "ok" ? "" : "error"}`}>{l.status}</span>
                </td>
                <td>{l.httpStatus ?? "-"}</td>
                <td>{l.latencyMs !== null ? `${l.latencyMs} ms` : "-"}</td>
                <td className="error-cell">{l.errorMessage ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
