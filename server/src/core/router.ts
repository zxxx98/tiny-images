import type { ChannelRow, ModelRow, Repo } from "../store/repo.js";

export interface ResolvedRoute {
  model: ModelRow;
  channel: ChannelRow;
}

export interface RouterOptions {
  /** 连续失败多少次后打开熔断 */
  failureThreshold?: number;
  /** 熔断时长（毫秒） */
  cooldownMs?: number;
}

/**
 * 模型路由：同一对外模型名可映射多个渠道，按 priority 升序故障转移；
 * 渠道连续失败达到阈值后进入内存熔断（冷却期内跳过，全部冷却中则兜底尝试）。
 */
export class ModelRouter {
  private failures = new Map<number, number>();
  private cooldowns = new Map<number, number>();

  constructor(
    private readonly repo: Repo,
    private readonly opts: RouterOptions = {},
  ) {}

  resolve(publicName: string, allowedChannelIds?: number[] | null): ResolvedRoute | null {
    const candidates = this.repo.listEnabledModelRoutes(publicName);
    if (candidates.length === 0) return null;
    const allowed = (m: ModelRow): boolean => !allowedChannelIds || (allowedChannelIds.length > 0 && allowedChannelIds.includes(m.channelId));
    const pickFirst = (respectCooldown: boolean): ResolvedRoute | null => {
      for (const model of candidates) {
        if (!allowed(model)) continue;
        if (respectCooldown && this.isCoolingDown(model.channelId)) continue;
        const channel = this.repo.getChannel(model.channelId);
        if (!channel || !channel.enabled) continue;
        return { model, channel };
      }
      return null;
    };
    return pickFirst(true) ?? pickFirst(false);
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
