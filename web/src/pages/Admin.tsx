import { FormEvent, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, type ApiKey, type Channel, type ChannelKey, type LogRow, type ModelMapping, type UserView } from "../api";
import GroupsTab from "./admin/GroupsTab";
import UsersTab from "./admin/UsersTab";
import SettingsTab from "./admin/SettingsTab";

type Tab = "channels" | "models" | "keys" | "logs" | "groups" | "users" | "settings";

const TABS: [Tab, string][] = [
  ["channels", "渠道"],
  ["groups", "分组"],
  ["models", "模型映射"],
  ["keys", "API Keys"],
  ["users", "用户"],
  ["logs", "请求日志"],
  ["settings", "设置"],
];

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
        {tab === "logs" && <LogsTab />}
        {tab === "settings" && <SettingsTab />}
      </div>
    </div>
  );
}

// ---- 渠道 ----

export function newChannelDraft(): Partial<Channel> {
  return { type: "openai-compat", editMode: "auto", timeoutMs: 120000, enabled: true };
}

export function changeChannelType(draft: Partial<Channel>, type: Channel["type"]): Partial<Channel> {
  const addHordeDefault = type === "ai-horde" && draft.id === undefined && !draft.baseUrl;
  return { ...draft, type, ...(addHordeDefault ? { baseUrl: "https://aihorde.net/api/v2" } : {}) };
}

