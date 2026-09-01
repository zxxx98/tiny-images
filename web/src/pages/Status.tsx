import { useCallback, useEffect, useRef, useState } from "react";
import { fetchModelHealth, type ModelHealth, type ModelHealthResponse, type ModelHealthStatus } from "../api";

const REFRESH_INTERVAL_MS = 5_000;
const PROBE_LIMIT = 10;

const STATUS_META: Record<ModelHealthStatus, { label: string; symbol: string }> = {
  healthy: { label: "正常", symbol: "✓" },
  degraded: { label: "波动", symbol: "!" },
  unavailable: { label: "不可用", symbol: "×" },
  unknown: { label: "暂无样本", symbol: "?" },
};

function statusMeta(status: string): { label: string; symbol: string } {
  return STATUS_META[status as ModelHealthStatus] ?? { label: `未知状态（${status || "未提供"}）`, symbol: "?" };
}

function formatRate(rate: number | null): string {
  if (rate === null) return "暂无";
  return `${(rate * 100).toFixed(1).replace(/\.0$/, "")}%`;
}

function formatLatency(latencyMs: number | null): string {
  return latencyMs === null ? "暂无" : `${Math.round(latencyMs)} ms`;
}

function formatTime(ts: number | null): string {
  if (ts === null) return "暂无";
  const date = new Date(ts);
  return Number.isNaN(date.getTime()) ? "时间未知" : date.toLocaleString();
}

function ProbeStrip({ model }: { model: ModelHealth }) {
  const recent = model.recent.slice(0, PROBE_LIMIT).reverse();
  const slots = [
    ...Array.from({ length: PROBE_LIMIT - recent.length }, () => null),
    ...recent,
  ];
  const summary = recent.length === 0
    ? "最近没有调用样本"
    : `最近 ${recent.length} 次调用：${recent.map((sample) => (sample.status === "ok" ? "成功" : "失败")).join("、")}`;

  return (
    <div className="probe-wrap">
      <span className="probe-label">近期探针</span>
      <div className="probe-strip" role="img" aria-label={summary}>
        {slots.map((sample, index) => {
          if (!sample) {
            return (
              <span key={`empty-${index}`} className="probe-cell empty" aria-hidden="true" title="无样本">
                ·
              </span>
            );
          }
          const successful = sample.status === "ok";
          const detail = `${formatTime(sample.ts)}：${successful ? "成功" : "失败"}${sample.latencyMs === null ? "" : `，${Math.round(sample.latencyMs)} ms`}`;
          return (
            <span
              key={`${sample.ts}-${index}`}
              className={`probe-cell ${successful ? "success" : "failure"}`}
              aria-hidden="true"
              title={detail}
            >
              {successful ? "✓" : "×"}
            </span>
          );
        })}
      </div>
      <span className="probe-key muted" aria-hidden="true">✓ 成功　× 失败　· 无样本</span>
    </div>
  );
}

function ModelProbe({ model }: { model: ModelHealth }) {
  const status = String(model.status);
  const meta = statusMeta(status);

  return (
    <article className={`model-probe status-${STATUS_META[status as ModelHealthStatus] ? status : "unknown"}`}>
      <header className="model-probe-head">
        <h3 className="mono" title={model.model}>{model.model}</h3>
        <span className={`status-badge status-${STATUS_META[status as ModelHealthStatus] ? status : "unknown"}`}>
          <span aria-hidden="true">{meta.symbol}</span> {meta.label}
        </span>
      </header>
      <div className="model-capabilities" aria-label="模型能力">
        <span className="pill">文生图</span>
        <span className={`pill ${model.supportsImageToImage ? "" : "off"}`}>
          {model.supportsImageToImage ? "图生图" : "不支持图生图"}
        </span>
      </div>
      <dl className="model-metrics">
        <div><dt>成功率</dt><dd>{formatRate(model.requests.successRate)}</dd></div>
        <div><dt>平均延迟</dt><dd>{formatLatency(model.requests.averageLatencyMs)}</dd></div>
        <div><dt>样本数</dt><dd>{model.requests.sampleSize}</dd></div>
        <div><dt>最近时间</dt><dd>{formatTime(model.requests.lastRequestAt)}</dd></div>
        <div><dt>线路</dt><dd>{model.routes.available} / {model.routes.total} 可用</dd></div>
      </dl>
      <ProbeStrip model={model} />
    </article>
  );
}

