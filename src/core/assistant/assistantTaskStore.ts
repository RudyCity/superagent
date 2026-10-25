/** Durable, owner/workspace scoped assistant task metadata. No worker execution.
 * This module only journals explicit state changes. It intentionally does not
 * infer successful work from a saved logical task or replay external side effects.
 */
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export const TASK_STATES = [
  "queued", "planning", "awaiting_approval", "running",
  "completed", "failed", "cancelled", "interrupted", "reconcile_required",
] as const;
export type AssistantTaskState = typeof TASK_STATES[number];

const transitions: Record<AssistantTaskState, readonly AssistantTaskState[]> = {
  queued: ["planning", "cancelled"],
  planning: ["awaiting_approval", "running", "failed", "cancelled", "interrupted"],
  awaiting_approval: ["running", "cancelled", "failed", "interrupted"],
  running: ["completed", "failed", "cancelled", "interrupted", "reconcile_required"],
  completed: [], failed: [], cancelled: [], interrupted: ["reconcile_required"],
  reconcile_required: [],
};
const ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;
const MAX_TASKS = 500;
const MAX_EVENTS = 2500;

export interface AssistantTaskRecord {
  taskId: string;
  goalId: string;
  ownerId: string;
  workspaceId: string;
  title: string;
  idempotencyKey: string;
  status: AssistantTaskState;
  revision: number;
  createdAt: number;
  updatedAt: number;
  evidenceIds: string[];
}
export interface AssistantTaskEvent {
  seq: number;
  taskId: string;
  status: AssistantTaskState;
  at: number;
  revision: number;
}
interface TaskSnapshot {
  schemaVersion: 1;
  nextEventSeq: number;
  tasks: AssistantTaskRecord[];
  events: AssistantTaskEvent[];
}
export interface TaskOwnerScope {
  ownerId: string;
  workspaceId: string;
}

const emptySnapshot = (): TaskSnapshot => ({
  schemaVersion: 1, nextEventSeq: 1, tasks: [], events: [],
});
function validId(id: string, field: string): string {
  if (typeof id !== "string" || !ID_PATTERN.test(id)) throw new Error("Invalid " + field);
  return id;
}
function validTitle(value: string): string {
  if (typeof value !== "string" || value.trim().length < 1 || value.length > 2048 ||
      /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) throw new Error("Invalid task title");
  return value.trim();
}
function copy<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }

export class AssistantTaskStore {
  private readonly filePath: string;
  private readonly lockPath: string;
  constructor(rootDir: string, private readonly scope: TaskOwnerScope) {
    validId(scope.ownerId, "ownerId");
    validId(scope.workspaceId, "workspaceId");
    const name = createHash("sha256").update(scope.ownerId + "\0" + scope.workspaceId)
      .digest("hex");
    this.filePath = path.join(rootDir, "assistant-tasks", name + ".json");
    this.lockPath = this.filePath + ".lock";
  }

  private async load(): Promise<TaskSnapshot> {
    let content: string;
    try { content = await fs.readFile(this.filePath, "utf8"); }
    catch (error: any) {
      if (error?.code === "ENOENT") return emptySnapshot();
      throw error;
    }
    // Never silently replace corrupt task history with an empty queue.
    if (Buffer.byteLength(content) > 8 * 1024 * 1024) throw new Error("Task journal exceeds size limit");
    const value: TaskSnapshot = JSON.parse(content);
    if (value?.schemaVersion !== 1 || !Number.isSafeInteger(value.nextEventSeq) ||
        value.nextEventSeq < 1 || !Array.isArray(value.tasks) || !Array.isArray(value.events) ||
        value.tasks.length > MAX_TASKS || value.events.length > MAX_EVENTS) {
      throw new Error("Unsupported or corrupted task journal");
    }
    // Reject cross-scope records instead of filtering them and rewriting data.
    for (const task of value.tasks) {
      if (task.ownerId !== this.scope.ownerId || task.workspaceId !== this.scope.workspaceId ||
          !ID_PATTERN.test(task.taskId) || !TASK_STATES.includes(task.status) ||
          !Number.isSafeInteger(task.revision) || task.revision < 1) {
        throw new Error("Task journal scope or schema mismatch");
      }
    }
    return value;
  }