function ChannelsTab() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [editing, setEditing] = useState<Partial<Channel> | null>(null);
  const [headersText, setHeadersText] = useState("{}");
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = (): void => {
    api<Channel[]>("/admin/channels")
      .then(setChannels)
      .catch((e) => setError(e.message));
  };
  useEffect(load, []);

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

  return (
    <div className="card">
      {msg && (
        <div className="ok" role="status">
          {msg}
        </div>
      )}
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      <button className="btn primary" onClick={() => openEdit(null)}>
        新建渠道
      </button>
      {editing && (
        <form className="inline-form" onSubmit={save}>
          <h3>{editing.id ? "编辑渠道" : "新建渠道"}</h3>
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
          <label htmlFor="ch-timeout">超时（毫秒）</label>
          <input
            id="ch-timeout"
            type="number"
            min={1000}
            step={1000}
            value={editing.timeoutMs ?? 120000}
            onChange={(e) => setEditing({ ...editing, timeoutMs: Number(e.target.value) })}
          />
          {editing.type === "ai-horde" ? (
            <p className="muted">
              AI Horde 是排队式异步服务，生成速度取决于在线 worker；图片编辑能力也取决于所选模型和 worker。可填写注册 key，匿名调用请使用 0000000000。
            </p>
          ) : (
            <>
              <label htmlFor="ch-edit-mode">图片编辑请求方式（edits）</label>
              <select id="ch-edit-mode" value={editing.editMode ?? "auto"} onChange={(e) => setEditing({ ...editing, editMode: e.target.value as Channel["editMode"] })}>
                <option value="auto">auto（自动回退）</option>
                <option value="multipart">multipart（标准表单上传）</option>
                <option value="json-base64">json-base64（JSON + base64 图片）</option>
              </select>
            </>
          )}
          <label htmlFor="ch-headers">额外 Headers（JSON，可选）</label>
          <textarea
            id="ch-headers"
            className="mono"
            rows={2}
            value={headersText}
            onChange={(e) => setHeadersText(e.target.value)}
            placeholder='{"x-foo":"bar"}'
            spellCheck={false}
          />
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
      )}
      {channels.length === 0 && <p className="muted">还没有渠道。点击「新建渠道」添加上游生图服务，然后为它录入 apiKey。</p>}
      {channels.map((c) => (
        <div key={c.id} className="entity">
          <div className="entity-head">
            <strong>{c.name}</strong>
            <span className="pill">{c.type === "ai-horde" ? "AI Horde" : "OpenAI Compatible"}</span>
            <span className={`pill ${c.enabled ? "" : "off"}`}>{c.enabled ? "启用" : "停用"}</span>
            <span className="muted mono">{c.baseUrl}</span>
            <span className="spacer" />
            <button className="btn small" onClick={() => testChannel(c.id)}>
              测试连通性
            </button>
            <button className="btn small" onClick={() => openEdit(c)}>
              编辑
            </button>
            <button className="btn small" onClick={() => toggle(c)}>
              {c.enabled ? "停用" : "启用"}
            </button>
            <button className="btn small danger" onClick={() => remove(c.id)}>
              删除
            </button>
          </div>
          <div className="keys">
            {(c.keys ?? []).map((k) => (
              <span key={k.id} className={`pill mono ${k.enabled ? "" : "off"}`}>
                {maskKey(k.apiKey)}
                <button className="link" onClick={() => toggleKey(k)}>
                  {k.enabled ? "停用" : "启用"}
                </button>
                <button className="link danger" onClick={() => removeKey(k.id)}>
                  删除
                </button>
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
      <button className="btn small" onClick={add}>
        添加
      </button>
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
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      <button className="btn primary" onClick={() => setEditing({ enabled: true, supportsImageToImage: false })} disabled={channels.length === 0}>
        新建映射
      </button>
      {channels.length === 0 && <p className="muted">还没有渠道。请先在「渠道」页添加并启用一个渠道，再建立模型映射。</p>}
      <p className="muted">同一个对外 model 名可建多条映射（如主备渠道），按优先级从小到大依次尝试；某渠道连续失败会自动熔断冷却。</p>
      {editing && (
        <form className="inline-form" onSubmit={save}>
          <h3>{editing.id ? "编辑映射" : "新建映射"}</h3>
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

          <label htmlFor="m-priority">优先级（数字越小越先用，用于多渠道故障转移）</label>
          <input
            id="m-priority"
            type="number"
            step={1}
            value={editing.priority ?? 0}
            onChange={(e) => setEditing({ ...editing, priority: Number(e.target.value) })}
          />
          <label className="check">
            <input
              type="checkbox"
              checked={editing.supportsImageToImage ?? false}
              onChange={(e) => setEditing({ ...editing, supportsImageToImage: e.target.checked })}
            />{" "}
            支持图生图
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
              <th>状态</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {models.map((m) => (
              <tr key={m.id}>
                <td className="mono">{m.publicName}</td>
                <td>{m.priority}</td>
                <td>{m.channelName ?? m.channelId}</td>
                <td className="mono">{m.upstreamName}</td>
                <td>
                  <span className={`pill ${m.supportsImageToImage ? "" : "off"}`}>{m.supportsImageToImage ? "支持" : "不支持"}</span>
                </td>
                <td>
                  <span className={`pill ${m.enabled ? "" : "off"}`}>{m.enabled ? "启用" : "停用"}</span>
                </td>
                <td>
                  <button className="btn small" onClick={() => setEditing(m)}>
                    编辑
                  </button>{" "}
                  <button className="btn small danger" onClick={() => remove(m.id)}>
                    删除
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---- API Keys ----

function ApiKeysTab() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [users, setUsers] = useState<UserView[]>([]);
  const [name, setName] = useState("");
  const [userId, setUserId] = useState<string>("");
  const [created, setCreated] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      {error && (
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
      <form className="row" onSubmit={create}>
        <label htmlFor="ak-name">Key 名称</label>
        <input id="ak-name" placeholder="如 my-app-prod" value={name} onChange={(e) => setName(e.target.value)} required />
        <label htmlFor="ak-user">关联用户（可选）</label>
        <select id="ak-user" value={userId} onChange={(e) => setUserId(e.target.value)}>
          <option value="">不关联（不计额度）</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.email}
            </option>
          ))}
        </select>
        <button className="btn primary" type="submit">
          生成新 Key
        </button>
      </form>
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
            {keys.map((k) => (
              <tr key={k.id}>
                <td>{k.name}</td>
                <td>{k.userEmail ?? <span className="muted">-</span>}</td>
                <td className="mono">{maskKey(k.key)}</td>
                <td>
                  <span className={`pill ${k.enabled ? "" : "off"}`}>{k.enabled ? "启用" : "停用"}</span>
                </td>
                <td className="muted">{fmtTime(k.createdAt)}</td>
                <td>
                  <button
                    className="btn small"
                    onClick={async () => {
                      await api(`/admin/api-keys/${k.id}`, { method: "PATCH", body: { enabled: !k.enabled } });
                      load();
                    }}
                  >
                    {k.enabled ? "停用" : "启用"}
                  </button>{" "}
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
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---- 日志 ----

function LogsTab() {
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = (): void => {
      // 后台标签页不轮询，回到前台后由下一次定时器接管
      if (document.visibilityState === "hidden") return;
      api<LogRow[]>("/admin/logs?limit=50")
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
  }, []);

  return (
    <div className="card">
      <p className="muted">最近 50 条请求，每 5 秒自动刷新。</p>
      {error && (
        <div className="error" role="status">
          日志加载失败：{error}（将自动重试）
        </div>
      )}
      {logs.length === 0 && !error && <p className="muted">暂无请求记录。发起一次生成后这里会出现调用日志。</p>}
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
