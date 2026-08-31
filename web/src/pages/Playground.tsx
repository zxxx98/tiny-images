import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { api, createEditJob, createJob, fetchAnnouncement, fetchJob, notifyQuotaChanged, ApiError, type Announcement } from "../api";
import AnnouncementDialog, {
  ANNOUNCEMENT_ACK_KEY,
  persistAnnouncementAcknowledgement,
  shouldShowAnnouncement,
} from "./AnnouncementDialog";
import EditImageInput from "./EditImageInput";

interface ModelsResponse {
  data: { id: string }[];
}

const SIZE_PRESETS = ["auto", "1024x1024", "1536x1024", "1024x1536", "2048x1152", "1152x2048", "2048x2048", "1792x1024", "1024x1792", "512x512", "256x256"];

const JOB_KEY = "tiny-running-job";
const DRAFT_KEY = "tiny-playground-draft";

interface Draft {
  mode?: "generate" | "edit";
  model?: string;
  prompt?: string;
  n?: number;
  size?: string;
  responseFormat?: string;
  extra?: string;
}

type EditJobCreator = (form: FormData) => Promise<{ jobId: string }>;

export async function startEditJob(
  form: FormData,
  onStarted: (jobId: string) => void,
  create: EditJobCreator = createEditJob,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  const { jobId } = await create(form);
  if (isCurrent()) onStarted(jobId);
}

export async function fetchJobIfCurrent<T>(
  jobId: string,
  isCurrent: () => boolean,
  fetcher: (id: string) => Promise<T>,
): Promise<T | null> {
  try {
    const job = await fetcher(jobId);
    return isCurrent() ? job : null;
  } catch (err) {
    if (!isCurrent()) return null;
    throw err;
  }
}

