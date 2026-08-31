import { describe, expect, it, vi } from "vitest";
import { pruneExpiredGenerationHistory } from "../src/store/retention.js";

describe("generation history retention", () => {
  it("prunes rows older than exactly seven days", () => {
    const pruneGenerations = vi.fn(() => 2);
    const now = Date.UTC(2026, 7, 31, 12);

    expect(pruneExpiredGenerationHistory({ pruneGenerations }, now)).toBe(2);
    expect(pruneGenerations).toHaveBeenCalledWith(now - 7 * 24 * 60 * 60 * 1000);
  });
});
