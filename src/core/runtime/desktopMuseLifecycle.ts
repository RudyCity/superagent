/**
 * Core-local Muse Watch lifecycle: preserve the owning watcher instance,
 * its agent/callback bindings and transport options across explicit restart.
 *
 * No remote PID termination, no queue replay, no cross-process takeover.
 */
import type { MuseWatcher } from "../remoteAgent/museWatcher.js";

type MuseLifecycleAction = "stop" | "restart";
type Watcher = Pick<MuseWatcher, "getStats" | "isActive" | "hasActiveBatch" | "stop" | "start">;

export async function transitionCoreMuseWatcher(
  watcher: Watcher | null, action: MuseLifecycleAction,
): Promise<{success:true; action:MuseLifecycleAction; state:"stopped"|"running"}> {
  if (!watcher) throw new Error("No Core-owned Muse Watch instance is registered");
  if (action !== "stop" && action !== "restart") {
    throw new Error("Unknown Muse lifecycle action");
  }
  const stats = watcher.getStats();
  if (stats.activeTaskId || (stats.queuedBatches ?? 0) > 0 || watcher.hasActiveBatch()) {
    throw new Error("Muse has an active or queued batch. Stop/restart rejected; no task was aborted or replayed");
  }
  if (action === "stop") {
    if (!watcher.isActive()) {
      throw new Error("Muse Watch is already stopped");
    }
    await watcher.stop();
    return {success:true, action, state:"stopped"};
  }
  if (stats.tunnel) {
    throw new Error("Muse owns a public tunnel. Restart here could change its URL; use the operator's tunnel migration flow");
  }
  if (watcher.isActive()) await watcher.stop();
  await watcher.start();
  return {success:true, action, state:"running"};
}

let lifecycleInProgress = false;
export async function controlCoreLocalMuse(
  action: string, expectedPid: number,
): Promise<{success:true;action:MuseLifecycleAction;state:"stopped"|"running"}> {
  if (expectedPid !== process.pid) {
    throw new Error("Owner PID mismatch; Muse lifecycle was not touched");
  }
  if (!["stop", "restart"].includes(action)) {
    throw new Error("Unsupported Muse lifecycle action");
  }
  if (lifecycleInProgress) {
    throw new Error("Muse lifecycle change already in progress");
  }
  lifecycleInProgress = true;
  try {
    const {getMuseWatcher} = await import("../remoteAgent/museWatcherRegistry.js");
    return await transitionCoreMuseWatcher(getMuseWatcher(), action as MuseLifecycleAction);
  } finally {
    lifecycleInProgress = false;
  }
}
