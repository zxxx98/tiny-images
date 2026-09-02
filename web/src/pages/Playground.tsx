import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import {
  addFavorite,
  api,
  createEditJob,
  createJob,
  createUpscaleJob,
  deleteFavorite,
  fetchAnnouncement,
  fetchFavorites,
  fetchFeatures,
  fetchJob,
  notifyQuotaChanged,
  optimizePrompt,
  translatePrompt,
  ApiError,
  type Announcement,
  type JobKind,
  type PromptFavorite,
} from "../api";
import AnnouncementDialog, {
  ANNOUNCEMENT_ACK_KEY,
  persistAnnouncementAcknowledgement,
  shouldShowAnnouncement,
} from "./AnnouncementDialog";
import EditImageInput from "./EditImageInput";
import Lightbox from "./Lightbox";
import { createPreset, loadPresets, newPresetId, PRESET_NAME_MAX, savePresets, type Preset } from "./presets";

interface ModelsResponse {
  data: { id: string; supportsImageToImage?: boolean }[];
}

interface PlaygroundModel {
  id: string;
  supportsImageToImage: boolean;
}

const SIZE_PRESETS = ["auto", "1024x1024", "1536x1024", "1024x1536", "2048x1152", "1152x2048", "2048x2048", "1792x1024", "1024x1792", "512x512", "256x256"];

const JOB_KEY = "tiny-running-job";
const DRAFT_KEY = "tiny-playground-draft";
const EDIT_NOT_SUPPORTED_MESSAGE = "当前模型不支持图生图";
const UPSCALE_NOT_SUPPORTED_MESSAGE = "当前部署未配置 Cloudflare Images 超分";

type PlaygroundMode = "generate" | "edit" | "upscale";

interface Draft {
  mode?: PlaygroundMode;
  model?: string;
  prompt?: string;
  n?: number;
  size?: string;
  responseFormat?: string;
  extra?: string;
  upscaleScale?: 2 | 4;
}

interface RunningJob {
  id: string;
  kind?: JobKind;
}

interface NavigationState {
  prompt?: string;
  model?: string;
  size?: string;
  editImageUrl?: string;
  upscaleImageUrl?: string;
}

type MultipartJobCreator = (form: FormData) => Promise<{ jobId: string }>;

export async function startMultipartJob(
  form: FormData,
  onStarted: (jobId: string) => void,
  create: MultipartJobCreator,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  const { jobId } = await create(form);
  if (isCurrent()) onStarted(jobId);
}

export async function startEditJob(
  form: FormData,
  onStarted: (jobId: string) => void,
  create: MultipartJobCreator = createEditJob,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  return startMultipartJob(form, onStarted, create, isCurrent);
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

export function parseRunningJob(value: string | null): RunningJob | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<RunningJob>;
    if (typeof parsed.id === "string" && parsed.id) {
      const kind = parsed.kind === "generate" || parsed.kind === "edit" || parsed.kind === "upscale" ? parsed.kind : undefined;
      return { id: parsed.id, kind };
    }
  } catch {
    // 旧版本只保存裸 job id，继续兼容恢复。
  }
  return { id: value };
}

function fileFromImageResponse(blob: Blob, prefix: string): File {
  const ext = blob.type.includes("jpeg") ? "jpg" : blob.type.includes("webp") ? "webp" : "png";
  return new File([blob], `${prefix}.${ext}`, { type: blob.type || "image/png" });
}

function defaultProgress(kind: JobKind | undefined): string {
  return kind === "upscale" ? "正在进行 AI 超分，首次处理通常比普通图片处理更久…" : "生成中…";
}

function defaultFailure(kind: JobKind | undefined): string {
  return kind === "upscale" ? "超分失败，可重试" : kind === "edit" ? "编辑失败" : "生成失败";
}

// 选一个支持图生图的模型：当前模型可用则保持，否则取第一个支持编辑的。
function pickEditableModelId(models: PlaygroundModel[], current: string): string | null {
  if (models.some((m) => m.id === current && m.supportsImageToImage)) return current;
  return models.find((m) => m.supportsImageToImage)?.id ?? null;
}

