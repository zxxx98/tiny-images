import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import {
  addFavorite,
  api,
  createEditJob,
  createJob,
  createUpscaleJob,
  deleteFavorite,
  downloadImage,
  fetchAnnouncement,
  fetchFavorites,
  fetchFeatures,
  fetchJob,
  notifyQuotaChanged,
  optimizePrompt,
  translatePrompt,
  reverseImagePrompt,
  shareToPlaza,
  ApiError,
  type Announcement,
  type JobKind,
  type PromptFavorite,
  type ReverseStyle,
} from "../api";
import AnnouncementDialog, {
  ANNOUNCEMENT_ACK_KEY,
  persistAnnouncementAcknowledgement,
  shouldShowAnnouncement,
} from "./AnnouncementDialog";
import EditImageInput from "./EditImageInput";
import Lightbox from "./Lightbox";
import TemplateLibrary from "./TemplateLibrary";
import { createPreset, loadPresets, newPresetId, PRESET_NAME_MAX, savePresets, type Preset } from "./presets";
import type { OfficialTemplate } from "../api";

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
const REVERSE_NOT_CONFIGURED_MESSAGE = "当前部署未配置图片反推";
const REVERSE_MAX_INPUT_BYTES = 20 * 1024 * 1024;

const REVERSE_STYLE_OPTIONS: { value: ReverseStyle; label: string }[] = [
  { value: "concise", label: "简洁版" },
  { value: "detailed", label: "详细版" },
  { value: "cinematic", label: "极致风格版" },
];

type PlaygroundMode = "generate" | "edit" | "upscale" | "reverse";

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
  reverseImageUrl?: string;
}

type MultipartJobCreator = (form: FormData) => Promise<{ jobId: string }>;

// 历史记录反推导入只需要列表缩略图，这里用最小形状
interface ReverseHistoryItem {
  id: number;
  prompt: string;
  images: { url: string }[];
}

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

function readFileAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("读取图片文件失败"));
    reader.readAsDataURL(file);
  });
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
  const [reverseEnabled, setReverseEnabled] = useState(false);
  const [reverseFile, setReverseFile] = useState<File | null>(null);
  const [reversePreview, setReversePreview] = useState<string | null>(null);
  const [reverseStyle, setReverseStyle] = useState<ReverseStyle>("concise");
  const [reversing, setReversing] = useState(false);
  const [reverseResult, setReverseResult] = useState<string | null>(null);
  const [reverseCopied, setReverseCopied] = useState(false);
  const [reverseHistoryOpen, setReverseHistoryOpen] = useState(false);
  const [reverseHistoryLoading, setReverseHistoryLoading] = useState(false);
  const [reverseHistoryItems, setReverseHistoryItems] = useState<ReverseHistoryItem[]>([]);
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
  // 最近一次完成任务的 generationId，用于把单张结果图分享到广场
  const [lastGenerationId, setLastGenerationId] = useState<number | null>(null);
  const [sharedShots, setSharedShots] = useState<Record<number, boolean>>({});
  const [sharingShot, setSharingShot] = useState<number | null>(null);
  const [announcement, setAnnouncement] = useState<Announcement | null>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
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
        setReverseEnabled(features.promptReverse === true);
      })
      .catch(() => {
        setUpscaleEnabled(false);
        setOptimizerEnabled(false);
        setReverseEnabled(false);
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
      .then((rows) => setFavorites(Array.isArray(rows) ? rows : []))
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

  // 功能探测完成后再恢复超分/反推草稿、历史页跳转，避免请求竞态绕过 feature gate。
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
    } else if (fromNav?.reverseImageUrl) {
      if (reverseEnabled) void loadIntoReverse(fromNav.reverseImageUrl);
      else setError(REVERSE_NOT_CONFIGURED_MESSAGE);
    } else if (draftMode === "upscale" && upscaleEnabled) {
      setMode("upscale");
    } else if (draftMode === "reverse" && reverseEnabled) {
      setMode("reverse");
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

  useEffect(() => {
    if (!reverseFile) {
      setReversePreview(null);
      return;
    }
    const url = URL.createObjectURL(reverseFile);
    setReversePreview(url);
    return () => URL.revokeObjectURL(url);
  }, [reverseFile]);

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
    if (mode === "reverse" && featuresLoaded && !reverseEnabled) setMode("generate");
  }, [featuresLoaded, hasEditableModel, modelsLoaded, mode, reverseEnabled, upscaleEnabled]);

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

  // 把一张远程图片（历史记录 URL）拉回来作为反推输入；返回是否导入成功。
  const importReverseImage = async (src: string): Promise<boolean> => {
    try {
      const res = await fetch(src);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      setReverseFile(fileFromImageResponse(blob, "reverse-src"));
      setReverseResult(null);
      setReverseHistoryOpen(false);
      setError(null);
      return true;
    } catch (err) {
      setError(`导入图片失败：${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  };

  const loadIntoReverse = async (src: string): Promise<void> => {
    if (!reverseEnabled) {
      setError(REVERSE_NOT_CONFIGURED_MESSAGE);
      return;
    }
    // 导入成功才切换模式，失败时保留当前模式和结果
    if (await importReverseImage(src)) {
      setMode("reverse");
      window.scrollTo({ top: 0 });
    }
  };

  const openReverseHistory = async (): Promise<void> => {
    setReverseHistoryOpen(true);
    setReverseHistoryLoading(true);
    setError(null);
    try {
      const r = await api<{ items: ReverseHistoryItem[] }>("/v1/history?limit=24");
      setReverseHistoryItems(r.items.filter((item) => item.images.length > 0));
    } catch (err) {
      setError(`加载历史图片失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setReverseHistoryLoading(false);
    }
  };

  const runReverse = async (activityId: number): Promise<void> => {
    if (!reverseEnabled) {
      setError(REVERSE_NOT_CONFIGURED_MESSAGE);
      return;
    }
    if (!reverseFile) {
      setError("请选择一张要反推的图片");
      return;
    }
    if (reverseFile.size > REVERSE_MAX_INPUT_BYTES) {
      setError("图片太大：请选择 20 MiB 以内的图片");
      return;
    }
    setError(null);
    setReverseResult(null);
    setReversing(true);
    try {
      const dataUrl = await readFileAsDataUrl(reverseFile);
      const { prompt } = await reverseImagePrompt(dataUrl, reverseStyle);
      if (activityRef.current !== activityId) return;
      if (!prompt.trim()) throw new Error("反推结果为空");
      setReverseResult(prompt);
    } catch (err) {
      if (activityRef.current !== activityId) return;
      setError(`反推失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setReversing(false);
    }
  };

  const copyReverseResult = async (): Promise<void> => {
    if (!reverseResult) return;
    await navigator.clipboard.writeText(reverseResult);
    setReverseCopied(true);
    window.setTimeout(() => setReverseCopied(false), 1500);
  };

  // 反推结果一键回填 Prompt 输入框，接着走普通文生图流程
  const fillReverseResult = (): void => {
    if (!reverseResult) return;
    setPrompt(reverseResult);
    if (undoPrompt !== null) setUndoPrompt(null);
    setMode("generate");
    setError(null);
    window.scrollTo({ top: 0 });
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

  // 分享结果区第 index 张图到广场；服务端幂等，重复分享返回已有分享
  const shareImage = async (index: number): Promise<void> => {
    if (lastGenerationId === null) return;
    setSharingShot(index);
    setError(null);
    try {
      await shareToPlaza(lastGenerationId, index);
      setSharedShots((prev) => ({ ...prev, [index]: true }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSharingShot(null);
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
        if (job.generationId) setLastGenerationId(job.generationId);
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
    setLastGenerationId(null);
    setSharedShots({});
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
    if (mode === "reverse") {
      await runReverse(activityId);
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

  // 选用模板：文生图模板回填 Prompt；图生图模板回填 Prompt 并切到编辑模式（再上传自己的原图）。
  // 官方模板人人可用不可删，自己录入的模板可在弹窗里删除
  const applyTemplate = (template: OfficialTemplate): void => {
    setPrompt(template.prompt);
    if (undoPrompt !== null) setUndoPrompt(null);
    setLibraryOpen(false);
    setError(null);
    if (template.type === "image2image") {
      const editableId = pickEditableModelId(models, model);
      if (modelsLoaded && !editableId) {
        setError(EDIT_NOT_SUPPORTED_MESSAGE);
        return;
      }
      if (editableId && editableId !== model) setModel(editableId);
      setMode("edit");
    } else {
      setMode("generate");
    }
    window.scrollTo({ top: 0 });
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
            <span className="tip" data-tip={!hasEditableModel ? EDIT_NOT_SUPPORTED_MESSAGE : "上传图片，让支持图生图的模型按提示词修改"}>
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
              <span className="tip" data-tip="用 AI 把图片放大 2× 或 4×，提升分辨率">
                <button
                  type="button"
                  className={`btn ${mode === "upscale" ? "primary" : "ghost"}`}
                  aria-pressed={mode === "upscale"}
                  disabled={running}
                  onClick={() => setMode("upscale")}
                >
                  图片超分
                </button>
              </span>
            )}
            {reverseEnabled && (
              <span className="tip" data-tip="由视觉模型从图片反推提示词">
                <button
                  type="button"
                  className={`btn ${mode === "reverse" ? "primary" : "ghost"}`}
                  aria-pressed={mode === "reverse"}
                  disabled={running || reversing}
                  onClick={() => setMode("reverse")}
                >
                  图片反推
                </button>
              </span>
            )}
          </div>

          {mode === "reverse" ? (
            <>
              <label htmlFor="pg-reverse-image">图片（单张 PNG/JPG/WebP）</label>
              <input
                id="pg-reverse-image"
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={(e) => {
                  setReverseFile(e.target.files?.[0] ?? null);
                  setReverseResult(null);
                }}
              />
              {reverseFile && reversePreview && (
                <figure className="edit-preview reverse-preview tip" data-tip={reverseFile.name}>
                  <img src={reversePreview} alt={`待反推图片：${reverseFile.name}`} />
                  <figcaption className="muted">{reverseFile.name}</figcaption>
                </figure>
              )}
              <span className="tip" data-tip="从最近的生成记录中选一张图片来反推">
                <button type="button" className="btn" onClick={() => void openReverseHistory()}>
                  从历史导入
                </button>
              </span>
              {reverseHistoryOpen && (
                <div className="reverse-history" role="group" aria-label="从历史导入图片">
                  {reverseHistoryLoading && <p className="muted">加载历史图片…</p>}
                  {!reverseHistoryLoading && reverseHistoryItems.length === 0 && <p className="muted">暂无可导入的历史图片。</p>}
                  {reverseHistoryItems.map(
                    (item) =>
                      item.images[0] && (
                        <button
                          key={item.id}
                          type="button"
                          className="reverse-history-tile tip"
                          data-tip={item.prompt ? item.prompt.slice(0, 60) : `记录 #${item.id}`}
                          onClick={() => void importReverseImage(item.images[0].url)}
                        >
                          <img src={item.images[0].url} alt="" loading="lazy" />
                        </button>
                      ),
                  )}
                  {!reverseHistoryLoading && reverseHistoryItems.length > 0 && (
                    <button type="button" className="btn small reverse-history-close" onClick={() => setReverseHistoryOpen(false)}>
                      收起
                    </button>
                  )}
                </div>
              )}
              <label>反推类型</label>
              <div className="row" role="group" aria-label="反推类型">
                {REVERSE_STYLE_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={`btn ${reverseStyle === option.value ? "primary" : "ghost"}`}
                    aria-pressed={reverseStyle === option.value}
                    onClick={() => setReverseStyle(option.value)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </>
          ) : mode === "upscale" ? (
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
                <figure className="edit-preview upscale-preview tip" data-tip={upscaleFile.name}>
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
                  <button
                    className="btn small tip"
                    type="button"
                    data-tip="打开模板库，选用文生图 / 图生图模板，或把当前 Prompt 录入为自己的模板"
                    onClick={() => setLibraryOpen(true)}
                    disabled={running}
                  >
                    模板库
                  </button>
                  {undoPrompt !== null && (
                    <button className="btn small tip" type="button" data-tip="回到 AI 优化/翻译前的提示词" onClick={undoEdit} disabled={optimizing || translating}>
                      撤销
                    </button>
                  )}
                  <button
                    className="btn small tip"
                    type="button"
                    data-tip="把当前提示词加入收藏夹"
                    onClick={() => void favorite()}
                    disabled={favoriting || running || !prompt.trim()}
                  >
                    {favoriting ? "收藏中…" : "收藏"}
                  </button>
                  {optimizerEnabled && (
                    <>
                      <button
                        className="btn small tip"
                        type="button"
                        data-tip="在中英之间翻译当前提示词（方向自动判断）"
                        onClick={() => void translate()}
                        disabled={optimizing || translating || running || !prompt.trim()}
                      >
                        {translating ? "翻译中…" : "翻译"}
                      </button>
                      <button
                        className="btn small tip"
                        type="button"
                        data-tip="用 AI 改写当前提示词"
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
                <summary className="muted tip" data-tip="以 JSON 对象透传给上游的附加参数，如 {&quot;seed&quot;:42}">
                  高级参数（JSON，透传上游）
                </summary>
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
                reversing ||
                (mode === "reverse"
                  ? !reverseFile
                  : mode === "upscale"
                    ? !upscaleEnabled || !upscaleFile
                    : !model || !prompt || (mode === "edit" && (!canEdit || editFiles.length === 0)))
              }
            >
              {reversing
                ? "反推中…"
                : running
                  ? runningKind === "upscale"
                    ? "超分中…"
                    : "生成中…"
                  : mode === "edit"
                    ? "编辑"
                    : mode === "upscale"
                      ? "开始超分"
                      : mode === "reverse"
                        ? "开始反推"
                        : "生成"}
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
          <h2>{mode === "reverse" ? "反推结果" : "结果"}</h2>
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
            {reversing && (
              <span className="pill hourglass">
                <span aria-hidden="true" className="hourglass-icon">⌛</span>
                反推中
              </span>
            )}
          </div>
          {mode === "reverse" ? (
            <>
              {reversing && (
                <div className="reverse-loading loading-tile" role="status" aria-label="提示词反推中">
                  <span className="loading-label">正在反推…</span>
                  <span className="w95-progress" aria-hidden="true">
                    <span className="w95-progress-blocks" />
                  </span>
                </div>
              )}
              {!reversing && !reverseResult && (
                <p className="muted">上传或从历史导入一张图片，选择反推类型后点「开始反推」。</p>
              )}
              {!reversing && reverseResult && (
                <div className="reverse-result">
                  <p className="reverse-result-text">{reverseResult}</p>
                  <div className="row reverse-actions">
                    <button className="btn small" type="button" onClick={() => void copyReverseResult()}>
                      {reverseCopied ? "已复制 ✓" : "复制"}
                    </button>
                    <button className="btn small" type="button" onClick={fillReverseResult}>
                      填入 Prompt
                    </button>
                  </div>
                </div>
              )}
            </>
          ) : (
            <>
              {images.length === 0 && !running && (
                <p className="muted">{mode === "upscale" ? "尚无结果。上传一张图片并选择倍率后开始超分。" : "尚无结果。在左侧填写 Prompt 后点「生成」。"}</p>
              )}
              <div className="gallery">
                {images.map((src, i) => (
                  <figure key={i} className="shot">
                    <span className="tip tip-block" data-tip="点击放大查看">
                      <img
                        src={src}
                        alt={prompt ? `生成结果：${prompt.slice(0, 60)}` : `生成结果 ${i + 1}`}
                        onClick={() => setZoomSrc(src)}
                      />
                    </span>
                    <div className="shot-actions">
                      <button
                        className="btn small"
                        type="button"
                        onClick={() =>
                          void downloadImage(src, `tiny-images-${Date.now()}-${i + 1}.png`).catch((err) =>
                            window.alert(`下载失败：${err instanceof Error ? err.message : String(err)}`),
                          )
                        }
                      >
                        下载
                      </button>
                      <button className="btn small" type="button" disabled={!hasEditableModel} onClick={() => void loadIntoEdit(src)}>
                        编辑
                      </button>
                      {upscaleEnabled && (
                        <button className="btn small" type="button" onClick={() => void loadIntoUpscale(src)}>
                          超分
                        </button>
                      )}
                      {lastGenerationId !== null && !running && (
                        <button className="btn small" type="button" disabled={sharingShot === i} onClick={() => void shareImage(i)}>
                          {sharedShots[i] ? "已分享 ✓" : sharingShot === i ? "分享中…" : "分享到广场"}
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
            </>
          )}
        </div>
      </div>
      {zoomSrc && <Lightbox src={zoomSrc} alt="生成结果" onClose={() => setZoomSrc(null)} />}
      {libraryOpen && (
        <TemplateLibrary
          onClose={() => setLibraryOpen(false)}
          onSelect={applyTemplate}
          initialPrompt={prompt}
          // 已生成的图连图录入，没生成就只录文字：生成结果为 after/示例，编辑模式的原图为 before
          capture={{ generated: images[0] ?? null, source: mode === "edit" ? (editPreviews[0] ?? null) : null }}
        />
      )}
    </>
  );
}
