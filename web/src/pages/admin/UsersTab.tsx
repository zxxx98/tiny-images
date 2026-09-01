import { FormEvent, useEffect, useState } from "react";
import { api, type ChannelGroup, type UserView } from "../../api";

const fmtTime = (ts: number): string => new Date(ts).toLocaleString();

export default function UsersTab() {
  const [users, setUsers] = useState<UserView[]>([]);
  const [groups, setGroups] = useState<ChannelGroup[]>([]);
  const [editing, setEditing] = useState<Partial<UserView> & { password?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = (): void => {
    api<UserView[]>("/admin/users").then(setUsers).catch((e) => setError(e.message));
    api<ChannelGroup[]>("/admin/groups").then(setGroups).catch(() => undefined);
  };
  useEffect(load, []);

  const toggleGroup = (gid: number): void => {
    if (!editing) return;
    const ids = editing.groupIds ?? [];
    setEditing({ ...editing, groupIds: ids.includes(gid) ? ids.filter((x) => x !== gid) : [...ids, gid] });
  };

  const save = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!editing) return;
    setError(null);
    try {
      if (editing.id) {
        const body: Record<string, unknown> = { groupIds: editing.groupIds ?? [], enabled: editing.enabled, allowNsfw: editing.allowNsfw ?? false };
        if (editing.quotaTotal !== undefined && editing.quotaTotal !== null) body.quotaTotal = editing.quotaTotal;
        if (editing.password) body.password = editing.password;
        await api(`/admin/users/${editing.id}`, { method: "PATCH", body });
      } else {
        await api("/admin/users", {
          method: "POST",
          body: { email: editing.email, password: editing.password, quotaTotal: editing.quotaTotal, groupIds: editing.groupIds ?? [], allowNsfw: editing.allowNsfw ?? false },
        });
      }
      setEditing(null);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const resetPassword = async (u: UserView): Promise<void> => {
    const pwd = window.prompt(`为 ${u.email} 设置新密码（至少 6 位）`);
    if (!pwd) return;
    try {
      await api(`/admin/users/${u.id}`, { method: "PATCH", body: { password: pwd } });
      window.alert("密码已重置");
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "重置失败");
    }
  };

  const toggleEnabled = async (u: UserView): Promise<void> => {
    await api(`/admin/users/${u.id}`, { method: "PATCH", body: { enabled: !u.enabled } });
    load();
  };

  const toggleNsfw = async (u: UserView): Promise<void> => {
    await api(`/admin/users/${u.id}`, { method: "PATCH", body: { allowNsfw: !u.allowNsfw } });
    load();
  };

  const remove = async (u: UserView): Promise<void> => {
    if (!confirm(`删除用户 ${u.email}？其 API key 将解绑（保留但不再计额度）。`)) return;
    await api(`/admin/users/${u.id}`, { method: "DELETE" });
    load();
  };

  return (
    <div className="card">
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      <button className="btn primary" onClick={() => setEditing({ enabled: true, groupIds: [], allowNsfw: false })}>
        新建用户
      </button>
      {editing && (
        <form className="inline-form" onSubmit={save}>
          <h3>{editing.id ? `编辑用户 ${editing.email}` : "新建用户"}</h3>
          {!editing.id && (
            <>
              <label htmlFor="u-email">邮箱（登录账号）</label>
              <input id="u-email" type="email" value={editing.email ?? ""} onChange={(e) => setEditing({ ...editing, email: e.target.value })} required />
            </>
          )}
          <label htmlFor="u-password">{editing.id ? "重置密码（留空不修改）" : "初始密码（至少 6 位）"}</label>
          <input
            id="u-password"
            type="text"
            value={editing.password ?? ""}
            onChange={(e) => setEditing({ ...editing, password: e.target.value })}
            {...(editing.id ? {} : { required: true, minLength: 6 })}
          />
          <label htmlFor="u-quota">额度（生图张数，正整数）</label>
          <input
            id="u-quota"
            type="number"
            min={1}
            step={1}
            value={editing.quotaTotal ?? ""}
            onChange={(e) => setEditing({ ...editing, quotaTotal: e.target.value === "" ? undefined : Number(e.target.value) })}
            required
          />
          <label>渠道分组（不选 = 不限渠道）</label>
          <div className="keys">
            {groups.map((g) => (
              <span key={g.id} className={`pill ${(editing.groupIds ?? []).includes(g.id) ? "" : "off"}`}>
                <button className="link" type="button" onClick={() => toggleGroup(g.id)}>
                  {(editing.groupIds ?? []).includes(g.id) ? "✓ " : "+ "}
                  {g.name}
                </button>
              </span>
            ))}
            {groups.length === 0 && <span className="muted">尚无分组，可先在「分组」页创建。</span>}
          </div>
          <label className="check">
            <input type="checkbox" checked={editing.allowNsfw ?? false} onChange={(e) => setEditing({ ...editing, allowNsfw: e.target.checked })} /> 允许使用 NSFW 模型
          </label>
          {editing.id && (
            <label className="check">
              <input type="checkbox" checked={editing.enabled ?? true} onChange={(e) => setEditing({ ...editing, enabled: e.target.checked })} /> 启用
            </label>
          )}
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
      {users.length === 0 && <p className="muted">还没有用户。</p>}
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>邮箱</th>
              <th>角色</th>
              <th>状态</th>
              <th>额度</th>
              <th>分组</th>
              <th>NSFW 权限</th>
              <th>创建时间</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.email}</td>
                <td>{u.role}</td>
                <td>
                  <span className={`pill ${u.enabled ? "" : "off"}`}>{u.enabled ? "启用" : "禁用"}</span>
                </td>
                <td>{u.quotaRemaining === null ? "不限" : `${u.quotaRemaining}/${u.quotaTotal}（已用 ${u.quotaUsed}）`}</td>
                <td>
                  {(u.groupIds ?? []).length === 0
                    ? "不限"
                    : (u.groupIds ?? [])
                        .map((gid) => groups.find((g) => g.id === gid)?.name ?? `#${gid}`)
                        .join("、")}
                </td>
                <td><span className={`pill ${u.allowNsfw ? "" : "off"}`}>{u.allowNsfw ? "允许" : "禁止"}</span></td>
                <td className="muted">{fmtTime(u.createdAt)}</td>
                <td>
                  <button className="btn small" onClick={() => toggleNsfw(u)}>{u.allowNsfw ? "禁止 NSFW" : "允许 NSFW"}</button>{" "}
                  {u.role === "user" && (
                    <>
                      <button className="btn small" onClick={() => setEditing({ ...u })}>
                        编辑
                      </button>{" "}
                      <button className="btn small" onClick={() => resetPassword(u)}>
                        重置密码
                      </button>{" "}
                      <button className="btn small" onClick={() => toggleEnabled(u)}>
                        {u.enabled ? "禁用" : "启用"}
                      </button>{" "}
                      <button className="btn small danger" onClick={() => remove(u)}>
                        删除
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
