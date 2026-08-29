import { FormEvent, useEffect, useState } from "react";
import { api, getToken } from "../api";

interface ModelsResponse {
  data: { id: string }[];
}

interface GenResult {
  created: number;
  data: { b64_json?: string; url?: string; revised_prompt?: string }[];
  usage?: unknown;
}

function imageUrl(item: { b64_json?: string; url?: string }): string | null {
  if (item.b64_json) return `data:image/png;base64,${item.b64_json}`;
  if (item.url) return item.url;
  return null;
}

export default function Playground() {
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState("");
  const [prompt, setPrompt] = useState("");
  const [n, setN] = useState(1);
  const [size, setSize] = useState("auto");
  const [responseFormat, setResponseFormat] = useState("");
  const [stream, setStream] = useState(false);
  const [extra, setExtra] = useState("{}");
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [channel, setChannel] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [images, setImages] = useState<string[]>([]);

  useEffect(() => {
    api<ModelsResponse>("/v1/models")
      .then((r) => {
        setModels(r.data.map((m) => m.id));
        if (r.data.length > 0) setModel(r.data[0].id);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const buildPayload = (): Record<string, unknown> | null => {
    const payload: Record<string, unknown> = { model, prompt, n, stream };
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

  const run = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setImages([]);
    setChannel(null);
    setStatus(null);
    setElapsed(null);
    const payload = buildPayload();
    if (!payload) return;
    const started = Date.now();
    setRunning(true);
    try {
      if (stream) {
        await runStream(payload, started);
      } else {
        await runSync(payload, started);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  const handleResponse = (res: Response, started: number): Promise<void> => {
    setElapsed(Date.now() - started);
    setChannel(res.headers.get("x-tiny-channel"));
    if (!res.ok) {
      return res
        .json()
        .catch(() => ({}))
        .then((body: { error?: { message?: string } }) => {
          throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
        });
    }
    return res.json().then((body: GenResult) => {
      setImages(body.data.map(imageUrl).filter((v): v is string => !!v));
    });
  };

  const runSync = async (payload: Record<string, unknown>, started: number): Promise<void> => {
    const res = await fetch("/v1/images/generations", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${getToken()}` },
      body: JSON.stringify(payload),
    });
    await handleResponse(res, started);
  };

  const runStream = async (payload: Record<string, unknown>, started: number): Promise<void> => {
    const res = await fetch("/v1/images/generations", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${getToken()}` },
      body: JSON.stringify(payload),
    });
    if (!res.ok || !res.body) {
      await handleResponse(res, started);
      return;
    }
    setChannel(res.headers.get("x-tiny-channel"));
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const collected: string[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const frames = buf.split("\n\n");
      buf = frames.pop() ?? "";
      for (const frame of frames) {
        if (!frame.startsWith("data: ")) continue;
        const data = frame.slice(6);
        if (data === "[DONE]") continue;
        let ev: { type: string; message?: string; error?: { message?: string }; b64_json?: string; url?: string };
        try {
          ev = JSON.parse(data);
        } catch {
          continue;
        }
        if (ev.type === "image") {
          const src = ev.b64_json ? `data:image/png;base64,${ev.b64_json}` : (ev.url ?? null);
          if (src) {
            collected.push(src);
            setImages([...collected]);
          }
        } else if (ev.type === "progress") {
          setStatus(ev.message ?? "生成中…");
        } else if (ev.type === "error") {
          throw new Error(ev.error?.message ?? "上游错误");
        }
      }
    }
    setElapsed(Date.now() - started);
  };

  return (
    <div className="two-col">
      <form className="card" onSubmit={run}>
        <h2>Playground</h2>
        <label>模型</label>
        {models.length === 0 ? (
          <p className="muted">没有可用模型，请先在管理后台配置渠道与映射。</p>
        ) : (
          <select value={model} onChange={(e) => setModel(e.target.value)}>
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        )}
        <label>Prompt</label>
        <textarea rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="描述你想生成的图片…" required />
        <div className="row">
          <div>
            <label>数量 n</label>
            <input type="number" min={1} max={10} value={n} onChange={(e) => setN(Number(e.target.value))} />
          </div>
          <div>
            <label>尺寸</label>
            <input value={size} onChange={(e) => setSize(e.target.value)} placeholder="auto / 1024x1024" />
          </div>
        </div>
        <label>response_format</label>
        <select value={responseFormat} onChange={(e) => setResponseFormat(e.target.value)}>
          <option value="">跟随上游</option>
          <option value="url">url</option>
          <option value="b64_json">b64_json</option>
        </select>
        <label className="check">
          <input type="checkbox" checked={stream} onChange={(e) => setStream(e.target.checked)} /> 流式（SSE）
        </label>
        <details>
          <summary className="muted">高级参数（JSON，透传上游）</summary>
          <textarea rows={3} value={extra} onChange={(e) => setExtra(e.target.value)} spellCheck={false} />
        </details>
        <button className="btn primary" type="submit" disabled={running || !model || !prompt}>
          {running ? "生成中…" : "生成"}
        </button>
        {error && <div className="error">{error}</div>}
      </form>

      <div className="card">
        <h2>结果</h2>
        <div className="meta">
          {channel && <span className="pill">渠道: {channel}</span>}
          {elapsed !== null && <span className="pill">{elapsed} ms</span>}
          {status && !running && <span className="pill">{status}</span>}
          {running && <span className="pill pulse">生成中…</span>}
        </div>
        {images.length === 0 && !running && <p className="muted">尚无结果</p>}
        <div className="gallery">
          {images.map((src, i) => (
            <img key={i} src={src} alt={`result-${i}`} />
          ))}
        </div>
      </div>
    </div>
  );
}
