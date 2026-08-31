export const GENERATION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface GenerationHistoryPruner {
  pruneGenerations(createdBefore: number): number;
}

export function pruneExpiredGenerationHistory(repo: GenerationHistoryPruner, now = Date.now()): number {
  return repo.pruneGenerations(now - GENERATION_RETENTION_MS);
}