  private async mutate<T>(change: (snapshot: TaskSnapshot) => T | Promise<T>): Promise<T> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    // Exclusive creation prevents concurrent writers in separate runtime processes.
    // A stale lock fails closed; never steal an unknown writer's lease.
    let handle;
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        handle = await fs.open(this.lockPath, "wx", 0o600);
        break;
      } catch (error: any) {
        if (error?.code !== "EEXIST") throw error;
        if (attempt === 19) throw new Error("Task journal busy; operator reconciliation required");
        // Bounded wait for ordinary concurrent submissions. Never steal a lock:
        // an abandoned writer requires explicit operator reconciliation.
        await new Promise<void>(resolve => setTimeout(resolve, 10 + attempt * 2));
      }
    }
    if (!handle) throw new Error("Task journal lock unavailable");
    try {
      const snapshot = await this.load();
      const result = await change(snapshot);
      const tmp = this.filePath + "." + randomUUID() + ".tmp";
      try {
        await fs.writeFile(tmp, JSON.stringify(snapshot), { mode: 0o600, flag: "wx" });
        await fs.rename(tmp, this.filePath);
      } finally { await fs.rm(tmp, { force: true }).catch(() => {}); }
      return copy(result);
    } finally {
      await handle.close();
      await fs.rm(this.lockPath, { force: true }).catch(() => {});
    }
  }

  private append(snapshot: TaskSnapshot, task: AssistantTaskRecord): void {
    if (snapshot.events.length >= MAX_EVENTS) throw new Error("Task event capacity reached");
    snapshot.events.push({
      seq: snapshot.nextEventSeq++, taskId: task.taskId,
      status: task.status, revision: task.revision, at: task.updatedAt,
    });
  }

  async create(input: {
    goalId: string; title: string; idempotencyKey: string;
  }): Promise<AssistantTaskRecord> {
    validId(input.goalId, "goalId");
    validId(input.idempotencyKey, "idempotencyKey");
    const title = validTitle(input.title);
    return this.mutate(snapshot => {
      const existing = snapshot.tasks.find(t => t.idempotencyKey === input.idempotencyKey);
      if (existing) {
        if (existing.goalId !== input.goalId || existing.title !== title) {
          throw new Error("Idempotency key reused with conflicting task parameters");
        }
        return existing;
      }
      if (snapshot.tasks.length >= MAX_TASKS) throw new Error("Task capacity reached");
      const now = Date.now();
      const task: AssistantTaskRecord = {
        taskId: randomUUID(), goalId: input.goalId, ownerId: this.scope.ownerId,
        workspaceId: this.scope.workspaceId, title,
        idempotencyKey: input.idempotencyKey, status: "queued",
        revision: 1, createdAt: now, updatedAt: now, evidenceIds: [],
      };
      snapshot.tasks.push(task);
      this.append(snapshot, task);
      return task;
    });
  }

  async transition(input: {
    taskId: string; expectedRevision: number; status: AssistantTaskState; evidenceIds?: string[];
  }): Promise<AssistantTaskRecord> {
    validId(input.taskId, "taskId");
    if (!TASK_STATES.includes(input.status)) throw new Error("Unknown task state");
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) throw new Error("Invalid revision");
    const evidenceIds = input.evidenceIds ?? [];
    if (!Array.isArray(evidenceIds) || evidenceIds.length > 16 ||
        evidenceIds.some(id => typeof id !== "string" || !ID_PATTERN.test(id))) {
      throw new Error("Invalid evidence references");
    }
    return this.mutate(snapshot => {
      const task = snapshot.tasks.find(t => t.taskId === input.taskId);
      if (!task) throw new Error("Task not found in owner/workspace scope");
      if (task.revision !== input.expectedRevision) throw new Error("Task revision conflict");
      if (!transitions[task.status].includes(input.status)) {
        throw new Error("Illegal transition " + task.status + " -> " + input.status);
      }
      task.status = input.status;
      task.revision += 1;
      task.updatedAt = Date.now();
      task.evidenceIds = [...evidenceIds];
      this.append(snapshot, task);
      return task;
    });
  }

  async get(taskId: string): Promise<AssistantTaskRecord | null> {
    validId(taskId, "taskId");
    const snapshot = await this.load();
    const task = snapshot.tasks.find(t => t.taskId === taskId);
    return task ? copy(task) : null;
  }

  async list(limit = 100): Promise<AssistantTaskRecord[]> {
    const snapshot = await this.load();
    return copy(snapshot.tasks.slice(-Math.max(1, Math.min(100, limit))).reverse());
  }

  async eventsAfter(cursor = 0, limit = 100): Promise<{
    events: AssistantTaskEvent[]; nextCursor: number;
  }> {
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error("Invalid event cursor");
    const snapshot = await this.load();
    const events = snapshot.events.filter(e => e.seq > cursor)
      .slice(0, Math.max(1, Math.min(100, limit)));
    return { events: copy(events), nextCursor: events.at(-1)?.seq ?? cursor };
  }
}
