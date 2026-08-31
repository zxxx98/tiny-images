import { describe, expect, it, vi } from "vitest";
import { startEditJob } from "./Playground";

describe("startEditJob", () => {
  it("hands the created edit job to the polling callback", async () => {
    const form = new FormData();
    const create = vi.fn().mockResolvedValue({ jobId: "edit-job-1" });
    const onStarted = vi.fn();

    await startEditJob(form, onStarted, create);

    expect(create).toHaveBeenCalledWith(form);
    expect(onStarted).toHaveBeenCalledWith("edit-job-1");
  });
});
