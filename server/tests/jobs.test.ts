import { describe, expect, it } from "vitest";
import { JobManager } from "../src/server/jobs.js";

describe("JobManager", () => {
  it("create/get/finish lifecycle with owner check", () => {
    const jm = new JobManager();
    const job = jm.create({ apiKeyId: 1, userId: null, generationId: 10, model: "m", prompt: "p" });
    expect(jm.get(job.id, { apiKeyId: 1, userId: null, admin: false })?.status).toBe("running");
    expect(jm.get(job.id, { apiKeyId: 2, userId: null, admin: false })).toBeNull();
    jm.setProgress(job.id, "generating");
    jm.addImage(job.id, { file: "a.png" });
    jm.finish(job.id, { status: "ok", channelId: 3, channelName: "c", latencyMs: 42, errorMessage: null });
    const done = jm.get(job.id, { apiKeyId: 1, userId: null, admin: false })!;
    expect(done.progress).toBe("generating");
    expect(done.images).toEqual([{ file: "a.png" }]);
    expect(done.status).toBe("ok");
    expect(done.latencyMs).toBe(42);
  });

  it("isolates user jobs while allowing the owning user's keys and admins", () => {
    const jm = new JobManager();
    const job = jm.create({ apiKeyId: null, userId: 10, generationId: 10, model: "m", prompt: "p" });

    expect(jm.get(job.id, { apiKeyId: null, userId: 10, admin: false })).not.toBeNull();
    expect(jm.get(job.id, { apiKeyId: 7, userId: 10, admin: false })).not.toBeNull();
    expect(jm.get(job.id, { apiKeyId: null, userId: 11, admin: false })).toBeNull();
    expect(jm.get(job.id, { apiKeyId: 7, userId: null, admin: false })).toBeNull();
    expect(jm.get(job.id, { apiKeyId: null, userId: 99, admin: true })).not.toBeNull();
  });

  it("prune evicts oldest finished jobs beyond cap", () => {
    const jm = new JobManager(3);
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const j = jm.create({ apiKeyId: null, userId: null, generationId: i, model: "m", prompt: "p" });
      ids.push(j.id);
      jm.finish(j.id, { status: "ok", channelId: null, channelName: null, latencyMs: 1, errorMessage: null });
    }
    const anonymous = { apiKeyId: null, userId: null, admin: false };
    expect(jm.get(ids[0], anonymous)).toBeNull();
    expect(jm.get(ids[3], anonymous)).not.toBeNull();
  });
});
