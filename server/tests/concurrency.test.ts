import { describe, expect, it, vi } from "vitest";
import { AdaptiveConcurrencyLimiter } from "../src/core/concurrency.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("AdaptiveConcurrencyLimiter", () => {
  it("runs queued tasks in FIFO order", async () => {
    const limiter = new AdaptiveConcurrencyLimiter(1);
    const gate = deferred();
    const order: string[] = [];
    const first = limiter.run(async () => { order.push("first"); await gate.promise; });
    const second = limiter.run(async () => { order.push("second"); });
    const third = limiter.run(async () => { order.push("third"); });

    await vi.waitFor(() => expect(order).toEqual(["first"]));
    gate.resolve();
    await Promise.all([first, second, third]);
    expect(order).toEqual(["first", "second", "third"]);
  });

  it("applies increased and decreased limits without dropping queued tasks", async () => {
    const limiter = new AdaptiveConcurrencyLimiter(1);
    const gates = [deferred(), deferred(), deferred()];
    let active = 0;
    let entered = 0;
    const run = (index: number) => limiter.run(async () => {
      active++;
      entered++;
      await gates[index].promise;
      active--;
    });
    const tasks = [run(0), run(1), run(2)];

    await vi.waitFor(() => expect(entered).toBe(1));
    limiter.setMax(3);
    await vi.waitFor(() => expect(entered).toBe(3));
    limiter.setMax(1);
    const fourthGate = deferred();
    const fourth = limiter.run(async () => { active++; entered++; await fourthGate.promise; active--; });
    gates[0].resolve();
    gates[1].resolve();
    await vi.waitFor(() => expect(active).toBe(1));
    expect(entered).toBe(3);
    gates[2].resolve();
    await vi.waitFor(() => expect(entered).toBe(4));
    fourthGate.resolve();
    await Promise.all([...tasks, fourth]);
  });

  it("releases a slot when a task rejects", async () => {
    const limiter = new AdaptiveConcurrencyLimiter(1);
    const failed = limiter.run(async () => { throw new Error("boom"); });
    const next = limiter.run(async () => "ok");
    await expect(failed).rejects.toThrow("boom");
    await expect(next).resolves.toBe("ok");
  });
});
