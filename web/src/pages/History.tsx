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
  const [preview, setPreview] = useState<{ src: string; prompt: string } | null>(null);
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

  return (
    <div className="card">
      <h2>历史</h2>
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
      <div className="history-list">
        {items.map((item) => (
          <div key={item.id} className="history-item">
            <div className="history-meta">
              <span className="pill">{fmtTime(item.createdAt)}</span>
              <span className="pill">{item.model}</span>
              <span className={`pill ${item.status === "ok" ? "" : item.status === "error" ? "error" : "off"}`}>{item.status}</span>
              {item.latencyMs !== null && <span className="pill">{item.latencyMs} ms</span>}
            </div>
            <p className="history-prompt" title={item.prompt}>
              {item.prompt}
            </p>
            {item.status === "error" && <p className="error">{item.errorMessage}</p>}
            <div className="gallery">
              {item.images.map((img, i) => (
                <figure key={i} className="shot">
                  <img
                    src={img.url}
                    alt={`历史图片 ${i + 1}`}
                    loading="lazy"
                    onError={markExpired}
                    onClick={() => setPreview({ src: img.url, prompt: item.prompt })}
                  />
                  <a className="btn small" href={img.url} download={`tiny-images-${item.id}-${i + 1}.png`}>
                    下载
                  </a>
                </figure>
              ))}
              {item.status === "ok" && item.images.length === 0 && <span className="expired">已过期</span>}
            </div>
            <div className="history-actions">
              <button className="btn small" onClick={() => void navigator.clipboard.writeText(item.prompt)}>
                复制 Prompt
              </button>
              <button className="btn small" onClick={() => rerun(item)}>
                用此 Prompt 重新生成
              </button>
            </div>
          </div>
        ))}
      </div>
      {items.length > 0 && items.length % PAGE_SIZE === 0 && (
        <button className="btn" onClick={() => void load(items[items.length - 1].id)}>
          加载更多
        </button>
      )}
      {preview && (
        <div className="lightbox" role="dialog" onClick={() => setPreview(null)}>
          <img src={preview.src} alt={preview.prompt} />
          <p className="mono">{preview.prompt}</p>
        </div>
      )}
    </div>
  );
}
