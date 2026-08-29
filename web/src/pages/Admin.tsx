import { FormEvent, useEffect, useState } from "react";
import { api, type ApiKey, type Channel, type ChannelKey, type LogRow, type ModelMapping } from "../api";

type Tab = "channels" | "models" | "keys" | "logs";

const fmtTime = (ts: number): string => new Date(ts).toLocaleString();

export default function Admin() {
  const [tab, setTab] = useState<Tab>("channels");
  return (
    <div className="admin">
      <div className="tabs">
        {(
          [
            ["channels", "渠道"],
            ["models", "模型映射"],
            ["keys", "API Keys"],
            ["logs", "请求日志"],
          ] as [Tab, string][]
        ).map(([id, label]) => (
          <button key={id} className={`tab ${tab === id ? "active" : ""}`} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      {tab === "channels" && <ChannelsTab />}
      {tab === "models" && <ModelsTab />}
      {tab === "keys" && <ApiKeysTab />}
      {tab === "logs" && <LogsTab />}
    </div>
  );
}

// ---- 渠道 ----

function ChannelsTab() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [editing, setEditing] = useState<Partial<Channel> | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = (): void => {
    api<Channel[]>("/admin/channels")
      .then(setChannels)
      .catch((e) => setError(e.message));
  };
  useEffect(load, []);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    setError(null);
    try {
      const body = { ...editing, extraHeaders: safeParseHeaders(editing.extraHeaders) };
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
    await api(`/admin/keys/${keyId}`, { method: "DELETE" });
    load();
  };
  const toggleKey = async (key: ChannelKey): Promise<void> => {
    await api(`/admin/keys/${key.id}`, { method: "PATCH", body: { enabled: !key.enabled } });
    load();
  };

  return (
    <div className="card">
      {msg && <div className="ok">{msg}</div>}
      {error && <div className="error">{error}</div>}
      <button className="btn primary" onClick={() => setEditing({ editMode: "auto", timeoutMs: 120000, enabled: true })}>
        新建渠道
      </button>
      {editing && (
        <form className="inline-form" onSubmit={save}>
          <h3>{editing.id ? "编辑渠道" : "新建渠道"}</h3>
          <input placeholder="名称" value={editing.name ?? ""} onChange={(e) => setEditing({ ...editing, name: e.target.value })} required />
          <input
            placeholder="Base URL (https://api.openai.com/v1)"
            value={editing.baseUrl ?? ""}
            onChange={(e) => setEditing({ ...editing, baseUrl: e.target.value })}
            required
          />
          <input
            type="number"
            placeholder="超时 ms"
            value={editing.timeoutMs ?? 120000}
            onChange={(e) => setEditing({ ...editing, timeoutMs: Number(e.target.value) })}
          />
          <select value={editing.editMode ?? "auto"} onChange={(e) => setEditing({ ...editing, editMode: e.target.value as Channel["editMode"] })}>
            <option value="auto">edits: auto（自动回退）</option>
            <option value="multipart">edits: multipart</option>
            <option value="json-base64">edits: json-base64</option>
          </select>
          <input
            placeholder='额外 Headers JSON，如 {"x-foo":"bar"}'
            value={JSON.stringify(editing.extraHeaders ?? {})}
            onChange={(e) => setEditing({ ...editing, extraHeaders: safeParseHeaders(e.target.value as unknown as Record<string, string>) })}
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
      {channels.length === 0 && <p className="muted">还没有渠道。</p>}
      {channels.map((c) => (
        <div key={c.id} className="entity">
          <div className="entity-head">
            <strong>{c.name}</strong>
            <span className={`pill ${c.enabled ? "" : "off"}`}>{c.enabled ? "启用" : "停用"}</span>
            <span className="muted mono">{c.baseUrl}</span>
            <span className="spacer" />
            <button className="btn small" onClick={() => testChannel(c.id)}>
              测试连通性
            </button>
            <button className="btn small" onClick={() => setEditing(c)}>
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
                  删
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
  return (
    <span className="key-input">
      <input
        placeholder="添加上游 apiKey…"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            onAdd(value);
            setValue("");
          }
        }}
      />
      <button
        className="btn small"
        onClick={() => {
          onAdd(value);
          setValue("");
        }}
      >
        添加
      </button>
    </span>
  );
}

function maskKey(key: string): string {
  if (key.length <= 12) return key;
  return `${key.slice(0, 8)}…${key.slice(-4)}`;
}

function safeParseHeaders(v: unknown): Record<string, string> {
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v || "{}");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, string>;
    } catch {
      /* 输入未完成时保持 {} */
    }
    return {};
  }
  return (v as Record<string, string>) ?? {};
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

  return (
    <div className="card">
      {error && <div className="error">{error}</div>}
      <button className="btn primary" onClick={() => setEditing({ enabled: true })} disabled={channels.length === 0}>
        新建映射
      </button>
      {editing && (
        <form className="inline-form" onSubmit={save}>
          <h3>{editing.id ? "编辑映射" : "新建映射"}</h3>
          <input placeholder="对外 model 名" value={editing.publicName ?? ""} onChange={(e) => setEditing({ ...editing, publicName: e.target.value })} required />
          <select value={editing.channelId ?? ""} onChange={(e) => setEditing({ ...editing, channelId: Number(e.target.value) })} required>
            <option value="" disabled>
              选择渠道…
            </option>
            {channels.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <input placeholder="上游 model 名（默认同对外名）" value={editing.upstreamName ?? ""} onChange={(e) => setEditing({ ...editing, upstreamName: e.target.value })} />
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
      <table>
        <thead>
          <tr>
            <th>对外 model</th>
            <th>渠道</th>
            <th>上游 model</th>
            <th>状态</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {models.map((m) => (
            <tr key={m.id}>
              <td className="mono">{m.publicName}</td>
              <td>{m.channelName ?? m.channelId}</td>
              <td className="mono">{m.upstreamName}</td>
              <td>
                <span className={`pill ${m.enabled ? "" : "off"}`}>{m.enabled ? "启用" : "停用"}</span>
              </td>
              <td>
                <button className="btn small" onClick={() => setEditing(m)}>
                  编辑
                </button>{" "}
                <button
                  className="btn small danger"
                  onClick={async () => {
                    await api(`/admin/models/${m.id}`, { method: "DELETE" });
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
  );
}

// ---- API Keys ----

function ApiKeysTab() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [name, setName] = useState("");
  const [created, setCreated] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = (): void => {
    api<ApiKey[]>("/admin/api-keys").then(setKeys).catch((e) => setError(e.message));
  };
  useEffect(load, []);

  const create = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    try {
      const k = await api<ApiKey>("/admin/api-keys", { method: "POST", body: { name } });
      setCreated(k.key);
      setName("");
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="card">
      {error && <div className="error">{error}</div>}
      {created && (
        <div className="ok">
          新 key（仅显示一次，请立即复制）：<code className="mono">{created}</code>{" "}
          <button className="btn small" onClick={() => navigator.clipboard.writeText(created)}>
            复制
          </button>
        </div>
      )}
      <form className="row" onSubmit={create}>
        <input placeholder="key 名称" value={name} onChange={(e) => setName(e.target.value)} required />
        <button className="btn primary" type="submit">
          生成新 Key
        </button>
      </form>
      {keys.length === 0 && <p className="muted">还没有 API Key。未配置任何 key 时 /v1 接口不启用鉴权。</p>}
      <table>
        <thead>
          <tr>
            <th>名称</th>
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
                    if (!confirm("确认删除该 key？")) return;
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
  );
}

// ---- 日志 ----

function LogsTab() {
  const [logs, setLogs] = useState<LogRow[]>([]);

  useEffect(() => {
    const load = (): void => {
      api<LogRow[]>("/admin/logs?limit=50")
        .then(setLogs)
        .catch(() => undefined);
    };
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="card">
      <p className="muted">最近 50 条请求，每 5 秒自动刷新。</p>
      {logs.length === 0 && <p className="muted">暂无请求记录。</p>}
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
                <span className={`pill ${l.status === "ok" ? "" : "off"}`}>{l.status}</span>
              </td>
              <td>{l.httpStatus ?? "-"}</td>
              <td>{l.latencyMs !== null ? `${l.latencyMs} ms` : "-"}</td>
              <td className="error-cell">{l.errorMessage ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
