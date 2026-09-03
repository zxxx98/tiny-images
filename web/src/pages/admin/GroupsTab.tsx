import { FormEvent, useEffect, useState } from "react";
import { api, type Channel, type ChannelGroup } from "../../api";
import FormDialog from "../FormDialog";

export default function GroupsTab() {
  const [groups, setGroups] = useState<ChannelGroup[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [editing, setEditing] = useState<Partial<ChannelGroup> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = (): void => {
    api<ChannelGroup[]>("/admin/groups").then(setGroups).catch((e) => setError(e.message));
    api<Channel[]>("/admin/channels").then(setChannels).catch(() => undefined);
  };
  useEffect(load, []);

  const save = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!editing) return;
    setError(null);
    try {
      if (editing.id) await api(`/admin/groups/${editing.id}`, { method: "PATCH", body: { name: editing.name } });
      else await api("/admin/groups", { method: "POST", body: { name: editing.name } });
      setEditing(null);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const saveMembers = async (group: ChannelGroup, channelIds: number[]): Promise<void> => {
    try {
      await api(`/admin/groups/${group.id}/channels`, { method: "PUT", body: { channelIds } });
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const toggleMember = (group: ChannelGroup, channelId: number): void => {
    const has = group.channelIds.includes(channelId);
    saveMembers(group, has ? group.channelIds.filter((c) => c !== channelId) : [...group.channelIds, channelId]);
  };

  const remove = async (id: number): Promise<void> => {
    if (!confirm("删除该分组？组内渠道本身不受影响，属于该分组的用户将失去这些渠道的访问权。")) return;
    await api(`/admin/groups/${id}`, { method: "DELETE" });
    load();
  };

  return (
    <div className="card">
      {error && !editing && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      <p className="muted">分组用于限制普通用户可用的渠道：一个渠道可属于多个分组；用户未配置分组时可使用全部渠道。</p>
      <span className="tip" data-tip="创建一个渠道分组，用于限制用户可用渠道">
        <button className="btn primary" onClick={() => setEditing({})}>
          新建分组
        </button>
      </span>
      {editing && (
        <FormDialog title={editing.id ? "编辑分组" : "新建分组"} onClose={() => setEditing(null)}>
          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}
          <form onSubmit={save}>
            <label htmlFor="g-name">分组名称</label>
            <input id="g-name" value={editing.name ?? ""} onChange={(e) => setEditing({ ...editing, name: e.target.value })} required />
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
      {groups.length === 0 && <p className="muted">还没有分组。</p>}
      {groups.map((g) => (
        <div key={g.id} className="entity">
          <div className="entity-head">
            <strong>{g.name}</strong>
            <span className="muted">
              {g.channelIds.length} 个渠道 / 共 {channels.length} 个
            </span>
            <span className="spacer" />
            <span className="tip tip-end" data-tip="修改分组名称">
              <button className="btn small" onClick={() => setEditing(g)}>
                改名
              </button>
            </span>
            <span className="tip tip-end" data-tip="组内渠道不受影响，但组内用户将失去这些渠道的访问权">
              <button className="btn small danger" onClick={() => remove(g.id)}>
                删除
              </button>
            </span>
          </div>
          <div className="keys">
            {channels.map((c) => (
              <span
                key={c.id}
                className={`pill tip ${g.channelIds.includes(c.id) ? "" : "off"}`}
                data-tip={g.channelIds.includes(c.id) ? `点击把「${c.name}」移出分组` : `点击把「${c.name}」加入分组`}
              >
                <button className="link" onClick={() => toggleMember(g, c.id)}>
                  {g.channelIds.includes(c.id) ? "✓ " : "+ "}
                  {c.name}
                </button>
              </span>
            ))}
            {channels.length === 0 && <span className="muted">先在「渠道」页添加渠道。</span>}
          </div>
        </div>
      ))}
    </div>
  );
}