export default function Playground() {
  const [mode, setMode] = useState<"generate" | "edit">("generate");
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState("");
  const [prompt, setPrompt] = useState("");
  const [n, setN] = useState(1);
  const [size, setSize] = useState("auto");
  const [responseFormat, setResponseFormat] = useState("");
  const [extra, setExtra] = useState("{}");
  const [editFiles, setEditFiles] = useState<File[]>([]);
  const [maskFile, setMaskFile] = useState<File | null>(null);
  const [editPreviews, setEditPreviews] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [channel, setChannel] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [images, setImages] = useState<string[]>([]);
  const [revisedPrompts, setRevisedPrompts] = useState<string[]>([]);
  const [announcement, setAnnouncement] = useState<Announcement | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const activityRef = useRef(0);
  const startedRef = useRef(0);
  const location = useLocation();

  useEffect(() => {
    api<ModelsResponse>("/v1/models")
      .then((r) => {
        setModels(r.data.map((m) => m.id));
        if (r.data.length > 0) setModel((cur) => cur || r.data[0].id);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    fetchAnnouncement()
      .then((value) => {
        if (shouldShowAnnouncement(value, localStorage.getItem(ANNOUNCEMENT_ACK_KEY))) setAnnouncement(value);
      })
      .catch(() => undefined);
  }, []);

  // 恢复草稿、导航带入的参数（历史页「重新生成」），以及未完成的生成 job
  useEffect(() => {
    try {
      const draft = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? "{}") as Draft;
      const fromNav = (location.state ?? null) as { prompt?: string; model?: string; size?: string; editImageUrl?: string } | null;
      if (draft.mode) setMode(draft.mode);
      if (fromNav?.editImageUrl) void loadIntoEdit(fromNav.editImageUrl);
      if (fromNav?.prompt) setPrompt(fromNav.prompt);
      else if (draft.prompt) setPrompt(draft.prompt);
      if (fromNav?.model) setModel(fromNav.model);
      else if (draft.model) setModel(draft.model);
      if (fromNav?.size) setSize(fromNav.size);
      if (draft.n) setN(draft.n);
      if (draft.responseFormat) setResponseFormat(draft.responseFormat);
      if (draft.extra) setExtra(draft.extra);
    } catch {
      // 草稿损坏则忽略
    }
    const jobId = localStorage.getItem(JOB_KEY);
    if (jobId) {
      startedRef.current = Date.now();
      setRunning(true);
      pollJob(jobId);
    }
    return () => {
      activityRef.current += 1;
      if (timerRef.current) clearInterval(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 表单草稿持久化，切走再回来不丢输入（文件不持久化）
  useEffect(() => {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ mode, model, prompt, n, size, responseFormat, extra }));
  }, [mode, model, prompt, n, size, responseFormat, extra]);

  // 原图缩略图预览；文件变化时释放旧的 objectURL
  useEffect(() => {
    const urls = editFiles.map((f) => URL.createObjectURL(f));
    setEditPreviews(urls);
    return () => urls.forEach((u) => URL.revokeObjectURL(u));
  }, [editFiles]);

  // 把一张已生成的图（结果区或历史页）载入编辑模式：拉取为 File 后切到编辑
  const loadIntoEdit = async (src: string): Promise<void> => {
    try {
      const res = await fetch(src);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const ext = blob.type.includes("jpeg") ? "jpg" : blob.type.includes("webp") ? "webp" : "png";
      setEditFiles([new File([blob], `edit-src.${ext}`, { type: blob.type || "image/png" })]);
      setMaskFile(null);
      setMode("edit");
      setError(null);
      setStatus(null);
      window.scrollTo({ top: 0 });
    } catch (err) {
      setError(`载入图片到编辑模式失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const buildPayload = (): Record<string, unknown> | null => {
    const payload: Record<string, unknown> = { model, prompt, n };
    if (size && size !== "auto") payload.size = size;
    if (responseFormat) payload.response_format = responseFormat;
    try {
      const parsed = JSON.parse(extra || "{}") as Record<string, unknown>;
      return { ...payload, ...parsed };
    } catch {
      setError("高级参数不是合法 JSON");
      return null;
    }
  };

  const stopPolling = (): void => {
    activityRef.current += 1;
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  // 每 1s 轮询 job 状态；job 挂在服务端，切走页面再回来也能继续等
  const pollJob = (jobId: string): void => {
    stopPolling();
    const pollId = activityRef.current;
    const tick = async (): Promise<void> => {
      try {
        const job = await fetchJobIfCurrent(jobId, () => activityRef.current === pollId, fetchJob);
        if (!job) return;
        setChannel(job.channel);
        setStatus(job.progress ?? (job.status === "running" ? "生成中…" : null));
        setImages(job.images.map((i) => i.url));
        setRevisedPrompts(job.images.map((i) => i.revisedPrompt).filter((v): v is string => !!v));
        if (job.status === "running") return;
        stopPolling();
        localStorage.removeItem(JOB_KEY);
        setElapsed(job.latencyMs);
        setRunning(false);
        if (job.status === "error") setError(job.error ?? "生成失败");
        notifyQuotaChanged();
      } catch (err) {
        if (activityRef.current !== pollId) return;
        stopPolling();
        localStorage.removeItem(JOB_KEY);
        setRunning(false);
        if (err instanceof ApiError && err.status === 404) {
          setError("任务已丢失（服务重启或任务过期），可到历史页查看结果");
        } else {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    };
    timerRef.current = setInterval(() => void tick(), 1000);
    void tick();
  };

  const run = async (e: FormEvent) => {
    e.preventDefault();
    if (running) return;
    setError(null);
    setImages([]);
    setRevisedPrompts([]);
    setChannel(null);
    setStatus(null);
    setElapsed(null);
    startedRef.current = Date.now();
    const activityId = ++activityRef.current;
    if (mode === "edit") {
      await runEdit(activityId);
      return;
    }
    const payload = buildPayload();
    if (!payload) return;
    setRunning(true);
    try {
      const { jobId } = await createJob(payload);
      if (activityRef.current !== activityId) return;
      localStorage.setItem(JOB_KEY, jobId);
      pollJob(jobId);
    } catch (err) {
      if (activityRef.current !== activityId) return;
      setError(err instanceof Error ? err.message : String(err));
      setRunning(false);
    }
  };

  // 编辑模式：上传完成后创建后台 job，复用文生图轮询，避免长连接被代理中断
  const runEdit = async (activityId: number): Promise<void> => {
    const extraObj: Record<string, unknown> = (() => {
      try {
        return JSON.parse(extra || "{}") as Record<string, unknown>;
      } catch {
        setError("高级参数不是合法 JSON");
        return {};
      }
    })();
    const form = new FormData();
    form.append("model", model);
    form.append("prompt", prompt);
    form.append("n", String(n));
    if (size && size !== "auto") form.append("size", size);
    // 结果要直接展示，统一要 url（服务端会自动做 b64→url 落盘）
    form.append("response_format", "url");
    for (const [k, v] of Object.entries(extraObj)) form.append(k, typeof v === "string" ? v : JSON.stringify(v));
    for (const f of editFiles) form.append("image", f, f.name);
    if (maskFile) form.append("mask", maskFile, maskFile.name);

    setRunning(true);
    try {
      await startEditJob(form, (jobId) => {
        localStorage.setItem(JOB_KEY, jobId);
        pollJob(jobId);
      }, createEditJob, () => activityRef.current === activityId);
    } catch (err) {
      if (activityRef.current !== activityId) return;
      setError(err instanceof Error ? err.message : String(err));
      setRunning(false);
    }
  };

  const cancel = (): void => {
    // 放弃轮询；服务端任务自然结束并写入历史
    stopPolling();
    localStorage.removeItem(JOB_KEY);
    setRunning(false);
    setStatus("已取消（任务结果仍会进入历史）");
  };

  const quickSubmit = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      e.currentTarget.closest("form")?.requestSubmit();
    }
  };

  const acknowledgeAnnouncement = (): void => {
    if (!announcement) return;
    persistAnnouncementAcknowledgement(announcement);
    setAnnouncement(null);
  };

  return (
    <>
      {announcement && <AnnouncementDialog value={announcement} onAcknowledge={acknowledgeAnnouncement} />}
      <div className="two-col">
      <form className="card" onSubmit={run}>
        <h2>Playground</h2>
        <div className="row" role="tablist" aria-label="生成模式">
          <button
            type="button"
            className={`btn ${mode === "generate" ? "primary" : "ghost"}`}
            aria-pressed={mode === "generate"}
            onClick={() => setMode("generate")}
          >
            文生图
          </button>
          <button
            type="button"
            className={`btn ${mode === "edit" ? "primary" : "ghost"}`}
            aria-pressed={mode === "edit"}
            onClick={() => setMode("edit")}
          >
            图片编辑
          </button>
        </div>
        <label htmlFor="pg-model">模型</label>
        {models.length === 0 ? (
          <p className="muted">
            没有可用模型，请先到 <Link to="/admin">管理后台</Link> 配置渠道与映射。
          </p>
        ) : (
          <select id="pg-model" value={model} onChange={(e) => setModel(e.target.value)}>
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        )}
        <label htmlFor="pg-prompt">Prompt（Ctrl+Enter 生成）</label>
        <textarea
          id="pg-prompt"
          rows={4}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={quickSubmit}
          placeholder={mode === "edit" ? "描述要如何修改上传的图片…" : "描述你想生成的图片…"}
          required
        />
        {mode === "edit" && (
          <>
            <EditImageInput files={editFiles} previews={editPreviews} onChange={setEditFiles} />
            <label htmlFor="pg-edit-mask">蒙版 mask（可选，透明区域将被重绘）</label>
            <input
              id="pg-edit-mask"
              type="file"
              accept="image/png"
              onChange={(e) => setMaskFile(e.target.files?.[0] ?? null)}
            />
            {maskFile && <p className="muted">{maskFile.name}</p>}
          </>
        )}
        <div className="row">
          <div>
            <label htmlFor="pg-n">数量 n</label>
            <input
              id="pg-n"
              type="number"
              min={1}
              max={4}
              value={n}
              onChange={(e) => {
                const v = Number(e.target.value);
                setN(Number.isFinite(v) ? Math.min(4, Math.max(1, Math.round(v))) : 1);
              }}
            />
          </div>
          <div>
            <label htmlFor="pg-size">尺寸</label>
            <select
              id="pg-size"
              value={SIZE_PRESETS.includes(size) ? size : "custom"}
              onChange={(e) => {
                if (e.target.value === "custom") {
                  if (SIZE_PRESETS.includes(size) || size === "") setSize("1024x1024");
                } else {
                  setSize(e.target.value);
                }
              }}
            >
              {SIZE_PRESETS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
              <option value="custom">自定义…</option>
            </select>
            {!SIZE_PRESETS.includes(size) && (
              <input
                id="pg-size-custom"
                aria-label="自定义尺寸"
                value={size}
                onChange={(e) => setSize(e.target.value)}
                placeholder="1024x1024"
              />
            )}
          </div>
        </div>
        <label htmlFor="pg-rf">response_format</label>
        <select id="pg-rf" value={responseFormat} onChange={(e) => setResponseFormat(e.target.value)}>
          <option value="">跟随上游</option>
          <option value="url">url</option>
          <option value="b64_json">b64_json</option>
        </select>
        <details>
          <summary className="muted">高级参数（JSON，透传上游）</summary>
          <textarea
            aria-label="高级参数 JSON"
            rows={3}
            value={extra}
            onChange={(e) => setExtra(e.target.value)}
            onKeyDown={quickSubmit}
            spellCheck={false}
          />
        </details>
        <div className="row">
          <button className="btn primary" type="submit" disabled={running || !model || !prompt || (mode === "edit" && editFiles.length === 0)}>
            {running ? "生成中…" : mode === "edit" ? "编辑" : "生成"}
          </button>
          {running && (
            <button className="btn ghost" type="button" onClick={cancel}>
              取消
            </button>
          )}
        </div>
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
      </form>

      <div className="card">
        <h2>结果</h2>
        <div className="meta">
          {channel && <span className="pill">渠道: {channel}</span>}
          {elapsed !== null && <span className="pill">{elapsed} ms</span>}
          {status && <span className="pill">{status}</span>}
          {running && !status && (
            <span className="pill hourglass">
              <span aria-hidden="true" className="hourglass-icon">⌛</span>
              生成中
            </span>
          )}
        </div>
        {images.length === 0 && !running && <p className="muted">尚无结果。在左侧填写 Prompt 后点「生成」。</p>}
        <div className="gallery">
          {images.map((src, i) => (
            <figure key={i} className="shot">
              <img
                src={src}
                alt={prompt ? `生成结果：${prompt.slice(0, 60)}` : `生成结果 ${i + 1}`}
                title="点击进入图片编辑"
                onClick={() => void loadIntoEdit(src)}
              />
              <a className="btn small" href={src} download={`tiny-images-${Date.now()}-${i + 1}.png`}>
                下载
              </a>
            </figure>
          ))}
          {running &&
            Array.from({ length: Math.max(0, n - images.length) }, (_, i) => (
              <figure key={`pending-${i}`} className="shot">
                <div className="loading-tile" role="status" aria-label="图片生成中">
                  <span className="loading-label">正在生成…</span>
                  <span className="w95-progress" aria-hidden="true">
                    <span className="w95-progress-blocks" />
                  </span>
                </div>
              </figure>
            ))}
        </div>
        {revisedPrompts.length > 0 && (
          <details>
            <summary className="muted">详情（revised_prompt）</summary>
            <div className="result-details">
              {revisedPrompts.map((rp, i) => (
                <p key={i} className="muted">
                  revised_prompt：{rp}
                </p>
              ))}
            </div>
          </details>
        )}
      </div>
      </div>
    </>
  );
}
