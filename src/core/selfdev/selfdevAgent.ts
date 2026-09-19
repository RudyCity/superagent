/**
 * selfdevAgent.ts — Agent-side self-development integration wiring.
 *
 * Creates a per-agent SelfDevCollector backed by the shared SQLite history DB,
 * records task lifecycle events (task_started, task_completed, task_failed),
 * and builds the prompt injection block for approved lessons.
 *
 * All functions silently swallow errors so selfdev activity never breaks
 * the normal agent execution path.
 */

import type { SelfDevEventInput } from "./types.js";

/** Lazily-initialized singleton collector bound to the shared history DB. */
let _collector: import("./collector.js").SelfDevCollector | null = null;

async function getCollector(): Promise<import("./collector.js").SelfDevCollector | null> {
  if (_collector) return _collector;
  try {
    const { getSelfDevConfig } = await import("./settings.js");
    const cfg = getSelfDevConfig();
    if (!cfg.enabled) return null;

    const { getHistoryDb } = await import("../storage/historyDb.js");
    const { SelfDevEventStore } = await import("./eventStore.js");
    const { SelfDevCollector } = await import("./collector.js");

    const store = new SelfDevEventStore({
      workspace: process.cwd(),
      getDb: () => getHistoryDb() as any,
      config: cfg,
    });
    _collector = new SelfDevCollector(store);
  } catch {
    // silently fail
  }
  return _collector;
}

/** Records a selfdev event. Returns silently on error. */
export async function recordSelfDevEvent(input: SelfDevEventInput): Promise<void> {
  try {
    const collector = await getCollector();
    if (!collector) return;
    collector.record(input);
  } catch {
    // silently fail
  }
}

/** Reset the cached collector (e.g. when workspace changes). */
export function resetSelfDevCollector(): void {
  _collector = null;
}

/**
 * Builds the prompt injection block from approved lessons for the given workspace.
 * Returns empty string when selfdev is disabled or no lessons are approved.
 * Never throws.
 */
export async function buildSelfDevInjectionBlock(workspace: string): Promise<string> {
  try {
    const { getSelfDevConfig } = await import("./settings.js");
    const cfg = getSelfDevConfig();
    if (!cfg.enabled || !cfg.injectionEnabled) return "";

    const { buildPromptInjectionBlock } = await import("./injector.js");
    const { getSelfDevLessonsPath } = await import("../config/paths.js");
    const storePath = getSelfDevLessonsPath();

    return await buildPromptInjectionBlock({
      workspace,
      storePath,
      config: cfg,
    });
  } catch {
    return "";
  }
}
