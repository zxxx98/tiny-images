import { type SyntheticEvent, useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, deleteHistoryItem, downloadImage } from "../api";
import Lightbox from "./Lightbox";

interface HistoryImage {
  file: string;
  url: string;
  width?: number;
  height?: number;
  revisedPrompt?: string;
}

interface ImageDimensions {
  width: number;
  height: number;
}

interface HistoryParams {
  operation?: "upscale" | string;
  scale?: number;
  size?: string;
  sourceWidth?: number;
  sourceHeight?: number;
  targetWidth?: number;
  targetHeight?: number;
  [key: string]: unknown;
}

interface HistoryItem {
  id: number;
  createdAt: number;
  model: string;
  prompt: string;
  params?: HistoryParams;
  status: "pending" | "ok" | "error";
  latencyMs: number | null;
  errorMessage: string | null;
  images: HistoryImage[];
}

interface HistoryResponse {
  items: HistoryItem[];
}

const PAGE_SIZE = 30;

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString();
}

export function isUpscaleHistoryItem(item: Pick<HistoryItem, "params">): boolean {
  return item.params?.operation === "upscale";
}

export function historyItemLabel(item: Pick<HistoryItem, "prompt" | "params">): string {
  if (!isUpscaleHistoryItem(item)) return item.prompt;
  return `图片超分 · ${item.params?.scale === 4 ? "4×" : "2×"}`;
}

function formatImageSize(dimensions: Partial<ImageDimensions> | undefined): string | null {
  if (
    typeof dimensions?.width !== "number" ||
    !Number.isInteger(dimensions.width) ||
    dimensions.width <= 0 ||
    typeof dimensions.height !== "number" ||
    !Number.isInteger(dimensions.height) ||
    dimensions.height <= 0
  ) {
    return null;
  }
  return `${dimensions.width}x${dimensions.height}`;
}

export function historyItemSize(
  item: Pick<HistoryItem, "params"> & { images?: Pick<HistoryImage, "width" | "height">[] },
  loadedDimensions?: ImageDimensions,
): string {
  const persistedSize = formatImageSize(item.images?.[0]);
  if (persistedSize) return persistedSize;
  const loadedSize = formatImageSize(loadedDimensions);
  if (loadedSize) return loadedSize;
  const params = item.params;
  const targetWidth = params?.targetWidth;
  const targetHeight = params?.targetHeight;
  if (
    params?.operation === "upscale" &&
    typeof targetWidth === "number" &&
    Number.isInteger(targetWidth) &&
    targetWidth > 0 &&
    typeof targetHeight === "number" &&
    Number.isInteger(targetHeight) &&
    targetHeight > 0
  ) {
    return `${targetWidth}x${targetHeight}`;
  }
  return typeof params?.size === "string" && params.size.length > 0 && params.size !== "auto" ? params.size : "未知";
}

