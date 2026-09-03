import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { deletePlazaShare, fetchPlaza, type PlazaItem } from "../api";
import Lightbox from "./Lightbox";

const PAGE_SIZE = 30;

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString();
}

function fmtSize(item: Pick<PlazaItem, "width" | "height">): string {
  return typeof item.width === "number" && item.width > 0 && typeof item.height === "number" && item.height > 0
    ? `${item.width}x${item.height}`
    : "未知";
}

export default function Plaza() {
  const [items, setItems] = useState<PlazaItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mineOnly, setMineOnly] = useState(false);
  const [detail, setDetail] = useState<PlazaItem | null>(null);
  const [zoomSrc, setZoomSrc] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const navigate = useNavigate();

  const load = useCallback(
    async (before: number | null, mine: boolean) => {
      setError(null);
      try {
        const r = await fetchPlaza({ before: before ?? undefined, mine });
        setItems((prev) => (before ? [...prev, ...r.items] : r.items));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    setLoading(true);
    void load(null, mineOnly);
  }, [load, mineOnly]);

  // 切换视图时收起详情，避免残留已不在列表中的分享
  useEffect(() => {
    setDetail(null);
    setZoomSrc(null);
  }, [mineOnly]);

  const removeShare = async (item: PlazaItem): Promise<void> => {
    if (!window.confirm(`确认取消分享 #${item.id}？广场上的这张图片会被移除。`)) return;
    setDeleting(true);
    setError(null);
    try {
      await deletePlazaShare(item.id);
      setItems((prev) => prev.filter((it) => it.id !== item.id));
      setDetail(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeleting(false);
    }
  };

  const copyPrompt = async (item: PlazaItem): Promise<void> => {
    await navigator.clipboard.writeText(item.prompt);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  const rerun = (item: PlazaItem): void => {
    navigate("/", { state: { prompt: item.prompt, ...(item.model ? { model: item.model } : {}) } });
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

  return (
    <div className="card">
      <h2>广场 · 照片墙</h2>
      <div className="plaza-toolbar">
        <div className="plaza-tabs">
          <button className={`btn small ${mineOnly ? "" : "primary"}`} onClick={() => setMineOnly(false)}>
            最新分享
          </button>
          <button className={`btn small ${mineOnly ? "primary" : ""}`} onClick={() => setMineOnly(true)}>
            我的分享
          </button>
        </div>
        <span className="muted">大家生成的图分享到这里，所有人都能看到</span>
      </div>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {loading && <p className="muted">加载中…</p>}
      {!loading && items.length === 0 && (
        <p className="muted">
          {mineOnly ? (
            "你还没有分享过图片。去历史记录或生成结果里点「分享」试试。"
          ) : (
            <>
              广场还空着。去 <Link to="/">Playground</Link> 生成第一张图并分享吧。
            </>
          )}
        </p>
      )}
      <div className="plaza-wall">
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            className="plaza-tile"
            onClick={() => {
              setCopied(false);
              setDetail(item);
            }}
            title={item.prompt}
          >
            <img
              src={item.url}
              alt={item.prompt}
              loading="lazy"
              onError={(e) => {
                const img = e.currentTarget;
                const div = document.createElement("div");
                div.className = "expired";
                div.textContent = "图片加载失败";
                img.replaceWith(div);
              }}
            />
            <span className="plaza-tile-info">
              <span className="plaza-tile-author">{item.author ?? "匿名"}</span>
              <span className="plaza-tile-time">{fmtTime(item.createdAt)}</span>
            </span>
          </button>
        ))}
      </div>
      {items.length > 0 && items.length % PAGE_SIZE === 0 && (
        <button className="btn" onClick={() => void load(items[items.length - 1].id, mineOnly)}>
          加载更多
        </button>
      )}
      {detail && (
        <div className="detail-overlay" role="dialog" aria-modal="true" onClick={() => setDetail(null)}>
          <div className="win-window" onClick={(e) => e.stopPropagation()}>
            <div className="titlebar">
              <span className="brand">广场分享 #{detail.id}</span>
              <span className="win-buttons">
                <span onClick={() => setDetail(null)}>×</span>
              </span>
            </div>
            <div className="win-body">
              <div className="detail-gallery">
                <figure className="shot">
                  <span className="tip tip-block" data-tip="点击放大查看">
                    <img
                      src={detail.url}
                      alt={detail.prompt}
                      onClick={(e) => {
                        e.stopPropagation();
                        setZoomSrc(detail.url);
                      }}
                    />
                  </span>
                  <div className="shot-actions">
                    <a className="btn small" href={detail.url} download={`tiny-images-plaza-${detail.id}.png`}>
                      下载
                    </a>
                  </div>
                </figure>
              </div>
              <div className="detail-info">
                <div className="history-meta">
                  <span className="pill">{fmtTime(detail.createdAt)}</span>
                  <span className="pill" title={detail.author ?? undefined}>
                    {detail.author ?? "匿名"}
                  </span>
                  {detail.model && <span className="pill">{detail.model}</span>}
                  <span className="pill">尺寸: {fmtSize(detail)}</span>
                </div>
                <h3>Prompt</h3>
                <p className="detail-prompt">{detail.prompt || "(无)"}</p>
                {detail.revisedPrompt && (
                  <>
                    <h3>Revised Prompt</h3>
                    <p className="detail-prompt">{detail.revisedPrompt}</p>
                  </>
                )}
                <div className="history-actions">
                  <button className="btn small" onClick={() => void copyPrompt(detail)}>
                    {copied ? "已复制 ✓" : "复制 Prompt"}
                  </button>
                  <button className="btn small" onClick={() => rerun(detail)}>
                    用此 Prompt 生成
                  </button>
                  {detail.canDelete && (
                    <span className="tip tip-end" data-tip="从广场移除这张图片">
                      <button className="btn small danger" disabled={deleting} onClick={() => void removeShare(detail)}>
                        {deleting ? "移除中…" : "取消分享"}
                      </button>
                    </span>
                  )}
                  <button className="btn small danger" onClick={() => setDetail(null)}>
                    关闭
                  </button>
                </div>
              </div>
            </div>
          </div>
          {zoomSrc && <Lightbox src={zoomSrc} alt="广场图片" onClose={() => setZoomSrc(null)} />}
        </div>
      )}
    </div>
  );
}