export default function Status() {
  const [data, setData] = useState<ModelHealthResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(false);
  const dataRef = useRef<ModelHealthResponse | null>(null);
  const requestInFlightRef = useRef(false);

  const load = useCallback(async (): Promise<void> => {
    if (requestInFlightRef.current) return;
    requestInFlightRef.current = true;
    if (dataRef.current) setRefreshing(true);
    setError(null);
    try {
      const next = await fetchModelHealth();
      if (!mountedRef.current) return;
      dataRef.current = next;
      setData(next);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      requestInFlightRef.current = false;
      if (mountedRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    let timer: number | undefined;

    const clearTimer = (): void => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = undefined;
    };
    const schedule = (): void => {
      clearTimer();
      if (document.visibilityState === "hidden") return;
      timer = window.setTimeout(() => {
        void load().finally(schedule);
      }, REFRESH_INTERVAL_MS);
    };
    const handleVisibilityChange = (): void => {
      if (document.visibilityState === "hidden") {
        clearTimer();
        return;
      }
      void load().finally(schedule);
    };

    void load().finally(schedule);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      mountedRef.current = false;
      clearTimer();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [load]);

  const counts = data?.models.reduce(
    (result, model) => {
      const status = String(model.status);
      if (status === "healthy" || status === "degraded" || status === "unavailable") result[status] += 1;
      else result.unknown += 1;
      return result;
    },
    { healthy: 0, degraded: 0, unavailable: 0, unknown: 0 },
  );

  return (
    <div className="status-page">
      <section className="card status-heading">
        <h2>模型网络探针</h2>
        <div className="status-toolbar">
          <div>
            <p className="status-intro">近期真实调用健康度，不会主动向上游发送测试请求。</p>
            <p className="muted status-note">
              数据来自系统最近 {data?.sampleLimit ?? 50} 条真实调用；5 秒自动刷新，标签页隐藏时暂停。
            </p>
            <p className="mono status-updated" aria-live="polite">
              最后更新：{data ? formatTime(data.generatedAt) : "尚未获取"}
            </p>
          </div>
          <button className="btn" type="button" onClick={() => void load()} disabled={loading || refreshing}>
            {loading ? "正在加载…" : refreshing ? "正在刷新…" : "手动刷新"}
          </button>
        </div>
      </section>

      {error && (
        <div className="error" role="alert">
          {data ? `刷新失败，继续显示上次数据：${error}` : `模型状态加载失败：${error}`}
        </div>
      )}

      {loading && !data && (
        <section className="card status-message" aria-live="polite">
          <h2>连接探针</h2>
          <p><span className="hourglass-icon" aria-hidden="true">⌛</span> 正在读取近期真实调用数据…</p>
        </section>
      )}

      {!loading && !data && (
        <section className="card status-message">
          <h2>暂时无法显示</h2>
          <p>没有可显示的模型状态。请稍后自动刷新，或点击“手动刷新”重试。</p>
        </section>
      )}

      {data && (
        <>
          <section className="health-overview status-overview" aria-label="模型状态总览">
            <strong>总览</strong>
            <span className="pill">模型总数 {data.models.length}</span>
            <span className="pill status-healthy"><span aria-hidden="true">✓</span> 正常 {counts?.healthy ?? 0}</span>
            <span className="pill status-degraded"><span aria-hidden="true">!</span> 波动 {counts?.degraded ?? 0}</span>
            <span className="pill status-unavailable"><span aria-hidden="true">×</span> 不可用 {counts?.unavailable ?? 0}</span>
            <span className="pill status-unknown"><span aria-hidden="true">?</span> 暂无样本 {counts?.unknown ?? 0}</span>
          </section>

          {data.models.length === 0 ? (
            <section className="card status-message">
              <h2>没有可用模型</h2>
              <p>当前账号没有获配模型，请联系管理员检查模型与渠道分组配置。</p>
            </section>
          ) : (
            <section className="model-probe-list" aria-label="每个模型的网络探针">
              {data.models.map((model) => <ModelProbe key={model.model} model={model} />)}
            </section>
          )}
        </>
      )}
    </div>
  );
}
