import { FormEvent, useCallback, useEffect, useState } from "react";
import { createMyTemplate, deleteMyTemplate, fetchImageAsFile, fetchTemplates, type OfficialTemplate, type TemplateType } from "../api";
import FormDialog from "./FormDialog";

export const TEMPLATE_TYPE_LABEL: Record<TemplateType, string> = {
  text2image: "文生图",
  image2image: "图生图",
};

const TEMPLATE_TYPES: TemplateType[] = ["text2image", "image2image"];

interface TemplateLibraryProps {
  onClose: () => void;
  onSelect: (template: OfficialTemplate) => void;
  // 打开弹窗时的 Playground Prompt，录入模板时作为默认内容
  initialPrompt?: string;
  // 当前会话已生成的图片：generated 为最近一次生成结果；source 为编辑模式上传的原图。
  // 录入模板时已生成的图会连同模板一起录入，没生成就只录文字
  capture?: { generated: string | null; source: string | null };
}

interface CreateDraft {
  type: TemplateType;
  name: string;
  prompt: string;
}

// 模板库弹窗：官方模板（管理员维护、只读）+ 自己录入的模板（仅本人可见、可删除）。
// 按文生图 / 图生图分栏，示例图为文生图的生成结果 / 图生图的生成前后对比。
export default function TemplateLibrary({ onClose, onSelect, initialPrompt = "", capture }: TemplateLibraryProps) {
  const [templates, setTemplates] = useState<OfficialTemplate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TemplateType>("text2image");
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<CreateDraft>({ type: "text2image", name: "", prompt: initialPrompt });
  const [saving, setSaving] = useState(false);
  const [savingError, setSavingError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<number | null>(null);

  const reload = useCallback((): void => {
    fetchTemplates()
      .then((rows) => setTemplates(Array.isArray(rows) ? rows : []))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const captureFor = (type: TemplateType): { image: string | null; before: string | null; after: string | null } => ({
    image: type === "text2image" ? (capture?.generated ?? null) : null,
    before: type === "image2image" ? (capture?.source ?? null) : null,
    after: type === "image2image" ? (capture?.generated ?? null) : null,
  });

  const submitCreate = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (saving) return;
    setSavingError(null);
    setSaving(true);
    try {
      const form = new FormData();
      form.append("type", draft.type);
      form.append("name", draft.name);
      form.append("prompt", draft.prompt);
      // 图片已生成就连图一起录入；没生成就只录文字
      const parts = captureFor(draft.type);
      if (parts.image) form.append("image", await fetchImageAsFile(parts.image, "template-example"));
      if (parts.before) form.append("before", await fetchImageAsFile(parts.before, "template-before"));
      if (parts.after) form.append("after", await fetchImageAsFile(parts.after, "template-after"));
      await createMyTemplate(form);
      const withImage = !!(parts.image || parts.before || parts.after);
      setCreating(false);
      setSaved(withImage ? "模板已录入（连同示例图片，保存后图片不可删除）" : "模板已录入（未生成图片，仅录入文字）");
      reload();
    } catch (err) {
      setSavingError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const removeMine = async (template: OfficialTemplate): Promise<void> => {
    if (deleting !== null) return;
    if (!confirm(`删除模板「${template.name}」？其示例图片将一并删除。`)) return;
    setDeleting(template.id);
    setError(null);
    try {
      await deleteMyTemplate(template.id);
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleting(null);
    }
  };

  const openCreate = (type: TemplateType): void => {
    setDraft({ type, name: "", prompt: initialPrompt });
    setSavingError(null);
    setCreating(true);
  };

  const list = (templates ?? []).filter((t) => t.type === tab);
  const counts = {
    text2image: (templates ?? []).filter((t) => t.type === "text2image").length,
    image2image: (templates ?? []).filter((t) => t.type === "image2image").length,
  };
  const createParts = captureFor(draft.type);
  const hasCreateImage = !!(createParts.image || createParts.before || createParts.after);

  return (
    <FormDialog title="模板库" onClose={onClose}>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {saved && !creating && (
        <div className="ok" role="status">
          {saved}
        </div>
      )}

      {creating ? (
        <form onSubmit={submitCreate}>
          <label htmlFor="mytpl-type">模板类型</label>
          <select id="mytpl-type" value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value as TemplateType })}>
            {TEMPLATE_TYPES.map((type) => (
              <option key={type} value={type}>
                {TEMPLATE_TYPE_LABEL[type]}
              </option>
            ))}
          </select>
          <label htmlFor="mytpl-name">模板名称</label>
          <input id="mytpl-name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} maxLength={60} required />
          <label htmlFor="mytpl-prompt">模板内容（选用时回填到 Prompt）</label>
          <textarea id="mytpl-prompt" rows={4} value={draft.prompt} onChange={(e) => setDraft({ ...draft, prompt: e.target.value })} required />
          <div className="mytpl-capture muted">
            {hasCreateImage ? (
              <>
                <p>检测到已生成的图片，将连同图片一起录入（保存后图片不可删除）：</p>
                <div className={draft.type === "image2image" ? "template-pair" : ""}>
                  {createParts.image && (
                    <span className="template-pair-slot">
                      <img src={createParts.image} alt="将录入的生成示例" />
                      <span className="template-example-label muted">生成示例</span>
                    </span>
                  )}
                  {createParts.before && (
                    <span className="template-pair-slot">
                      <img src={createParts.before} alt="将录入的生成前示例" />
                      <span className="template-example-label muted">生成前</span>
                    </span>
                  )}
                  {createParts.before && createParts.after && (
                    <span className="template-pair-arrow" aria-hidden="true">
                      →
                    </span>
                  )}
                  {createParts.after && (
                    <span className="template-pair-slot">
                      <img src={createParts.after} alt="将录入的生成后示例" />
                      <span className="template-example-label muted">生成后</span>
                    </span>
                  )}
                </div>
              </>
            ) : (
              <p>当前没有已生成的图片，将只录入文字模板。</p>
            )}
          </div>
          {savingError && (
            <div className="error" role="alert">
              {savingError}
            </div>
          )}
          <div className="row">
            <button className="btn primary" type="submit" disabled={saving}>
              {saving ? "录入中…" : "录入模板"}
            </button>
            <button className="btn ghost" type="button" onClick={() => setCreating(false)}>
              取消
            </button>
          </div>
        </form>
      ) : (
        <>
          <div className="row template-library-tabs" role="tablist" aria-label="模板类型">
            {TEMPLATE_TYPES.map((type) => (
              <button
                key={type}
                type="button"
                role="tab"
                aria-selected={tab === type}
                className={`btn ${tab === type ? "primary" : "ghost"}`}
                onClick={() => setTab(type)}
              >
                {TEMPLATE_TYPE_LABEL[type]}（{templates === null ? "…" : counts[type]}）
              </button>
            ))}
            <span className="spacer" />
            <button type="button" className="btn small tip" data-tip="把当前 Prompt 存为只属于自己的模板" onClick={() => openCreate(tab)}>
              录入模板
            </button>
          </div>
          {templates === null && !error && <p className="muted">加载模板中…</p>}
          {templates !== null && list.length === 0 && (
            <p className="muted">{TEMPLATE_TYPE_LABEL[tab]}分类下暂无模板，可在后台添加或自己录入。</p>
          )}
          {list.length > 0 && (
            <div className="template-grid">
              {list.map((t) => (
                <figure key={t.id} className="template-card">
                  <figcaption className="template-card-head">
                    <strong>{t.name}</strong>
                    <span className={`pill ${t.mine ? "off" : ""}`}>{t.mine ? "我的" : "官方"}</span>
                  </figcaption>
                  {t.type === "text2image" ? (
                    <div className="template-example">
                      {t.exampleImage ? (
                        <img src={t.exampleImage} alt={`${t.name} 生成示例`} loading="lazy" />
                      ) : (
                        <div className="template-example-empty muted">暂无生成示例图</div>
                      )}
                      <span className="template-example-label muted">生成示例</span>
                    </div>
                  ) : (
                    <div className="template-example">
                      <div className="template-pair">
                        <span className="template-pair-slot">
                          {t.exampleBefore ? (
                            <img src={t.exampleBefore} alt={`${t.name} 生成前示例`} loading="lazy" />
                          ) : (
                            <span className="template-example-empty muted">暂无生成前图</span>
                          )}
                          <span className="template-example-label muted">生成前</span>
                        </span>
                        <span className="template-pair-arrow" aria-hidden="true">
                          →
                        </span>
                        <span className="template-pair-slot">
                          {t.exampleAfter ? (
                            <img src={t.exampleAfter} alt={`${t.name} 生成后示例`} loading="lazy" />
                          ) : (
                            <span className="template-example-empty muted">暂无生成后图</span>
                          )}
                          <span className="template-example-label muted">生成后</span>
                        </span>
                      </div>
                    </div>
                  )}
                  <p className="template-prompt">{t.prompt}</p>
                  <div className="template-card-actions">
                    <button type="button" className="btn small primary" onClick={() => onSelect(t)}>
                      {t.type === "text2image" ? "用此模板生成" : "用此模板编辑"}
                    </button>
                    {t.mine && (
                      <button type="button" className="btn small danger" disabled={deleting === t.id} onClick={() => void removeMine(t)}>
                        {deleting === t.id ? "删除中…" : "删除"}
                      </button>
                    )}
                  </div>
                </figure>
              ))}
            </div>
          )}
          <p className="muted template-library-foot">官方模板由管理员维护，不能删除；自己录入的模板仅自己可见，可删除，示例图保存后不可删除。</p>
        </>
      )}
    </FormDialog>
  );
}
