import type { MuseWatcher } from "./museWatcher.js";
import type { MuseWatcherOptions } from "./museWatcherTypes.js";

const activeWatchers = new Map<number, MuseWatcher>();
let globalMuseWatcher: MuseWatcher | null = null;

export function getMuseWatcher(port?: number): MuseWatcher | null {
  if (port && activeWatchers.has(port)) {
    return activeWatchers.get(port) || null;
  }
  return globalMuseWatcher;
}

export function isMuseWatcherActive(port?: number): boolean {
  if (port) {
    const watcher = activeWatchers.get(port);
    return Boolean(watcher && watcher.isActive());
  }
  return Boolean(globalMuseWatcher && globalMuseWatcher.isActive());
}

export async function startMuseWatcher(options: MuseWatcherOptions = {}): Promise<MuseWatcher> {
  const isHttpsMode = options.transportType === "https" || options.isHttps;
  const effectivePort = options.wsPort || (isHttpsMode ? 7888 : 9225);

  const existing = activeWatchers.get(effectivePort);
  if (existing && existing.isActive()) {
    if (options.workspaces && options.workspaces.length > 0) {
      for (const w of options.workspaces) {
        existing.addWorkspace(w);
      }
    } else if (options.workspace) {
      existing.addWorkspace(options.workspace);
    }
    return existing;
  }

  const { MuseWatcher } = await import("./museWatcher.js");
  const watcher = new MuseWatcher(options);
  await watcher.start();
  activeWatchers.set(effectivePort, watcher);
  globalMuseWatcher = watcher;
  return watcher;
}

export async function stopMuseWatcher(port?: number): Promise<boolean> {
  if (port) {
    const watcher = activeWatchers.get(port);
    if (!watcher) {
      return false;
    }
    await watcher.stop();
    activeWatchers.delete(port);
    if (globalMuseWatcher === watcher) {
      globalMuseWatcher = activeWatchers.values().next().value || null;
    }
    return true;
  }

  if (globalMuseWatcher) {
    const target = globalMuseWatcher;
    for (const [p, w] of activeWatchers.entries()) {
      if (w === target) {
        activeWatchers.delete(p);
      }
    }
    await target.stop();
    globalMuseWatcher = activeWatchers.values().next().value || null;
    return true;
  }

  return false;
}

export async function stopAllMuseWatchers(): Promise<number> {
  const watchers = Array.from(activeWatchers.values());
  activeWatchers.clear();
  globalMuseWatcher = null;
  let count = 0;
  for (const w of watchers) {
    try {
      await w.stop();
      count++;
    } catch {}
  }
  return count;
}

export function hasActiveMuseBatch(): boolean {
  return Boolean(globalMuseWatcher && globalMuseWatcher.hasActiveBatch());
}

export function abortActiveMuseBatch(reason?: string): boolean {
  if (!globalMuseWatcher) return false;
  return globalMuseWatcher.abortActiveBatch(reason);
}

export async function sendMuseSteerMessage(text: string): Promise<boolean> {
  if (!globalMuseWatcher) return false;
  return await globalMuseWatcher.sendSteeringMessage(text);
}
