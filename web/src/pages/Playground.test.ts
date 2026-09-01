import { describe, expect, it, vi } from "vitest";
import { fetchJobIfCurrent, parseRunningJob, startEditJob, startMultipartJob } from "./Playground";

describe("startEditJob", () => {
  it("hands the created edit job to the polling callback", async () => {
    const form = new FormData();
    const create = vi.fn().mockResolvedValue({ jobId: "edit-job-1" });
    const onStarted = vi.fn();

    await startEditJob(form, onStarted, create);

    expect(create).toHaveBeenCalledWith(form);
    expect(onStarted).toHaveBeenCalledWith("edit-job-1");
  });

  it("does not start polling when the submission was cancelled during upload", async () => {
    let finishCreate!: (value: { jobId: string }) => void;
    const create = vi.fn().mockReturnValue(new Promise<{ jobId: string }>((resolve) => (finishCreate = resolve)));
    const onStarted = vi.fn();
    let current = true;

    const pending = startEditJob(new FormData(), onStarted, create, () => current);
    current = false;
    finishCreate({ jobId: "edit-job-1" });
    await pending;

    expect(onStarted).not.toHaveBeenCalled();
  });
});

describe("startMultipartJob", () => {
  it("hands an upscale job to the shared polling callback", async () => {
    const form = new FormData();
    const create = vi.fn().mockResolvedValue({ jobId: "upscale-job-1" });
    const onStarted = vi.fn();

    await startMultipartJob(form, onStarted, create);

    expect(create).toHaveBeenCalledWith(form);
    expect(onStarted).toHaveBeenCalledWith("upscale-job-1");
  });
});

describe("parseRunningJob", () => {
  it("recovers the new kind-aware storage format", () => {
    expect(parseRunningJob(JSON.stringify({ id: "job-1", kind: "upscale" }))).toEqual({ id: "job-1", kind: "upscale" });
  });

  it("keeps recovering legacy bare job ids", () => {
    expect(parseRunningJob("legacy-job-1")).toEqual({ id: "legacy-job-1" });
  });
});

describe("fetchJobIfCurrent", () => {
  it("ignores an in-flight polling response after cancellation", async () => {
    let finishFetch!: (value: { status: "running" }) => void;
    const fetcher = vi.fn().mockReturnValue(new Promise<{ status: "running" }>((resolve) => (finishFetch = resolve)));
    let current = true;

    const pending = fetchJobIfCurrent("job-1", () => current, fetcher);
    current = false;
    finishFetch({ status: "running" });

    await expect(pending).resolves.toBeNull();
  });

  it("ignores an in-flight polling error after cancellation", async () => {
    let failFetch!: (reason: Error) => void;
    const fetcher = vi.fn().mockReturnValue(new Promise((_resolve, reject) => (failFetch = reject)));
    let current = true;

    const pending = fetchJobIfCurrent("job-1", () => current, fetcher);
    current = false;
    failFetch(new Error("late failure"));

    await expect(pending).resolves.toBeNull();
  });
});
