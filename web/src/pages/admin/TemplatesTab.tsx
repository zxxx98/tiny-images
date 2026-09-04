import { FormEvent, useEffect, useState } from "react";
import {
  api,
  createEditJob,
  createJob,
  deleteTemplate,
  fetchAdminTemplates,
  fetchImageAsFile,
  fetchJob,
  saveTemplate,
  type AdminTemplate,
  type TemplateType,
} from "../../api";
import FormDialog from "../FormDialog";
import { TEMPLATE_TYPE_LABEL } from "../TemplateLibrary";

interface ModelsResponse {
  data: { id: string; supportsImageToImage?: boolean }[];
}

// 编辑器草稿：saved 为服务端已保存的示例图（不可删除，只能替换）；
// pending 为本次上传或 AI 生成的新示例图，保存时随表单一起提交
interface TemplateDraft {
  id?: number;
  type: TemplateType;
  name: string;
  prompt: string;
  enabled: boolean;
  sortOrder: number;
  saved: { image: string | null; before: string | null; after: string | null };
  pending: { image: File | null; before: File | null; after: File | null };
}

type ExampleSlot = "image" | "before" | "after";

const TABLE_PAGE_SIZE = 20;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 启动一个生成 job 并轮询到结束，返回第一张结果图的 URL
async function runImageJob(start: () => Promise<{ jobId: string }>): Promise<string> {
  const { jobId } = await start();
  const deadline = Date.now() + 5 * 60_000;
  for (;;) {
    const job = await fetchJob(jobId);
    if (job.status === "error") throw new Error(job.error ?? "生成失败");
    if (job.status === "ok") {
      const url = job.images[0]?.url;
      if (!url) throw new Error("生成结果为空");
      return url;
    }
    if (Date.now() > deadline) throw new Error("生成超时，请稍后重试");
    await sleep(1500);
  }
}

const newDraft = (type: TemplateType = "text2image"): TemplateDraft => ({
  type,
  name: "",
  prompt: "",
  enabled: true,
  sortOrder: 0,
  saved: { image: null, before: null, after: null },
  pending: { image: null, before: null, after: null },
});

const draftFromRow = (row: AdminTemplate): TemplateDraft => ({
  id: row.id,
  type: row.type,
  name: row.name,
  prompt: row.prompt,
  enabled: row.enabled,
  sortOrder: row.sortOrder,
  saved: {
    image: row.exampleImage ? `/files/templates/${row.exampleImage}` : null,
    before: row.exampleBefore ? `/files/templates/${row.exampleBefore}` : null,
    after: row.exampleAfter ? `/files/templates/${row.exampleAfter}` : null,
  },
  pending: { image: null, before: null, after: null },
});

function ExampleThumb({ src, alt, label }: { src: string | null; alt: string; label: string }) {
  return (
    <span className="template-pair-slot">
      {src ? <img src={src} alt={alt} /> : <span className="template-example-empty muted">暂无</span>}
      <span className="template-example-label muted">{label}</span>
    </span>
  );
}

