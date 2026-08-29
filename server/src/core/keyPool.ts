import type { Repo } from "../store/repo.js";

export interface PickedKey {
  keyId: number;
  apiKey: string;
}

export class KeyPool {
  private cursor = new Map<number, number>();

  constructor(private readonly repo: Repo) {}

  pick(channelId: number): PickedKey | null {
    const now = Date.now();
    const usable = this.repo.enabledKeys(channelId).filter((k) => k.cooldownUntil <= now);
    if (usable.length === 0) return null;
    const idx = this.cursor.get(channelId) ?? -1;
    const next = usable[(idx + 1) % usable.length];
    this.cursor.set(channelId, idx + 1);
    return { keyId: next.id, apiKey: next.apiKey };
  }

  markFailure(keyId: number, cooldownMs = 60_000): void {
    this.repo.setKeyCooldown(keyId, Date.now() + cooldownMs);
  }

  markSuccess(keyId: number): void {
    this.repo.setKeyCooldown(keyId, 0);
  }
}
