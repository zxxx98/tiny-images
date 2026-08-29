import type { ChannelRow, ModelRow, Repo } from "../store/repo.js";

export interface ResolvedRoute {
  model: ModelRow;
  channel: ChannelRow;
}

export class ModelRouter {
  constructor(private readonly repo: Repo) {}

  resolve(publicName: string): ResolvedRoute | null {
    const model = this.repo.findEnabledModel(publicName);
    if (!model) return null;
    const channel = this.repo.getChannel(model.channelId);
    if (!channel || !channel.enabled) return null;
    return { model, channel };
  }
}
