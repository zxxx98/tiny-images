import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { api, createJob, fetchJob, notifyQuotaChanged, ApiError } from "../api";

interface ModelsResponse {
  data: { id: string }[];
}

const SIZE_PRESETS = ["auto", "1024x1024", "1536x1024", "1024x1536", "512x512", "256x256"];

const JOB_KEY = "tiny-running-job";
const DRAFT_KEY = "tiny-playground-draft";

interface Draft {
  model?: string;
  prompt?: string;
  n?: number;
  size?: string;
  responseFormat?: string;
  extra?: string;
}

export default function Playground() {
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState("");
  const [prompt, setPrompt] = useState("");
  const [n, setN] = useState(1);
  const [size, setSize] = useState("auto");
  const [responseFormat, setResponseFormat] = useState("");
  const [extra, setExtra] = useState("{}");
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [channel, setChannel] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [images, setImages] = useState<string[]>([]);
  const [revisedPrompts, setRevisedPrompts] = useState<string[]>([]);
  const [preview, setPreview] = useState<{ src: string; prompt: string } | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
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

  // 恢复草稿、导航带入的参数（历史页「重新生成」），以及未完成的生成 job
  useEffect(() => {
    try {
      const draft = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? "{}") as Draft;
      const fromNav = (location.state ?? null) as { prompt?: string; model?: string; size?: string } | null;
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
      if (timerRef.current) clearInterval(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 表单草稿持久化，切走再回来不丢输入
  useEffect(() => {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ model, prompt, n, size, responseFormat, extra }));
  }, [model, prompt, n, size, responseFormat, extra]);

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
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  // 每 1s 轮询 job 状态；job 挂在服务端，切走页面再回来也能继续等
  const pollJob = (jobId: string): void => {
    const tick = async (): Promise<void> => {
      try {
        const job = await fetchJob(jobId);
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
    void tick();
    stopPolling();
    timerRef.current = setInterval(() => void tick(), 1000);
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
    const payload = buildPayload();
    if (!payload) return;
    startedRef.current = Date.now();
    setRunning(true);
    try {
      const { jobId } = await createJob(payload);
      localStorage.setItem(JOB_KEY, jobId);
      pollJob(jobId);
    } catch (err) {
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

  return (
    <div className="two-col">
      <form className="card" onSubmit={run}>
        <h2>Playground</h2>
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
          placeholder="描述你想生成的图片…"
          required
        />
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
          <button className="btn primary" type="submit" disabled={running || !model || !prompt}>
            {running ? "生成中…" : "生成"}
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
                onClick={() => setPreview({ src, prompt: prompt || `生成结果 ${i + 1}` })}
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
      {preview && (
        <div className="lightbox" role="dialog" onClick={() => setPreview(null)}>
          <img src={preview.src} alt={preview.prompt} />
          <p className="mono">{preview.prompt}</p>
        </div>
      )}
    </div>
  );
}