export default function Playground() {
  const [mode, setMode] = useState<PlaygroundMode>("generate");
  const [models, setModels] = useState<PlaygroundModel[]>([]);
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [model, setModel] = useState("");
  const [prompt, setPrompt] = useState("");
  const [n, setN] = useState(1);
  const [size, setSize] = useState("auto");
  const [responseFormat, setResponseFormat] = useState("");
  const [extra, setExtra] = useState("{}");
  const [editFiles, setEditFiles] = useState<File[]>([]);
  const [maskFile, setMaskFile] = useState<File | null>(null);
  const [editPreviews, setEditPreviews] = useState<string[]>([]);
  const [upscaleEnabled, setUpscaleEnabled] = useState(false);
  const [featuresLoaded, setFeaturesLoaded] = useState(false);
  const [optimizerEnabled, setOptimizerEnabled] = useState(false);
  const [optimizing, setOptimizing] = useState(false);
  const [translating, setTranslating] = useState(false);
  // 优化/翻译前的提示词，用于「撤销」；手动编辑或再次撤销后清空
  const [undoPrompt, setUndoPrompt] = useState<string | null>(null);
  const [favorites, setFavorites] = useState<PromptFavorite[]>([]);
  const [favoriting, setFavoriting] = useState(false);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [activePresetId, setActivePresetId] = useState("");
  const [upscaleFile, setUpscaleFile] = useState<File | null>(null);
  const [upscalePreview, setUpscalePreview] = useState<string | null>(null);
  const [upscaleScale, setUpscaleScale] = useState<2 | 4>(2);
  const [pendingEditUrl, setPendingEditUrl] = useState<string | null>(null);
  const [zoomSrc, setZoomSrc] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [runningKind, setRunningKind] = useState<JobKind | undefined>(undefined);
  const [status, setStatus] = useState<string | null>(null);
  const [channel, setChannel] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [images, setImages] = useState<string[]>([]);
  const [revisedPrompts, setRevisedPrompts] = useState<string[]>([]);
  const [announcement, setAnnouncement] = useState<Announcement | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const activityRef = useRef(0);
  const location = useLocation();
  const selectedModel = models.find((item) => item.id === model);
  const canEdit = selectedModel?.supportsImageToImage === true;
  const hasEditableModel = models.some((item) => item.supportsImageToImage);

  useEffect(() => {
    api<ModelsResponse>("/v1/models")
      .then((r) => {
        setModels(r.data.map((m) => ({ id: m.id, supportsImageToImage: m.supportsImageToImage === true })));
        if (r.data.length > 0) setModel((cur) => cur || r.data[0].id);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setModelsLoaded(true));
  }, []);

  useEffect(() => {
    fetchFeatures()
      .then((features) => {
        setUpscaleEnabled(features.upscale === true);
        setOptimizerEnabled(features.promptOptimizer === true);
      })
      .catch(() => {
        setUpscaleEnabled(false);
        setOptimizerEnabled(false);
      })
      .finally(() => setFeaturesLoaded(true));
  }, []);

  useEffect(() => {
    fetchAnnouncement()
      .then((value) => {
        if (shouldShowAnnouncement(value, localStorage.getItem(ANNOUNCEMENT_ACK_KEY))) setAnnouncement(value);
      })
      .catch(() => undefined);
  }, []);

  const reloadFavorites = (): void => {
    fetchFavorites()
      .then((rows) => setFavorites(rows))
      .catch(() => setFavorites([]));
  };

  useEffect(reloadFavorites, []);

  useEffect(() => {
    setPresets(loadPresets());
  }, []);

  // 恢复草稿、历史页带入参数，以及未完成的 job。运行任务的新格式包含 kind，旧裸 id 仍可恢复。
  useEffect(() => {
    try {
      const draft = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? "{}") as Draft;
      const fromNav = (location.state ?? null) as NavigationState | null;
      if (draft.mode === "generate" || draft.mode === "edit") setMode(draft.mode);
      if (fromNav?.editImageUrl) setPendingEditUrl(fromNav.editImageUrl);
      if (fromNav?.prompt) setPrompt(fromNav.prompt);
      else if (draft.prompt) setPrompt(draft.prompt);
      if (fromNav?.model) setModel(fromNav.model);
      else if (draft.model) setModel(draft.model);
      if (fromNav?.size) setSize(fromNav.size);
      if (draft.n) setN(draft.n);
      if (draft.responseFormat) setResponseFormat(draft.responseFormat);
      if (draft.extra) setExtra(draft.extra);
      if (draft.upscaleScale === 2 || draft.upscaleScale === 4) setUpscaleScale(draft.upscaleScale);
    } catch {
      // 草稿损坏则忽略
    }
    const savedJob = parseRunningJob(localStorage.getItem(JOB_KEY));
    if (savedJob) {
      setRunning(true);
      setRunningKind(savedJob.kind);
      pollJob(savedJob.id, savedJob.kind);
    }
    return () => {
      activityRef.current += 1;
      if (timerRef.current) clearInterval(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 功能探测完成后再恢复超分草稿/历史跳转，避免请求竞态绕过 feature gate。
  useEffect(() => {
    if (!featuresLoaded) return;
    const fromNav = (location.state ?? null) as NavigationState | null;
    let draftMode: PlaygroundMode | undefined;
    try {
      draftMode = (JSON.parse(localStorage.getItem(DRAFT_KEY) ?? "{}") as Draft).mode;
    } catch {
      draftMode = undefined;
    }
    if (fromNav?.upscaleImageUrl) {
      if (upscaleEnabled) void loadIntoUpscale(fromNav.upscaleImageUrl);
      else setError(UPSCALE_NOT_SUPPORTED_MESSAGE);
    } else if (draftMode === "upscale" && upscaleEnabled) {
      setMode("upscale");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [featuresLoaded]);

  // 模型列表就绪后再载入历史页带来的编辑图，以便自动选中支持图生图的模型。
  useEffect(() => {
    if (!modelsLoaded || !pendingEditUrl) return;
    const url = pendingEditUrl;
    setPendingEditUrl(null);
    void loadIntoEdit(url);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelsLoaded, pendingEditUrl]);

  // 表单草稿持久化，切走再回来不丢文本和倍率（文件不持久化）。
  useEffect(() => {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ mode, model, prompt, n, size, responseFormat, extra, upscaleScale }));
  }, [mode, model, prompt, n, size, responseFormat, extra, upscaleScale]);

  useEffect(() => {
    const urls = editFiles.map((f) => URL.createObjectURL(f));
    setEditPreviews(urls);
    return () => urls.forEach((u) => URL.revokeObjectURL(u));
  }, [editFiles]);

  useEffect(() => {
    if (!upscaleFile) {
      setUpscalePreview(null);
      return;
    }
    const url = URL.createObjectURL(upscaleFile);
    setUpscalePreview(url);
    return () => URL.revokeObjectURL(url);
  }, [upscaleFile]);

  // 编辑模式下当前模型不支持图生图时，自动切到支持的模型，避免被弹回文生图。
  useEffect(() => {
    if (mode !== "edit" || !modelsLoaded) return;
    if (selectedModel?.supportsImageToImage) return;
    const candidate = models.find((item) => item.supportsImageToImage);
    if (candidate) setModel(candidate.id);
  }, [mode, models, modelsLoaded, selectedModel]);

  useEffect(() => {
    if (mode === "edit" && modelsLoaded && !hasEditableModel) {
      setMode("generate");
      setError(EDIT_NOT_SUPPORTED_MESSAGE);
    }
    if (mode === "upscale" && featuresLoaded && !upscaleEnabled) setMode("generate");
  }, [featuresLoaded, hasEditableModel, modelsLoaded, mode, upscaleEnabled]);

  // 把一张结果图载入编辑模式；入口是结果区的「编辑」按钮（点击图片为放大查看）。
  // 当前模型不支持图生图时自动切到支持的模型，只有完全没有任何可编辑模型才拒绝。
  const loadIntoEdit = async (src: string): Promise<void> => {
    const editableId = pickEditableModelId(models, model);
    if (modelsLoaded && !editableId) {
      setError(EDIT_NOT_SUPPORTED_MESSAGE);
      return;
    }
    if (editableId && editableId !== model) setModel(editableId);
    try {
      const res = await fetch(src);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      setEditFiles([fileFromImageResponse(blob, "edit-src")]);
      setMaskFile(null);
      setMode("edit");
      setError(null);
      setStatus(null);
      window.scrollTo({ top: 0 });
    } catch (err) {
      setError(`载入图片到编辑模式失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // 仅在拉取成功后切换模式，失败时保留当前模式和结果。
  const loadIntoUpscale = async (src: string): Promise<void> => {
    if (!upscaleEnabled) {
      setError(UPSCALE_NOT_SUPPORTED_MESSAGE);
      return;
    }
    try {
      const res = await fetch(src);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      setUpscaleFile(fileFromImageResponse(blob, "upscale-src"));
      setUpscaleScale(2);
      setMaskFile(null);
      setMode("upscale");
      setError(null);
      setStatus(null);
      window.scrollTo({ top: 0 });
    } catch (err) {
      setError(`载入图片到超分模式失败：${err instanceof Error ? err.message : String(err)}`);
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

  // 所有任务复用同一轮询；kind 控制状态、错误和单个超分占位图。
  const pollJob = (jobId: string, expectedKind?: JobKind): void => {
    stopPolling();
    const pollId = activityRef.current;
    const tick = async (): Promise<void> => {
      try {
        const job = await fetchJobIfCurrent(jobId, () => activityRef.current === pollId, fetchJob);
        if (!job) return;
        const kind = job.kind ?? expectedKind;
        setRunningKind(kind);
        setChannel(job.channel);
        setStatus(job.progress ?? (job.status === "running" ? defaultProgress(kind) : null));
        setImages(job.images.map((i) => i.url));
        setRevisedPrompts(job.images.map((i) => i.revisedPrompt).filter((v): v is string => !!v));
        if (job.status === "running") return;
        stopPolling();
        localStorage.removeItem(JOB_KEY);
        setElapsed(job.latencyMs);
        setRunning(false);
        if (job.status === "error") setError(job.error ?? defaultFailure(kind));
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

  const rememberAndPoll = (jobId: string, kind: JobKind): void => {
    localStorage.setItem(JOB_KEY, JSON.stringify({ id: jobId, kind } satisfies RunningJob));
    setRunningKind(kind);
    pollJob(jobId, kind);
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
    const activityId = ++activityRef.current;
    if (mode === "edit") {
      if (!canEdit) {
        setError(EDIT_NOT_SUPPORTED_MESSAGE);
        setMode("generate");
        return;
      }
      await runEdit(activityId);
      return;
    }
    if (mode === "upscale") {
      await runUpscale(activityId);
      return;
    }
    const payload = buildPayload();
    if (!payload) return;
    setRunning(true);
    setRunningKind("generate");
    try {
      const { jobId } = await createJob(payload);
      if (activityRef.current !== activityId) return;
      rememberAndPoll(jobId, "generate");
    } catch (err) {
      if (activityRef.current !== activityId) return;
      setError(err instanceof Error ? err.message : String(err));
      setRunning(false);
    }
  };

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
    form.append("response_format", "url");
    for (const [k, v] of Object.entries(extraObj)) form.append(k, typeof v === "string" ? v : JSON.stringify(v));
    for (const f of editFiles) form.append("image", f, f.name);
    if (maskFile) form.append("mask", maskFile, maskFile.name);

    setRunning(true);
    setRunningKind("edit");
    try {
      await startEditJob(form, (jobId) => rememberAndPoll(jobId, "edit"), createEditJob, () => activityRef.current === activityId);
    } catch (err) {
      if (activityRef.current !== activityId) return;
      setError(err instanceof Error ? err.message : String(err));
      setRunning(false);
    }
  };

  const runUpscale = async (activityId: number): Promise<void> => {
    if (!upscaleEnabled) {
      setError(UPSCALE_NOT_SUPPORTED_MESSAGE);
      return;
    }
    if (!upscaleFile) {
      setError("请选择一张要超分的图片");
      return;
    }
    const form = new FormData();
    form.append("image", upscaleFile, upscaleFile.name);
    form.append("scale", String(upscaleScale));
    form.append("response_format", "url");
    setRunning(true);
    setRunningKind("upscale");
    try {
      await startMultipartJob(form, (jobId) => rememberAndPoll(jobId, "upscale"), createUpscaleJob, () => activityRef.current === activityId);
    } catch (err) {
      if (activityRef.current !== activityId) return;
      setError(err instanceof Error ? err.message : String(err));
      setRunning(false);
    }
  };

  const cancel = (): void => {
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

  // 用管理后台配置的 AI 改写当前提示词；成功后可直接「撤销」回到改写前
  const optimize = async (): Promise<void> => {
    if (optimizing || !prompt.trim()) return;
    setOptimizing(true);
    setError(null);
    try {
      const { prompt: optimized } = await optimizePrompt(prompt);
      if (!optimized.trim()) throw new Error("优化结果为空");
      setUndoPrompt(prompt);
      setPrompt(optimized);
    } catch (err) {
      setError(`AI 优化失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setOptimizing(false);
    }
  };

  // 中英互译：方向由服务端按提示词语言自动判断
  const translate = async (): Promise<void> => {
    if (translating || !prompt.trim()) return;
    setTranslating(true);
    setError(null);
    try {
      const { prompt: translated } = await translatePrompt(prompt);
      if (!translated.trim()) throw new Error("翻译结果为空");
      setUndoPrompt(prompt);
      setPrompt(translated);
    } catch (err) {
      setError(`AI 翻译失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setTranslating(false);
    }
  };

  const undoEdit = (): void => {
    if (undoPrompt === null) return;
    setPrompt(undoPrompt);
    setUndoPrompt(null);
    setError(null);
  };

  const favorite = async (): Promise<void> => {
    if (favoriting || !prompt.trim()) return;
    setFavoriting(true);
    setError(null);
    try {
      await addFavorite(prompt.trim());
      reloadFavorites();
    } catch (err) {
      setError(`收藏失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setFavoriting(false);
    }
  };

  const removeFavorite = async (id: number): Promise<void> => {
    try {
      await deleteFavorite(id);
      reloadFavorites();
    } catch (err) {
      setError(`删除收藏失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const applyPreset = (id: string): void => {
    setActivePresetId(id);
    if (!id) return;
    const preset = presets.find((p) => p.id === id);
    if (!preset) return;
    const { params } = preset;
    if (params.model && models.some((m) => m.id === params.model)) setModel(params.model);
    if (typeof params.n === "number") setN(Math.min(4, Math.max(1, Math.round(params.n))));
    if (params.size) setSize(params.size);
    if (params.responseFormat !== undefined) setResponseFormat(params.responseFormat);
    if (params.extra !== undefined) setExtra(params.extra);
    setError(null);
  };

  const currentPresetParams = (): { model: string; n: number; size: string; responseFormat: string; extra: string } => ({
    model,
    n,
    size,
    responseFormat,
    extra,
  });

  const savePreset = (): void => {
    const name = window.prompt(`预设名称（最多 ${PRESET_NAME_MAX} 字）`, "");
    if (name === null) return; // 取消
    const preset = createPreset(name || `预设 ${presets.length + 1}`, currentPresetParams(), newPresetId());
    const next = [preset, ...presets];
    setPresets(next);
    savePresets(next);
    setActivePresetId(preset.id);
  };

  const deletePreset = (): void => {
    if (!activePresetId) return;
    const preset = presets.find((p) => p.id === activePresetId);
    if (preset && !window.confirm(`删除预设「${preset.name}」？`)) return;
    const next = presets.filter((p) => p.id !== activePresetId);
    setPresets(next);
    savePresets(next);
    setActivePresetId("");
  };

  const acknowledgeAnnouncement = (): void => {
    if (!announcement) return;
    persistAnnouncementAcknowledgement(announcement);
    setAnnouncement(null);
  };

  const placeholderCount = runningKind === "upscale" ? Math.max(0, 1 - images.length) : Math.max(0, n - images.length);
  const runningLabel = runningKind === "upscale" ? "超分中" : "生成中";

  return (
    <>
      {announcement && <AnnouncementDialog value={announcement} onAcknowledge={acknowledgeAnnouncement} />}
      <div className="two-col">
        <form className="card" onSubmit={run}>
          <h2>Playground</h2>
          <div className="row" role="tablist" aria-label="生成模式">
            <button type="button" className={`btn ${mode === "generate" ? "primary" : "ghost"}`} aria-pressed={mode === "generate"} onClick={() => setMode("generate")}>
              文生图
            </button>
            <span className="btn-tooltip" title={!hasEditableModel ? EDIT_NOT_SUPPORTED_MESSAGE : undefined}>
              <button
                type="button"
                className={`btn ${mode === "edit" ? "primary" : "ghost"}`}
                aria-pressed={mode === "edit"}
                disabled={running || !hasEditableModel}
                onClick={() => setMode("edit")}
              >
                图片编辑
              </button>
            </span>
            {upscaleEnabled && (
              <button
                type="button"
                className={`btn ${mode === "upscale" ? "primary" : "ghost"}`}
                aria-pressed={mode === "upscale"}
                disabled={running}
                onClick={() => setMode("upscale")}
              >
                图片超分
              </button>
            )}
          </div>

          {mode === "upscale" ? (
            <>
              <label htmlFor="pg-upscale-image">原图（单张 PNG/JPG/WebP）</label>
              <input
                id="pg-upscale-image"
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={(e) => setUpscaleFile(e.target.files?.[0] ?? null)}
                required={!upscaleFile}
              />
              {upscaleFile && upscalePreview && (
                <figure className="edit-preview upscale-preview" title={upscaleFile.name}>
                  <img src={upscalePreview} alt={`超分原图：${upscaleFile.name}`} />
                  <figcaption className="muted">{upscaleFile.name}</figcaption>
                </figure>
              )}
              <label htmlFor="pg-upscale-scale">放大倍率</label>
              <select id="pg-upscale-scale" value={upscaleScale} onChange={(e) => setUpscaleScale(Number(e.target.value) === 4 ? 4 : 2)}>
                <option value={2}>2×</option>
                <option value={4}>4×</option>
              </select>
            </>
          ) : (
            <>
              <label htmlFor="pg-preset">参数预设（模型、数量、尺寸、response_format、高级参数）</label>
              <div className="row preset-row">
                <select
                  id="pg-preset"
                  value={activePresetId}
                  onChange={(e) => applyPreset(e.target.value)}
                  disabled={presets.length === 0 && !activePresetId}
                >
                  <option value="">{presets.length === 0 ? "暂无预设" : "选择预设…"}</option>
                  {presets.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <button className="btn small" type="button" title="把当前参数保存为预设" onClick={savePreset}>
                  存为预设
                </button>
                {activePresetId && (
                  <button className="btn small danger" type="button" onClick={deletePreset}>
                    删除预设
                  </button>
                )}
              </div>
              <label htmlFor="pg-model">模型</label>
              {models.length === 0 ? (
                <p className="muted">
                  没有可用模型，请先到 <Link to="/admin">管理后台</Link> 配置渠道与映射。
                </p>
              ) : (
                <select id="pg-model" value={model} onChange={(e) => setModel(e.target.value)}>
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.id}
                    </option>
                  ))}
                </select>
              )}
              <div className="prompt-head">
                <label htmlFor="pg-prompt">Prompt（Ctrl+Enter 生成）</label>
                <span className="prompt-actions">
                  {undoPrompt !== null && (
                    <button className="btn small" type="button" onClick={undoEdit} disabled={optimizing || translating}>
                      撤销
                    </button>
                  )}
                  <button
                    className="btn small"
                    type="button"
                    title="把当前提示词加入收藏夹"
                    onClick={() => void favorite()}
                    disabled={favoriting || running || !prompt.trim()}
                  >
                    {favoriting ? "收藏中…" : "收藏"}
                  </button>
                  {optimizerEnabled && (
                    <>
                      <button
                        className="btn small"
                        type="button"
                        title="在中英之间翻译当前提示词（方向自动判断）"
                        onClick={() => void translate()}
                        disabled={optimizing || translating || running || !prompt.trim()}
                      >
                        {translating ? "翻译中…" : "翻译"}
                      </button>
                      <button
                        className="btn small"
                        type="button"
                        title="用 AI 改写当前提示词"
                        onClick={() => void optimize()}
                        disabled={optimizing || translating || running || !prompt.trim()}
                      >
                        {optimizing ? "优化中…" : "AI 优化"}
                      </button>
                    </>
                  )}
                </span>
              </div>
              <textarea
                id="pg-prompt"
                rows={4}
                value={prompt}
                onChange={(e) => {
                  setPrompt(e.target.value);
                  if (undoPrompt !== null) setUndoPrompt(null);
                }}
                onKeyDown={quickSubmit}
                placeholder={mode === "edit" ? "描述要如何修改上传的图片…" : "描述你想生成的图片…"}
                required
              />
              <details className="favorites">
                <summary className="muted">收藏夹（{favorites.length}）</summary>
                {favorites.length === 0 ? (
                  <p className="muted">还没有收藏的提示词。输入提示词后点「收藏」即可保存，点击条目可填入输入框。</p>
                ) : (
                  <ul className="favorite-list">
                    {favorites.map((f) => (
                      <li key={f.id}>
                        <button
                          type="button"
                          className="favorite-content"
                          title="点击填入输入框"
                          onClick={() => {
                            setPrompt(f.content);
                            if (undoPrompt !== null) setUndoPrompt(null);
                          }}
                        >
                          {f.content}
                        </button>
                        <button type="button" className="link danger" onClick={() => void removeFavorite(f.id)}>
                          删除
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </details>
              {mode === "edit" && (
                <>
                  <EditImageInput files={editFiles} previews={editPreviews} onChange={setEditFiles} />
                  <label htmlFor="pg-edit-mask">蒙版 mask（可选，透明区域将被重绘）</label>
                  <input id="pg-edit-mask" type="file" accept="image/png" onChange={(e) => setMaskFile(e.target.files?.[0] ?? null)} />
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
                  {!SIZE_PRESETS.includes(size) && <input id="pg-size-custom" aria-label="自定义尺寸" value={size} onChange={(e) => setSize(e.target.value)} placeholder="1024x1024" />}
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
                <textarea aria-label="高级参数 JSON" rows={3} value={extra} onChange={(e) => setExtra(e.target.value)} onKeyDown={quickSubmit} spellCheck={false} />
              </details>
            </>
          )}

          <div className="row">
            <button
              className="btn primary"
              type="submit"
              disabled={
                running ||
                (mode === "upscale" ? !upscaleEnabled || !upscaleFile : !model || !prompt || (mode === "edit" && (!canEdit || editFiles.length === 0)))
              }
            >
              {running ? (runningKind === "upscale" ? "超分中…" : "生成中…") : mode === "edit" ? "编辑" : mode === "upscale" ? "开始超分" : "生成"}
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
                {runningLabel}
              </span>
            )}
          </div>
          {images.length === 0 && !running && <p className="muted">{mode === "upscale" ? "尚无结果。上传一张图片并选择倍率后开始超分。" : "尚无结果。在左侧填写 Prompt 后点「生成」。"}</p>}
          <div className="gallery">
            {images.map((src, i) => (
              <figure key={i} className="shot">
                <img
                  src={src}
                  alt={prompt ? `生成结果：${prompt.slice(0, 60)}` : `生成结果 ${i + 1}`}
                  title="点击放大查看"
                  onClick={() => setZoomSrc(src)}
                />
                <div className="shot-actions">
                  <a className="btn small" href={src} download={`tiny-images-${Date.now()}-${i + 1}.png`}>
                    下载
                  </a>
                  <button className="btn small" type="button" disabled={!hasEditableModel} onClick={() => void loadIntoEdit(src)}>
                    编辑
                  </button>
                  {upscaleEnabled && (
                    <button className="btn small" type="button" onClick={() => void loadIntoUpscale(src)}>
                      超分
                    </button>
                  )}
                </div>
              </figure>
            ))}
            {running &&
              Array.from({ length: placeholderCount }, (_, i) => (
                <figure key={`pending-${i}`} className="shot">
                  <div className="loading-tile" role="status" aria-label={runningKind === "upscale" ? "图片超分中" : "图片生成中"}>
                    <span className="loading-label">{runningKind === "upscale" ? "正在超分…" : "正在生成…"}</span>
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
      {zoomSrc && <Lightbox src={zoomSrc} alt="生成结果" onClose={() => setZoomSrc(null)} />}
    </>
  );
}
