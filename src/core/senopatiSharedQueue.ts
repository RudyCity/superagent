/** Bounded single-owner Senopati inference scheduler.
 *
 * Avoids sudden RPC failure for normal short bursts and caps RAM pressure.
 * Pending requests expire without running; no extra model instances spawn.
 * Generic and dependency-free so tests can use mock jobs.
 */
export type SenopatiQueueStats = {
  active: number;
  queued: number;
  completed: number;
  rejected: number;
  timedOut: number;
  canceled: number;
};
type Job<T> = {
  work: () => Promise<T | null>;
  resolve: (result: T | null) => void;
  timeout: ReturnType<typeof setTimeout> | null;
  settled: boolean;
  signal?: AbortSignal;
  abort?: () => void;
};
export class SenopatiBoundedQueue<T> {
  private readonly pending: Job<T>[] = [];
  private activeCount = 0;
  private completedCount = 0;
  private rejectedCount = 0;
  private timedOutCount = 0;
  private canceledCount = 0;
  private closed = false;

  constructor(
    readonly maxActive = 4,
    readonly maxQueued = 64,
    readonly waitTimeoutMs = 7_000,
  ) {
    if (!Number.isInteger(maxActive) || maxActive < 1 || maxActive > 16 ||
        !Number.isInteger(maxQueued) || maxQueued < 0 || maxQueued > 1024 ||
        !Number.isFinite(waitTimeoutMs) || waitTimeoutMs < 100 ||
        waitTimeoutMs > 60_000) {
      throw new Error("Invalid bounded Senopati queue limits");
    }
  }
  stats(): SenopatiQueueStats {
    return {
      active: this.activeCount, queued: this.pending.length,
      completed: this.completedCount, rejected: this.rejectedCount,
      timedOut: this.timedOutCount, canceled: this.canceledCount,
    };
  }
  run(work: () => Promise<T | null>, signal?: AbortSignal): Promise<T | null> {
    if (signal?.aborted) {
      this.canceledCount++;
      return Promise.resolve(null);
    }
    if (this.closed) {
      this.rejectedCount++;
      return Promise.resolve(null);
    }
    if (this.activeCount >= this.maxActive &&
        this.pending.length >= this.maxQueued) {
      this.rejectedCount++;
      return Promise.resolve(null);
    }
    return new Promise<T | null>((resolve) => {
      const job: Job<T> = {
        work, resolve, timeout: null, settled: false, signal,
      };
      if (this.activeCount < this.maxActive) {
        this.start(job);
        return;
      }
      job.abort = () => {
        if (job.settled) return;
        const index = this.pending.indexOf(job);
        if (index < 0) return;
        this.pending.splice(index, 1);
        if (job.timeout) clearTimeout(job.timeout);
        job.settled = true;
        this.canceledCount++;
        job.resolve(null);
      };
      signal?.addEventListener("abort", job.abort, { once: true });
      job.timeout = setTimeout(() => {
        if (job.settled) return;
        const i = this.pending.indexOf(job);
        if (i < 0) return;
        this.pending.splice(i, 1);
        job.settled = true;
        if (job.abort) signal?.removeEventListener("abort", job.abort);
        this.timedOutCount++;
        job.resolve(null);
      }, this.waitTimeoutMs);
      job.timeout.unref?.();
      this.pending.push(job);
      if (signal?.aborted) job.abort();
    });
  }
  close(): void {
    this.closed = true;
    for (const job of this.pending.splice(0)) {
      if (job.timeout) clearTimeout(job.timeout);
      if (job.abort) job.signal?.removeEventListener("abort", job.abort);
      job.settled = true;
      this.rejectedCount++;
      job.resolve(null);
    }
  }
  private start(job: Job<T>): void {
    if (job.timeout) clearTimeout(job.timeout);
    if (job.abort) job.signal?.removeEventListener("abort", job.abort);
    if (this.closed || job.settled) {
      job.settled = true;
      job.resolve(null);
      return;
    }
    job.settled = true;
    this.activeCount++;
    void (async () => {
      let result: T | null = null;
      try {
        result = await job.work();
      } catch {
        // Fail closed; no speculative model result on backend errors.
      } finally {
        this.activeCount--;
        this.completedCount++;
        this.drain();
        // Results are visible only after concurrency accounting is updated.
        job.resolve(result);
      }
    })();
  }
  private drain(): void {
    while (!this.closed && this.activeCount < this.maxActive && this.pending.length) {
      const next = this.pending.shift();
      if (next) this.start(next);
    }
  }
}
