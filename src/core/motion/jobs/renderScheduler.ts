import fs from "node:fs/promises";
import path from "node:path";
import type { MotionJob } from "./motionJobs.js";

/**
 * Multi-process filesystem admission. The lock files intentionally fail closed:
 * on a process crash an operator must inspect/reconcile the owner. We never
 * infer process identity from a reusable PID or silently steal a slot.
 */
export const MOTION_QUEUE_LIMIT = 12;
export function motionConcurrentSlots(): number {
  const value = Number(process.env.SUPERAGENT_MOTION_MAX_RENDERERS ?? "2");
  if (!Number.isSafeInteger(value) || value < 1 || value > 4) {
    throw new Error("SUPERAGENT_MOTION_MAX_RENDERERS must be an integer from 1 to 4");
  }
  return value;
}
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function admissionFile(dir: string) { return path.join(dir, ".admission.lock"); }
function slotFile(dir: string, slot: number) { return path.join(dir, ".render-slot-" + slot + ".lock"); }

export async function withMotionQueueAdmission<T>(dir: string, operation: () => Promise<T>): Promise<T> {
  let lock: Awaited<ReturnType<typeof fs.open>> | undefined;
  for (let attempt = 0; attempt < 80; attempt++) {
    try { lock = await fs.open(admissionFile(dir), "wx", 0o600); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await sleep(50);
    }
  }
  if (!lock) throw new Error("Motion queue admission lock is busy; manual inspection may be required");
  try { return await operation(); }
  finally {
    await lock.close();
    await fs.rm(admissionFile(dir), { force: true });
  }
}
export async function assertMotionQueueCapacity(dir: string): Promise<void> {
  const files = await fs.readdir(dir);
  let queued = 0;
  for (const file of files) {
    if (!/^motionjob-[a-f0-9]{24}\.json$/.test(file)) continue;
    try {
      const stat = await fs.lstat(path.join(dir, file));
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 100_000) continue;
      const job = JSON.parse(await fs.readFile(path.join(dir, file), "utf8")) as Partial<MotionJob>;
      if (job.status === "queued") queued++;
    } catch { /* corrupt/foreign records aren't admitted as valid jobs */ }
  }
  if (queued >= MOTION_QUEUE_LIMIT) throw new Error("Motion render queue full (12 queued jobs per workspace)");
}
export interface MotionSlot {
  slot: number;
  release(): Promise<void>;
}
export async function acquireMotionRenderSlot(
  dir: string, jobId: string, options: { signal?: AbortSignal; cancelled?: () => Promise<boolean>; maxWaitMs?: number } = {},
): Promise<MotionSlot> {
  if (!/^motionjob-[a-f0-9]{24}$/.test(jobId)) throw new Error("Invalid Motion job id");
  const max = motionConcurrentSlots();
  const waitMs = options.maxWaitMs ?? 900_000;
  if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 900_000) throw new Error("Invalid Motion slot wait limit");
  const start = Date.now();
  for (;;) {
    if (options.signal?.aborted || await options.cancelled?.()) throw new Error("Motion render cancelled");
    for (let slot = 0; slot < max; slot++) {
      let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
      const file = slotFile(dir, slot);
      try { handle = await fs.open(file, "wx", 0o600); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        continue;
      }
      try {
        await handle.writeFile(JSON.stringify({ jobId, pid: process.pid, startedAt: new Date().toISOString() }) + "\n");
        await handle.sync();
      } catch (error) {
        await handle.close();
        await fs.rm(file, { force: true });
        throw error;
      }
      await handle.close();
      let released = false;
      return {
        slot,
        async release() {
          if (released) return;
          released = true;
          // Never erase another job's slot lock after an operator action.
          const stat = await fs.lstat(file);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1000) throw new Error("Unsafe Motion slot claim");
          const claim = JSON.parse(await fs.readFile(file, "utf8")) as { jobId?: string };
          if (claim.jobId !== jobId) throw new Error("Motion slot changed ownership");
          await fs.rm(file);
        },
      };
    }
    if (Date.now() - start >= waitMs) throw new Error("Motion render slot wait timed out; inspect stuck worker claims");
    await sleep(180);
  }
}
export async function inspectMotionSlots(dir: string): Promise<Array<{ slot: number; jobId?: string; state: string }>> {
  const found = [];
  for (let slot = 0; slot < motionConcurrentSlots(); slot++) {
    const file = slotFile(dir, slot);
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1000) {
        found.push({ slot, state: "unsafe_or_unreadable" });
        continue;
      }
      const claim = JSON.parse(await fs.readFile(file, "utf8")) as { jobId?: string };
      found.push({ slot, jobId: claim.jobId, state: "claimed_unverified" });
    } catch (error) {
      found.push({ slot, state: (error as NodeJS.ErrnoException).code === "ENOENT" ? "free" : "unsafe_or_unreadable" });
    }
  }
  return found;
}
