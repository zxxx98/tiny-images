import type { ChannelRow, ModelRow, Repo } from "../store/repo.js";

export interface ResolvedRoute {
  model: ModelRow;
  channel: ChannelRow;
}

export interface ChannelHealthSnapshot {
  failureCount: number;
  coolingDown: boolean;
  cooldownUntil: number | null;
}

export interface RouterOptions {
  /** 连续失败多少次后打开熔断 */
  failureThreshold?: number;
  /** 熔断时长（毫秒） */
  cooldownMs?: number;
}

/**
 * 模型路由：不同 priority 按优先级故障转移，同一 priority 内按映射轮询；
 * 渠道连续失败达到阈值后进入内存熔断（冷却期内跳过，全部冷却中则兜底尝试）。
 */
export class ModelRouter {
  private failures = new Map<number, number>();
  private cooldowns = new Map<number, number>();
  private roundRobin = new Map<string, number>();

  constructor(
    private readonly repo: Repo,
    private readonly opts: RouterOptions = {},
  ) {}

  resolve(publicName: string, allowedChannelIds?: number[] | null): ResolvedRoute | null {
    const candidates = this.repo.listEnabledModelRoutes(publicName);
    if (candidates.length === 0) return null;
    const allowed = (m: ModelRow): boolean => !allowedChannelIds || (allowedChannelIds.length > 0 && allowedChannelIds.includes(m.channelId));
    const groups = new Map<number, ModelRow[]>();
    for (const model of candidates) {
      const group = groups.get(model.priority) ?? [];
      group.push(model);
      groups.set(model.priority, group);
    }

    const pickGroup = (priority: number, models: ModelRow[], respectCooldown: boolean): ResolvedRoute | null => {
      const valid = models.filter((model) => {
        if (!allowed(model)) return false;
        if (respectCooldown && this.isCoolingDown(model.channelId)) return false;
        const channel = this.repo.getChannel(model.channelId);
        return !!channel?.enabled;
      });
      if (valid.length === 0) return null;
      const key = `${publicName}\u0000${priority}`;
      const lastId = this.roundRobin.get(key);
      const lastIndex = lastId === undefined ? -1 : valid.findIndex((model) => model.id === lastId);
      const start = lastIndex >= 0 ? (lastIndex + 1) % valid.length : 0;
      for (let offset = 0; offset < valid.length; offset += 1) {
        const model = valid[(start + offset) % valid.length];
        const channel = this.repo.getChannel(model.channelId);
        if (!channel?.enabled) continue;
        this.roundRobin.set(key, model.id);
        return { model, channel };
      }
      return null;
    };

    const priorities = [...groups.keys()].sort((a, b) => a - b);
    for (const priority of priorities) {
      const picked = pickGroup(priority, groups.get(priority)!, true);
      if (picked) return picked;
    }
    // 保留原有软兜底：所有候选都在冷却时，仍探测最高优先级组。
    for (const priority of priorities) {
      const picked = pickGroup(priority, groups.get(priority)!, false);
      if (picked) return picked;
    }
    return null;
  }

  private threshold(): number {
    return this.opts.failureThreshold ?? 3;
  }

  private cooldownMs(): number {
    return this.opts.cooldownMs ?? 60_000;
  }

  isCoolingDown(channelId: number): boolean {
    return (this.cooldowns.get(channelId) ?? 0) > Date.now();
  }

  health(channelId: number): ChannelHealthSnapshot {
    const cooldownUntil = this.cooldowns.get(channelId) ?? null;
    return {
      failureCount: this.failures.get(channelId) ?? 0,
      coolingDown: cooldownUntil !== null && cooldownUntil > Date.now(),
      cooldownUntil,
    };
  }

  markSuccess(channelId: number): void {
    this.failures.delete(channelId);
    this.cooldowns.delete(channelId);
  }

  markFailure(channelId: number): void {
    const n = (this.failures.get(channelId) ?? 0) + 1;
    if (n >= this.threshold()) {
      this.cooldowns.set(channelId, Date.now() + this.cooldownMs());
      this.failures.delete(channelId);
    } else {
      this.failures.set(channelId, n);
    }
  }
}