export default function History() {
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<HistoryItem | null>(null);
  const [zoomSrc, setZoomSrc] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [loadedImageSizes, setLoadedImageSizes] = useState<Record<string, ImageDimensions>>({});
  const navigate = useNavigate();

  const load = useCallback(async (before: number | null) => {
    setError(null);
    try {
      const q = before ? `?before=${before}&limit=${PAGE_SIZE}` : `?limit=${PAGE_SIZE}`;
      const r = await api<HistoryResponse>(`/v1/history${q}`);
      setItems((prev) => (before ? [...prev, ...r.items] : r.items));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(null);
  }, [load]);

  const markExpired = (e: { currentTarget: HTMLImageElement }): void => {
    const img = e.currentTarget;
    const div = document.createElement("div");
    div.className = "expired";
    div.textContent = "已过期";
    img.replaceWith(div);
  };

  const rememberImageSize = (key: string, e: SyntheticEvent<HTMLImageElement>): void => {
    const { naturalWidth, naturalHeight } = e.currentTarget;
    if (!formatImageSize({ width: naturalWidth, height: naturalHeight })) return;
    setLoadedImageSizes((prev) => {
      const current = prev[key];
      if (current?.width === naturalWidth && current.height === naturalHeight) return prev;
      return { ...prev, [key]: { width: naturalWidth, height: naturalHeight } };
    });
  };

  const imageSizeKey = (itemId: number, imageIndex: number): string => `${itemId}:${imageIndex}`;

  const rerun = (item: HistoryItem): void => {
    navigate("/", { state: { prompt: item.prompt, model: item.model } });
  };

  const editImage = (url: string): void => {
    navigate("/", { state: { editImageUrl: url } });
  };

  const upscaleImage = (url: string): void => {
    navigate("/", { state: { upscaleImageUrl: url } });
  };

  const reverseImage = (url: string): void => {
    navigate("/", { state: { reverseImageUrl: url } });
  };

  const copyPrompt = async (item: HistoryItem): Promise<void> => {
    await navigator.clipboard.writeText(item.prompt);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  const removeRecord = async (item: HistoryItem): Promise<void> => {
    if (!window.confirm(`确认删除记录 #${item.id}？它包含的图片文件也会一并删除。`)) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteHistoryItem(item.id);
      setItems((prev) => prev.filter((it) => it.id !== item.id));
      setDetail(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeleting(false);
    }
  };

  useEffect(() => {
    if (!detail) return;
    const onKey = (e: KeyboardEvent): void => {
      // 灯箱打开时 Esc 只关灯箱，避免连带关闭详情弹窗。
      if (e.key === "Escape" && !zoomSrc) setDetail(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [detail, zoomSrc]);

  const statusLabel = (item: HistoryItem): string =>
    item.status === "ok" ? "成功" : item.status === "error" ? "失败" : isUpscaleHistoryItem(item) ? "超分中" : "生成中";

  return (
    <div className="card">
      <h2>历史 · 照片墙</h2>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {loading && <p className="muted">加载中…</p>}
      {!loading && items.length === 0 && (
        <p className="muted">
          还没有生成记录。去 <Link to="/">Playground</Link> 生成第一张图吧。
        </p>
      )}
      <div className="history-wall">
        {items.map((item) => {
          const cover = item.images[0];
          const label = historyItemLabel(item);
          const size = historyItemSize(item, loadedImageSizes[imageSizeKey(item.id, 0)]);
          return (
            <button
              key={item.id}
              type="button"
              className="wall-tile"
              onClick={() => {
                setCopied(false);
                setDetail(item);
              }}
              title={label}
            >
              <span className="wall-thumb">
                {cover ? (
                  <img
                    src={cover.url}
                    alt={label}
                    loading="lazy"
                    onLoad={(e) => rememberImageSize(imageSizeKey(item.id, 0), e)}
                    onError={markExpired}
                  />
                ) : (
                  <span className="expired wall-expired">
                    {item.status === "error" ? (isUpscaleHistoryItem(item) ? "超分失败" : "生成失败") : item.status === "pending" ? (isUpscaleHistoryItem(item) ? "超分中…" : "生成中…") : "已过期"}
                  </span>
                )}
                {item.images.length > 1 && <span className="wall-count">×{item.images.length}</span>}
                {item.status === "error" && <span className="wall-flag">失败</span>}
              </span>
              <span className="wall-caption">{label}</span>
              <span className="wall-size muted">尺寸: {size}</span>
            </button>
          );
        })}
      </div>
      {items.length > 0 && items.length % PAGE_SIZE === 0 && (
        <button className="btn" onClick={() => void load(items[items.length - 1].id)}>
          加载更多
        </button>
      )}
      {detail && (
        <div className="detail-overlay" role="dialog" aria-modal="true" onClick={() => setDetail(null)}>
          <div className="win-window" onClick={(e) => e.stopPropagation()}>
            <div className="titlebar">
              <span className="brand">记录 #{detail.id}</span>
              <span className="win-buttons">
                <span onClick={() => setDetail(null)}>×</span>
              </span>
            </div>
            <div className="win-body">
              <div className="detail-gallery">
                {detail.images.map((img, i) => (
                  <figure key={i} className="shot">
                    <span className="tip tip-block" data-tip="点击放大查看">
                      <img
                        src={img.url}
                        alt={`历史图片 ${i + 1}`}
                        loading="lazy"
                        onClick={(e) => {
                          // 阻止冒泡到详情遮罩，避免点击图片时连带关闭详情。
                          e.stopPropagation();
                          setZoomSrc(img.url);
                        }}
                        onLoad={(e) => rememberImageSize(imageSizeKey(detail.id, i), e)}
                        onError={markExpired}
                      />
                    </span>
                    <div className="shot-actions">
                      <button className="btn small" onClick={() => editImage(img.url)}>
                        编辑此图
                      </button>
                      <button className="btn small" onClick={() => upscaleImage(img.url)}>
                        超分
                      </button>
                      <button className="btn small" onClick={() => reverseImage(img.url)}>
                        反推
                      </button>
                      <button
                        className="btn small"
                        onClick={() =>
                          void downloadImage(img.url, `tiny-images-${detail.id}-${i + 1}.png`).catch((err) =>
                            window.alert(`下载失败：${err instanceof Error ? err.message : String(err)}`),
                          )
                        }
                      >
                        下载
                      </button>
                    </div>
                  </figure>
                ))}
                {detail.status === "ok" && detail.images.length === 0 && <span className="expired">已过期</span>}
                {detail.status === "error" && detail.errorMessage && <p className="error">{detail.errorMessage}</p>}
              </div>
              <div className="detail-info">
                <div className="history-meta">
                  <span className="pill">{fmtTime(detail.createdAt)}</span>
                  <span className="pill">{historyItemLabel(detail)}</span>
                  <span className="pill">尺寸: {historyItemSize(detail, loadedImageSizes[imageSizeKey(detail.id, 0)])}</span>
                  {!isUpscaleHistoryItem(detail) && <span className="pill">{detail.model}</span>}
                  <span className={`pill ${detail.status === "ok" ? "" : detail.status === "error" ? "error" : "off"}`}>
                    {statusLabel(detail)}
                  </span>
                  {detail.latencyMs !== null && <span className="pill">{detail.latencyMs} ms</span>}
                </div>
                {!isUpscaleHistoryItem(detail) && (
                  <>
                    <h3>Prompt</h3>
                    <p className="detail-prompt">{detail.prompt}</p>
                    {detail.images.some((img) => img.revisedPrompt) && (
                      <>
                        <h3>Revised Prompt</h3>
                        {detail.images
                          .filter((img) => img.revisedPrompt)
                          .map((img, i) => (
                            <p key={i} className="detail-prompt">
                              {img.revisedPrompt}
                            </p>
                          ))}
                      </>
                    )}
                  </>
                )}
                <div className="history-actions">
                  {!isUpscaleHistoryItem(detail) && (
                    <>
                      <button className="btn small" onClick={() => void copyPrompt(detail)}>
                        {copied ? "已复制 ✓" : "复制 Prompt"}
                      </button>
                      <button className="btn small" onClick={() => rerun(detail)}>
                        用此 Prompt 重新生成
                      </button>
                    </>
                  )}
                  <span className="tip tip-end" data-tip="删除记录及其图片文件">
                    <button className="btn small danger" disabled={deleting} onClick={() => void removeRecord(detail)}>
                      {deleting ? "删除中…" : "删除记录"}
                    </button>
                  </span>
                  <button className="btn small danger" onClick={() => setDetail(null)}>
                    关闭
                  </button>
                </div>
              </div>
            </div>
          </div>
          {zoomSrc && <Lightbox src={zoomSrc} alt="历史图片" onClose={() => setZoomSrc(null)} />}
        </div>
      )}
    </div>
  );
}