export default function TemplatesTab() {
  const [templates, setTemplates] = useState<AdminTemplate[]>([]);
  const [typeFilter, setTypeFilter] = useState<"all" | TemplateType>("all");
  const [editing, setEditing] = useState<TemplateDraft | null>(null);
  const [models, setModels] = useState<{ id: string; supportsImageToImage: boolean }[]>([]);
  const [genModel, setGenModel] = useState("");
  const [genBusy, setGenBusy] = useState<null | "image" | "after">(null);
  const [genStatus, setGenStatus] = useState<string | null>(null);
  const [genError, setGenError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [pendingUrls, setPendingUrls] = useState<Record<ExampleSlot, string | null>>({ image: null, before: null, after: null });

  const load = (): void => {
    fetchAdminTemplates()
      .then((rows) => setTemplates(rows))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };
  useEffect(load, []);

  useEffect(() => {
    api<ModelsResponse>("/v1/models")
      .then((r) => setModels(r.data.map((m) => ({ id: m.id, supportsImageToImage: m.supportsImageToImage === true }))))
      .catch(() => setModels([]));
  }, []);

  // pending 文件 → 预览 URL；切换或关闭时释放
  useEffect(() => {
    if (!editing) return;
    const keys: ExampleSlot[] = ["image", "before", "after"];
    const urls: Record<ExampleSlot, string | null> = { image: null, before: null, after: null };
    for (const key of keys) {
      const file = editing.pending[key];
      if (file) urls[key] = URL.createObjectURL(file);
    }
    setPendingUrls(urls);
    return () => {
      for (const key of keys) if (urls[key]) URL.revokeObjectURL(urls[key]!);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing?.pending.image, editing?.pending.before, editing?.pending.after]);

  // 不同模板类型对应不同的生成方式：文生图用任意模型，图生图必须用支持图生图的模型
  const genPool = editing
    ? editing.type === "image2image"
      ? models.filter((m) => m.supportsImageToImage)
      : models
    : [];
  useEffect(() => {
    if (!editing) return;
    setGenModel((cur) => (cur && genPool.some((m) => m.id === cur) ? cur : genPool[0]?.id ?? ""));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing?.id, editing?.type, models.length]);

  const previewOf = (slot: ExampleSlot): string | null => (editing ? pendingUrls[slot] ?? editing.saved[slot] : null);

  const setPendingFile = (slot: ExampleSlot, file: File | null): void => {
    setEditing((cur) => (cur ? { ...cur, pending: { ...cur.pending, [slot]: file } } : cur));
  };

  // 文生图示例：按模板 Prompt 直接生成一张效果图
  const generateImageExample = async (): Promise<void> => {
    if (!editing || genBusy) return;
    if (!genModel) {
      setGenError("没有可用模型，请先在渠道与模型映射中配置");
      return;
    }
    if (!editing.prompt.trim()) {
      setGenError("请先填写模板内容（Prompt）再生成示例图");
      return;
    }
    setGenError(null);
    setGenBusy("image");
    setGenStatus("提交生成任务…");
    try {
      const url = await runImageJob(() => {
        setGenStatus("生成中，约需数十秒…");
        return createJob({ model: genModel, prompt: editing.prompt, n: 1, response_format: "url" });
      });
      const file = await fetchImageAsFile(url, "template-example");
      setPendingFile("image", file);
    } catch (err) {
      setGenError(`生成示例图失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setGenBusy(null);
      setGenStatus(null);
    }
  };

  // 图生图「生成后」示例：以「生成前」示例图 + 模板 Prompt 走编辑（图生图）任务
  const generateAfterExample = async (): Promise<void> => {
    if (!editing || genBusy) return;
    if (!genModel) {
      setGenError("没有支持图生图的模型，请先在渠道与模型映射中配置");
      return;
    }
    if (!editing.prompt.trim()) {
      setGenError("请先填写模板内容（Prompt）再生成效果图");
      return;
    }
    let beforeFile = editing.pending.before;
    try {
      if (!beforeFile) {
        if (!editing.saved.before) {
          setGenError("请先上传「生成前」示例图，或直接上传「生成后」效果图");
          return;
        }
        beforeFile = await fetchImageAsFile(editing.saved.before, "template-before");
      }
      setGenError(null);
      setGenBusy("after");
      setGenStatus("提交生成任务…");
      const form = new FormData();
      form.append("model", genModel);
      form.append("prompt", editing.prompt);
      form.append("n", "1");
      form.append("response_format", "url");
      form.append("image", beforeFile, beforeFile.name);
      const url = await runImageJob(() => {
        setGenStatus("生成中，约需数十秒…");
        return createEditJob(form);
      });
      const file = await fetchImageAsFile(url, "template-after");
      setPendingFile("after", file);
    } catch (err) {
      setGenError(`生成效果图失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setGenBusy(null);
      setGenStatus(null);
    }
  };

  const save = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!editing) return;
    setError(null);
    const form = new FormData();
    form.append("type", editing.type);
    form.append("name", editing.name);
    form.append("prompt", editing.prompt);
    form.append("enabled", editing.enabled ? "1" : "0");
    form.append("sortOrder", String(editing.sortOrder));
    if (editing.pending.image) form.append("image", editing.pending.image, editing.pending.image.name);
    if (editing.pending.before) form.append("before", editing.pending.before, editing.pending.before.name);
    if (editing.pending.after) form.append("after", editing.pending.after, editing.pending.after.name);
    try {
      await saveTemplate(editing.id ?? null, form);
      setEditing(null);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const toggleEnabled = async (row: AdminTemplate): Promise<void> => {
    try {
      await api(`/admin/templates/${row.id}`, { method: "PUT", body: { enabled: !row.enabled } });
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const remove = async (row: AdminTemplate): Promise<void> => {
    if (!confirm(`删除模板「${row.name}」？其示例图片将一并删除。`)) return;
    try {
      await deleteTemplate(row.id);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const filtered = templates.filter((t) => typeFilter === "all" || t.type === typeFilter);
  const pageCount = Math.max(1, Math.ceil(filtered.length / TABLE_PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageRows = filtered.slice(safePage * TABLE_PAGE_SIZE, (safePage + 1) * TABLE_PAGE_SIZE);
  const counts = {
    text2image: templates.filter((t) => t.type === "text2image").length,
    image2image: templates.filter((t) => t.type === "image2image").length,
  };

  return (
    <div className="card">
      {error && !editing && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      <p className="muted">
        模板库供前台用户在 Playground 选用（文生图 / 图生图）。官方模板仅管理员可改删，前台用户不可删除；
        用户也可在前台录入自己的模板（仅本人可见、本人可删），其示例图保存后同样不可删除。
        模板未生成示例图时可直接保存纯文字模板。
      </p>
      <div className="row">
        <button className="btn primary" onClick={() => setEditing(newDraft())}>
          新建模板
        </button>
        {(["all", "text2image", "image2image"] as const).map((value) => (
          <button
            key={value}
            className={`btn ${typeFilter === value ? "primary" : "ghost"}`}
            aria-pressed={typeFilter === value}
            onClick={() => {
              setTypeFilter(value);
              setPage(0);
            }}
          >
            {value === "all" ? `全部（${templates.length}）` : `${TEMPLATE_TYPE_LABEL[value]}（${counts[value]}）`}
          </button>
        ))}
      </div>
      {templates.length === 0 && <p className="muted">还没有模板。点击「新建模板」添加官方模板。</p>}
      {filtered.length === 0 && templates.length > 0 && <p className="muted">该分类下暂无模板。</p>}
      {pageRows.length > 0 && (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>示例图</th>
                <th>名称</th>
                <th>类型</th>
                <th>来源</th>
                <th>模板内容</th>
                <th>排序</th>
                <th>状态</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {pageRows.map((t) => (
                <tr key={t.id}>
                  <td>
                    {t.type === "text2image" ? (
                      <span className="template-pair-mini">
                        {t.exampleImage ? (
                          <img className="template-thumb" src={`/files/templates/${t.exampleImage}`} alt={`${t.name} 生成示例`} />
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </span>
                    ) : (
                      <span className="template-pair-mini">
                        {t.exampleBefore ? (
                          <img className="template-thumb" src={`/files/templates/${t.exampleBefore}`} alt={`${t.name} 生成前`} />
                        ) : (
                          <span className="muted">—</span>
                        )}
                        <span aria-hidden="true">→</span>
                        {t.exampleAfter ? (
                          <img className="template-thumb" src={`/files/templates/${t.exampleAfter}`} alt={`${t.name} 生成后`} />
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </span>
                    )}
                  </td>
                  <td>{t.name}</td>
                  <td>
                    <span className="pill">{TEMPLATE_TYPE_LABEL[t.type]}</span>
                  </td>
                  <td>{t.ownerUserId === null ? <span className="pill">官方</span> : <span className="muted">{t.ownerEmail ?? `用户#${t.ownerUserId}`}</span>}</td>
                  <td>
                    <span className="template-admin-prompt" title={t.prompt}>
                      {t.prompt}
                    </span>
                  </td>
                  <td>{t.sortOrder}</td>
                  <td>
                    <span className={`pill ${t.enabled ? "" : "off"}`}>{t.enabled ? "启用" : "停用"}</span>
                  </td>
                  <td>
                    <button className="btn small" onClick={() => setEditing(draftFromRow(t))}>
                      编辑
                    </button>{" "}
                    <button className="btn small" onClick={() => void toggleEnabled(t)}>
                      {t.enabled ? "停用" : "启用"}
                    </button>{" "}
                    <button className="btn small danger" onClick={() => void remove(t)}>
                      删除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {pageCount > 1 && (
        <div className="pager">
          <button className="btn small" disabled={safePage === 0} onClick={() => setPage(safePage - 1)}>
            上一页
          </button>
          <span className="muted">
            {safePage + 1} / {pageCount}
          </span>
          <button className="btn small" disabled={safePage >= pageCount - 1} onClick={() => setPage(safePage + 1)}>
            下一页
          </button>
        </div>
      )}

      {editing && (
        <FormDialog title={editing.id ? "编辑模板" : "新建模板"} onClose={() => setEditing(null)}>
          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}
          <form onSubmit={save}>
            <label htmlFor="tpl-type">模板类型</label>
            <select
              id="tpl-type"
              value={editing.type}
              disabled={!!editing.id}
              onChange={(e) => setEditing({ ...newDraft(e.target.value as TemplateType), name: editing.name, prompt: editing.prompt })}
            >
              <option value="text2image">文生图</option>
              <option value="image2image">图生图</option>
            </select>
            <label htmlFor="tpl-name">模板名称</label>
            <input id="tpl-name" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} maxLength={60} required />
            <label htmlFor="tpl-prompt">模板内容（选用时回填到 Prompt）</label>
            <textarea id="tpl-prompt" rows={4} value={editing.prompt} onChange={(e) => setEditing({ ...editing, prompt: e.target.value })} required />

            {editing.type === "text2image" ? (
              <>
                <label className="tip" data-tip="向用户展示该模板能生成什么样的图">
                  生成示例图（可选，保存后不可删除）
                </label>
                <div className="template-example-edit">
                  <ExampleThumb src={previewOf("image")} alt="生成示例预览" label="生成示例" />
                  <div className="template-example-edit-actions">
                    <input
                      aria-label="上传生成示例图"
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      onChange={(e) => setPendingFile("image", e.target.files?.[0] ?? null)}
                    />
                    <div className="row">
                      <select aria-label="示例生成模型" value={genModel} onChange={(e) => setGenModel(e.target.value)}>
                        {genPool.length === 0 && <option value="">无可用模型</option>}
                        {genPool.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.id}
                          </option>
                        ))}
                      </select>
                      <button type="button" className="btn small" disabled={genBusy !== null || !genModel} onClick={() => void generateImageExample()}>
                        {genBusy === "image" ? "生成中…" : "AI 生成示例图"}
                      </button>
                    </div>
                  </div>
                </div>
              </>
            ) : (
              <>
                <label className="tip" data-tip="图生图模板需要一张生成前的原图和一张生成后的效果图做示例">
                  生成前 / 生成后示例图（可选，保存后不可删除）
                </label>
                <div className="template-example-edit">
                  <div className="template-example-edit-slot">
                    <ExampleThumb src={previewOf("before")} alt="生成前示例预览" label="生成前" />
                    <input
                      aria-label="上传生成前示例图"
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      onChange={(e) => setPendingFile("before", e.target.files?.[0] ?? null)}
                    />
                  </div>
                  <div className="template-example-edit-slot">
                    <ExampleThumb src={previewOf("after")} alt="生成后示例预览" label="生成后" />
                    <input
                      aria-label="上传生成后效果图"
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      onChange={(e) => setPendingFile("after", e.target.files?.[0] ?? null)}
                    />
                    <div className="row">
                      <select aria-label="效果图生成模型" value={genModel} onChange={(e) => setGenModel(e.target.value)}>
                        {genPool.length === 0 && <option value="">无支持图生图的模型</option>}
                        {genPool.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.id}
                          </option>
                        ))}
                      </select>
                      <button type="button" className="btn small" disabled={genBusy !== null || !genModel} onClick={() => void generateAfterExample()}>
                        {genBusy === "after" ? "生成中…" : "AI 生成效果图"}
                      </button>
                    </div>
                  </div>
                </div>
              </>
            )}
            {genBusy && genStatus && <p className="muted">{genStatus}</p>}
            {genError && (
              <div className="error" role="alert">
                {genError}
              </div>
            )}
            <div className="row">
              <div>
                <label htmlFor="tpl-sort" className="tip" data-tip="数字越小越靠前">
                  排序
                </label>
                <input
                  id="tpl-sort"
                  type="number"
                  min={0}
                  step={1}
                  value={editing.sortOrder}
                  onChange={(e) => setEditing({ ...editing, sortOrder: Math.max(0, Math.round(Number(e.target.value) || 0)) })}
                />
              </div>
              <label className="check">
                <input type="checkbox" checked={editing.enabled} onChange={(e) => setEditing({ ...editing, enabled: e.target.checked })} /> 启用（前台可见）
              </label>
            </div>
            <div className="row">
              <button className="btn primary" type="submit" disabled={genBusy !== null}>
                保存
              </button>
              <button className="btn ghost" type="button" onClick={() => setEditing(null)}>
                取消
              </button>
            </div>
          </form>
        </FormDialog>
      )}
    </div>
  );
}
