import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api";

interface HistoryImage {
  file: string;
  url: string;
  revisedPrompt?: string;
}

interface HistoryItem {
  id: number;
  createdAt: number;
  model: string;
  prompt: string;
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

export default function History() {
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<HistoryItem | null>(null);
  const [copied, setCopied] = useState(false);
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

  const rerun = (item: HistoryItem): void => {
    navigate("/", { state: { prompt: item.prompt, model: item.model } });
  };

  // 把历史图片带入 Playground 的编辑模式
  const editImage = (url: string): void => {
    navigate("/", { state: { editImageUrl: url } });
  };

  const copyPrompt = async (item: HistoryItem): Promise<void> => {
    await navigator.clipboard.writeText(item.prompt);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  useEffect(() => {
    if (!detail) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setDetail(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [detail]);

  const statusLabel = (item: HistoryItem): string =>
    item.status === "ok" ? "成功" : item.status === "error" ? "失败" : "生成中";

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
          return (
            <button
              key={item.id}
              type="button"
              className="wall-tile"
              onClick={() => {
                setCopied(false);
                setDetail(item);
              }}
              title={item.prompt}
            >
              <span className="wall-thumb">
                {cover ? (
                  <img src={cover.url} alt={item.prompt} loading="lazy" onError={markExpired} />
                ) : (
                  <span className="expired wall-expired">
                    {item.status === "error" ? "生成失败" : item.status === "pending" ? "生成中…" : "已过期"}
                  </span>
                )}
                {item.images.length > 1 && <span className="wall-count">×{item.images.length}</span>}
                {item.status === "error" && <span className="wall-flag">失败</span>}
              </span>
              <span className="wall-caption">{item.prompt}</span>
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
                    <img
                      src={img.url}
                      alt={`历史图片 ${i + 1}`}
                      loading="lazy"
                      title="点击进入图片编辑"
                      onClick={() => editImage(img.url)}
                      onError={markExpired}
                    />
                    <div className="shot-actions">
                      <button className="btn small" onClick={() => editImage(img.url)}>
                        编辑此图
                      </button>
                      <a className="btn small" href={img.url} download={`tiny-images-${detail.id}-${i + 1}.png`}>
                        下载
                      </a>
                    </div>
                  </figure>
                ))}
                {detail.status === "ok" && detail.images.length === 0 && <span className="expired">已过期</span>}
                {detail.status === "error" && detail.errorMessage && <p className="error">{detail.errorMessage}</p>}
              </div>
              <div className="detail-info">
                <div className="history-meta">
                  <span className="pill">{fmtTime(detail.createdAt)}</span>
                  <span className="pill">{detail.model}</span>
                  <span className={`pill ${detail.status === "ok" ? "" : detail.status === "error" ? "error" : "off"}`}>
                    {statusLabel(detail)}
                  </span>
                  {detail.latencyMs !== null && <span className="pill">{detail.latencyMs} ms</span>}
                </div>
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
                <div className="history-actions">
                  <button className="btn small" onClick={() => void copyPrompt(detail)}>
                    {copied ? "已复制 ✓" : "复制 Prompt"}
                  </button>
                  <button className="btn small" onClick={() => rerun(detail)}>
                    用此 Prompt 重新生成
                  </button>
                  <button className="btn small danger" onClick={() => setDetail(null)}>
                    关闭
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
