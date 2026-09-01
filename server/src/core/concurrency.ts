interface QueuedTask<T> {
  task: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

export class AdaptiveConcurrencyLimiter {
  private active = 0;
  private max: number;
  private readonly waiting: QueuedTask<unknown>[] = [];

  constructor(max: number) {
    this.max = max;
  }

  setMax(max: number): void {
    this.max = max;
    this.drain();
  }

  run<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.waiting.push({ task, resolve, reject } as QueuedTask<unknown>);
      this.drain();
    });
  }

  private drain(): void {
    while (this.active < this.max) {
      const queued = this.waiting.shift();
      if (!queued) return;
      this.active++;
      void queued.task().then(queued.resolve, queued.reject).finally(() => {
        this.active--;
        this.drain();
      });
    }
  }
}
