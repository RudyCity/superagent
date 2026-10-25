/**
 * Bounded, fail-closed local task dispatcher. Worker callbacks are supplied by
 * trusted runtime code, not directly by an HTTP or MCP request. The persisted
 * journal is authoritative; callback execution is never automatically replayed.
 */
import { AssistantTaskStore, type AssistantTaskRecord } from "./assistantTaskStore.js";

export type ResourceAccess = { key: string; mode: "read" | "write" };
export type TrustedTaskWorker = (context: {
  task: AssistantTaskRecord;
  signal: AbortSignal;
}) => Promise<string[] | void>;

interface DispatchEntry {
  task: AssistantTaskRecord;
  resources: ResourceAccess[];
  run: TrustedTaskWorker;
  resolve: (value: AssistantTaskRecord) => void;
  reject: (error: unknown) => void;
}
interface ActiveEntry {
  entry: DispatchEntry;
  controller: AbortController;
}

export class AssistantTaskDispatcher {
  private readonly queued: DispatchEntry[] = [];
  private readonly active = new Map<string, ActiveEntry>();
  private readonly pendingIds = new Set<string>();
  private draining = false;

  constructor(private readonly journal: AssistantTaskStore, private readonly limit = 3) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 6) {
      throw new Error("Parallel task limit must be 1-6");
    }
  }

  get status() {
    return { queued: this.queued.length, running: this.active.size, capacity: this.limit };
  }

  submit(task: AssistantTaskRecord, resources: readonly ResourceAccess[], run: TrustedTaskWorker):
    Promise<AssistantTaskRecord> {
    if (typeof run !== "function" || task.status !== "queued" ||
        !task.taskId || this.pendingIds.has(task.taskId)) {
      throw new Error("Task is not eligible for dispatch");
    }
    const normalized = resources.map(resource => {
      if (!resource || typeof resource.key !== "string" ||
          resource.key.length < 1 || resource.key.length > 256 ||
          /[\x00-\x1f]/.test(resource.key) ||
          (resource.mode !== "read" && resource.mode !== "write")) {
        throw new Error("Invalid task resource declaration");
      }
      return { key: resource.key, mode: resource.mode };
    });
    if (normalized.length > 32) throw new Error("Resource budget exceeded");
    this.pendingIds.add(task.taskId);
    return new Promise<AssistantTaskRecord>((resolve, reject) => {
      this.queued.push({ task, resources: normalized, run, resolve, reject });
      this.dispatch();
    });
  }

  private conflicts(resources: readonly ResourceAccess[]): boolean {
    for (const active of this.active.values()) {
      for (const held of active.entry.resources) {
        for (const requested of resources) {
          if (held.key === requested.key && (held.mode === "write" || requested.mode === "write")) {
            return true;
          }
        }
      }
    }
    return false;
  }

  private dispatch(): void {
    if (this.draining) return;
    while (this.active.size < this.limit) {
      // First eligible task can proceed past a blocked queue item, without
      // violating a resource lock owned by a currently executing worker.
      const index = this.queued.findIndex(entry => !this.conflicts(entry.resources));
      if (index < 0) break;
      const [entry] = this.queued.splice(index, 1);
      const controller = new AbortController();
      this.active.set(entry.task.taskId, { entry, controller });
      void this.execute(entry, controller).then(entry.resolve, entry.reject).finally(() => {
        this.active.delete(entry.task.taskId);
        this.pendingIds.delete(entry.task.taskId);
        this.dispatch();
      });
    }
  }

  private async execute(entry: DispatchEntry, controller: AbortController):
    Promise<AssistantTaskRecord> {
    // The compare-and-swap persisted transition is the claim. A second
    // dispatcher using a stale record will fail before running the callback.
    const planning = await this.journal.transition({
      taskId: entry.task.taskId, expectedRevision: entry.task.revision, status: "planning",
    });
    const running = await this.journal.transition({
      taskId: planning.taskId, expectedRevision: planning.revision, status: "running",
    });
    try {
      if (controller.signal.aborted) {
        return await this.journal.transition({
          taskId: running.taskId, expectedRevision: running.revision, status: "cancelled",
        });
      }
      const evidence = await entry.run({ task: running, signal: controller.signal });
      return await this.journal.transition({
        taskId: running.taskId, expectedRevision: running.revision,
        status: controller.signal.aborted ? "cancelled" : "completed",
        evidenceIds: controller.signal.aborted ? [] : (evidence ?? []),
      });
    } catch (error) {
      // No raw exception text, secrets, prompts, or tool output in the journal.
      const current = (await this.journal.list(100)).find(t => t.taskId === running.taskId);
      if (current?.status === "running" && current.revision === running.revision) {
        await this.journal.transition({
          taskId: running.taskId, expectedRevision: running.revision,
          status: controller.signal.aborted ? "cancelled" : "failed",
        });
      }
      throw error;
    }
  }

  /** Requests cancellation; result remains pending until worker acknowledges. */
  cancel(taskId: string): boolean {
    const active = this.active.get(taskId);
    if (!active) return false;
    active.controller.abort();
    return true;
  }

  /** Drain does not cancel already running jobs or discard queued tasks. */
  async whenIdle(): Promise<void> {
    while (this.queued.length > 0 || this.active.size > 0) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
}
