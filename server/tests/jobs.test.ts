import { describe, expect, it } from "vitest";
import { JobManager } from "../src/server/jobs.js";

describe("JobManager", () => {
  it("create/get/finish lifecycle with owner check", () => {
    const jm = new JobManager();
    const job = jm.create({ apiKeyId: 1, generationId: 10, model: "m", prompt: "p" });
    expect(jm.get(job.id, 1)?.status).toBe("running");
    expect(jm.get(job.id, 2)).toBeNull();
    jm.setProgress(job.id, "generating");
    jm.addImage(job.id, { file: "a.png" });
    jm.finish(job.id, { status: "ok", channelId: 3, channelName: "c", latencyMs: 42, errorMessage: null });
    const done = jm.get(job.id, 1)!;
    expect(done.progress).toBe("generating");
    expect(done.images).toEqual([{ file: "a.png" }]);
    expect(done.status).toBe("ok");
    expect(done.latencyMs).toBe(42);
  });

  it("prune evicts oldest finished jobs beyond cap", () => {
    const jm = new JobManager(3);
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const j = jm.create({ apiKeyId: null, generationId: i, model: "m", prompt: "p" });
      ids.push(j.id);
      jm.finish(j.id, { status: "ok", channelId: null, channelName: null, latencyMs: 1, errorMessage: null });
    }
    expect(jm.get(ids[0], null)).toBeNull();
    expect(jm.get(ids[3], null)).not.toBeNull();
  });
});
