import { randomBytes } from "node:crypto";

export interface JobImage {
  file: string;
  revisedPrompt?: string;
}

export type JobKind = "generate" | "edit" | "upscale";

export interface JobRecord {
  id: string;
  kind: JobKind;
  apiKeyId: number | null;
  userId: number | null;
  generationId: number;
  model: string;
  prompt: string;
  createdAt: number;
  status: "running" | "ok" | "error";
  progress: string | null;
  images: JobImage[];
  channelId: number | null;
  channelName: string | null;
  latencyMs: number | null;
  errorMessage: string | null;
}

export interface JobViewer {
  apiKeyId: number | null;
  userId: number | null;
  admin: boolean;
}

// 内存 job 注册表：进程内可轮询的生成任务；历史查证走 generations 表
export class JobManager {
  private jobs = new Map<string, JobRecord>(); // Map 保插入序，便于按最老淘汰

  constructor(private readonly max = 200) {}

  create(input: { apiKeyId: number | null; userId: number | null; generationId: number; model: string; prompt: string; kind?: JobKind }): JobRecord {
    const job: JobRecord = {
      id: randomBytes(12).toString("hex"),
      kind: input.kind ?? "generate",
      apiKeyId: input.apiKeyId,
      userId: input.userId,
      generationId: input.generationId,
      model: input.model,
      prompt: input.prompt,
      createdAt: Date.now(),
      status: "running",
      progress: null,
      images: [],
      channelId: null,
      channelName: null,
      latencyMs: null,
      errorMessage: null,
    };
    this.jobs.set(job.id, job);
    this.prune();
    return job;
  }

  get(id: string, viewer: JobViewer): JobRecord | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    if (viewer.admin) return job;
    if (job.userId !== null) return viewer.userId === job.userId ? job : null;
    if (job.apiKeyId !== null) return viewer.apiKeyId === job.apiKeyId ? job : null;
    return viewer.userId === null && viewer.apiKeyId === null ? job : null;
  }

  setProgress(id: string, message: string): void {
    const job = this.jobs.get(id);
    if (job) job.progress = message;
  }

  addImage(id: string, image: JobImage): void {
    const job = this.jobs.get(id);
    if (job) job.images.push(image);
  }

  finish(
    id: string,
    patch: { status: "ok" | "error"; channelId: number | null; channelName: string | null; latencyMs: number | null; errorMessage: string | null },
  ): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.status = patch.status;
    job.channelId = patch.channelId;
    job.channelName = patch.channelName;
    job.latencyMs = patch.latencyMs;
    job.errorMessage = patch.errorMessage;
  }

  prune(): void {
    if (this.jobs.size <= this.max) return;
    for (const [id, job] of this.jobs) {
      if (this.jobs.size <= this.max) break;
      if (job.status !== "running") this.jobs.delete(id);
    }
  }
}
