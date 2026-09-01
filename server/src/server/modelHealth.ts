import type { ModelRouter } from "../core/router.js";
import type { ChannelRow, LogRow, ModelRow, Repo } from "../store/repo.js";

export const MODEL_HEALTH_SAMPLE_LIMIT = 50;
const RECENT_LIMIT = 10;

export type ModelHealthStatus = "healthy" | "degraded" | "unavailable" | "unknown";

export interface ModelHealthView {
  model: string;
  status: ModelHealthStatus;
  supportsImageToImage: boolean;
  routes: {
    total: number;
    available: number;
  };
  requests: {
    sampleSize: number;
    successful: number;
    failed: number;
    successRate: number | null;
    averageLatencyMs: number | null;
    lastRequestAt: number | null;
  };
  recent: Array<{
    ts: number;
    status: "ok" | "error";
    latencyMs: number | null;
  }>;
}

interface ModelHealthInput {
  mappings: ModelRow[];
  channels: ChannelRow[];
  logs: LogRow[];
  now: number;
  availableKeyCount: (channelId: number, now: number) => number;
  channelHealth: (channelId: number) => { coolingDown: boolean };
}

export function aggregateModelHealth(input: ModelHealthInput): ModelHealthView[] {
  const channels = new Map(input.channels.map((channel) => [channel.id, channel]));
  const mappingsByModel = new Map<string, ModelRow[]>();
  for (const mapping of input.mappings) {
    const mappings = mappingsByModel.get(mapping.publicName) ?? [];
    mappings.push(mapping);
    mappingsByModel.set(mapping.publicName, mappings);
  }

  return [...mappingsByModel.entries()].map(([model, mappings]) => {
    const routeState = mappings.map((mapping) => {
      const channel = channels.get(mapping.channelId);
      const circuitOpen = input.channelHealth(mapping.channelId).coolingDown;
      const eligible = !!channel?.enabled && input.availableKeyCount(mapping.channelId, input.now) > 0;
      return { mapping, circuitOpen, eligible };
    });
    const eligibleRoutes = routeState.filter((route) => route.eligible);
    const routableWithoutFallback = eligibleRoutes.filter((route) => !route.circuitOpen);
    const availableRoutes = routableWithoutFallback.length > 0 ? routableWithoutFallback.length : eligibleRoutes.length;
    const servingPool = routableWithoutFallback.length > 0 ? routableWithoutFallback : eligibleRoutes;
    const servingPriority = servingPool.length === 0
      ? null
      : Math.min(...servingPool.map((route) => route.mapping.priority));
    const servingRoutes = servingPriority === null
      ? []
      : routeState.filter((route) => route.eligible && route.mapping.priority === servingPriority);
    const servingChannelIds = new Set(servingRoutes.map((route) => route.mapping.channelId));
    const servingDegraded = servingRoutes.some((route) => route.circuitOpen);

    const modelLogs = input.logs.filter(
      (log) => log.model === model && log.channelId !== null && servingChannelIds.has(log.channelId),
    );
    const successful = modelLogs.filter((log) => log.status === "ok").length;
    const failed = modelLogs.length - successful;
    const latencies = modelLogs.flatMap((log) => (log.latencyMs === null ? [] : [log.latencyMs]));

    let status: ModelHealthStatus;
    if (eligibleRoutes.length === 0) status = "unavailable";
    else if (servingDegraded || failed > 0) status = "degraded";
    else if (modelLogs.length === 0) status = "unknown";
    else status = "healthy";

    return {
      model,
      status,
      supportsImageToImage: mappings.some((mapping) => mapping.supportsImageToImage),
      routes: {
        total: mappings.length,
        available: availableRoutes,
      },
      requests: {
        sampleSize: modelLogs.length,
        successful,
        failed,
        successRate: modelLogs.length === 0 ? null : successful / modelLogs.length,
        averageLatencyMs:
          latencies.length === 0
            ? null
            : Math.round(latencies.reduce((sum, latency) => sum + latency, 0) / latencies.length),
        lastRequestAt: modelLogs[0]?.ts ?? null,
      },
      recent: modelLogs.slice(0, RECENT_LIMIT).map((log) => ({
        ts: log.ts,
        status: log.status,
        latencyMs: log.latencyMs,
      })),
    };
  });
}

export function buildModelHealth(
  repo: Repo,
  router: ModelRouter,
  allowedChannelIds: number[] | null,
  now = Date.now(),
): { generatedAt: number; sampleLimit: number; models: ModelHealthView[] } {
  const allowed = allowedChannelIds === null ? null : new Set(allowedChannelIds);
  const mappings = repo
    .listEnabledModels()
    .filter((mapping) => allowed === null || allowed.has(mapping.channelId));
  const visibleChannelIds = new Set(mappings.map((mapping) => mapping.channelId));
  const channels = repo.listChannels().filter((channel) => visibleChannelIds.has(channel.id));
  const logs = repo
    .recentLogs(MODEL_HEALTH_SAMPLE_LIMIT)
    .filter((log) => log.channelId !== null && visibleChannelIds.has(log.channelId));

  return {
    generatedAt: now,
    sampleLimit: MODEL_HEALTH_SAMPLE_LIMIT,
    models: aggregateModelHealth({
      mappings,
      channels,
      logs,
      now,
      availableKeyCount: (channelId, at) =>
        repo.enabledKeys(channelId).filter((key) => key.cooldownUntil <= at).length,
      channelHealth: (channelId) => router.health(channelId),
    }),
  };
}
