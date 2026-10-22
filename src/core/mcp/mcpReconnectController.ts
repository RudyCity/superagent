/**
 * Bounded, per-server reconnect scheduling for MCP client connections.
 * Idle retry timers are unref'd so shutting down the CLI is not blocked.
 */
export interface ReconnectState {
  attempts: number;
  nextDelayMs: number | null;
}

export class McpReconnectController {
  private readonly attempts = new Map<string, number>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly running = new Set<string>();
  private readonly generations = new Map<string, number>();
  constructor(
    private readonly baseDelayMs = 1_000,
    private readonly maxDelayMs = 30_000,
    private readonly maxAttempts = 5,
  ) {}

  state(name: string): ReconnectState {
    const attempts = this.attempts.get(name) || 0;
    return { attempts, nextDelayMs: this.timers.has(name) ? this.delayFor(attempts) : null };
  }

  schedule(name: string, attempt: () => Promise<boolean>): boolean {
    if (this.timers.has(name) || this.running.has(name)) return false;
    const nextAttempt = (this.attempts.get(name) || 0) + 1;
    if (nextAttempt > this.maxAttempts) return false;
    this.attempts.set(name, nextAttempt);
    const generation = this.generations.get(name) || 0;
    const timer = setTimeout(async () => {
      this.timers.delete(name);
      this.running.add(name);
      let success = false;
      try { success = await attempt(); } catch { /* retry within budget */ }
      this.running.delete(name);
      if (generation !== (this.generations.get(name) || 0)) return;
      if (success) this.reset(name);
      else this.schedule(name, attempt);
    }, this.delayFor(nextAttempt));
    timer.unref?.();
    this.timers.set(name, timer);
    return true;
  }

  reset(name: string): void {
    this.cancel(name);
    this.attempts.delete(name);
  }

  cancel(name: string): void {
    this.generations.set(name, (this.generations.get(name) || 0) + 1);
    const timer = this.timers.get(name);
    if (timer) clearTimeout(timer);
    this.timers.delete(name);
  }

  cancelAll(): void {
    for (const name of new Set([...this.timers.keys(), ...this.running, ...this.attempts.keys()])) this.cancel(name);
    this.attempts.clear();
  }

  private delayFor(attempt: number): number {
    return Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** (Math.max(1, attempt) - 1));
  }
}
