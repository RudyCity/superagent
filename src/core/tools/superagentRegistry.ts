/**
 * superagentRegistry.ts — Lightweight JSON journal of Superagent worktrees.
 *
 * Persists one entry per spawned Superagent so that crash-orphaned worktrees
 * can be reconciled after a restart: entries whose worktree directory still
 * exists are rehydrated into the shared instance map (completed ones stay
 * consumable by merge_superagents, failed ones become retryable), while
 * entries whose worktree directory vanished are dropped.
 */

import fs from "fs";
import path from "path";
import { getRootConfigDir } from "../config.js";
import { SuperagentInstance } from "./types.js";

export type RegistryStatus = SuperagentInstance["status"];

export interface SuperagentRegistryEntry {
  id: string;
  name: string;
  role: string;
  branch: string;
  worktreePath: string;
  baseCommit?: string;
  status: RegistryStatus;
  updatedAt: number;
}

export interface ReconcileResult {
  rehydratedIds: string[];
  droppedIds: string[];
}

export function getWorktreeRegistryPath(): string {
  return path.join(getRootConfigDir(), "worktree-registry.json");
}

export function loadRegistry(): SuperagentRegistryEntry[] {
  try {
    const filePath = getWorktreeRegistryPath();
    if (!fs.existsSync(filePath)) return [];
    const content = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is SuperagentRegistryEntry =>
        e && typeof e.id === "string" && typeof e.worktreePath === "string"
    );
  } catch {
    return [];
  }
}

function saveRegistry(entries: SuperagentRegistryEntry[]): void {
  const filePath = getWorktreeRegistryPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(entries, null, 2), "utf-8");
}

export function upsertEntry(entry: SuperagentRegistryEntry): void {
  try {
    const entries = loadRegistry().filter((e) => e.id !== entry.id);
    entries.push({ ...entry, updatedAt: entry.updatedAt || Date.now() });
    saveRegistry(entries);
  } catch {
    // Registry journaling is best-effort — never crash the agent
  }
}

export function removeEntries(ids: string[]): void {
  if (!ids || ids.length === 0) return;
  try {
    const idSet = new Set(ids);
    const remaining = loadRegistry().filter((e) => !idSet.has(e.id));
    saveRegistry(remaining);
  } catch {
    // Best-effort
  }
}

/**
 * Reconciles the persisted registry against an in-memory instance map:
 *  - Entries whose worktree dir still exists and are missing from the map are
 *    rehydrated as minimal instances with their persisted status.
 *  - Entries whose worktree dir is gone are dropped from the registry.
 *
 * Non-terminal persisted statuses ("running"/"waiting"/"paused") mean the
 * owning process died in a crash, so they are restored as "error" to keep
 * them retryable instead of blocking await_superagents forever.
 */
export function reconcileRegistry(instances: Map<string, SuperagentInstance>): ReconcileResult {
  const result: ReconcileResult = { rehydratedIds: [], droppedIds: [] };
  let dirty = false;
  for (const entry of loadRegistry()) {
    if (instances.has(entry.id)) continue;
    if (!entry.worktreePath || !fs.existsSync(entry.worktreePath)) {
      result.droppedIds.push(entry.id);
      dirty = true;
      continue;
    }
    const isTerminal = entry.status === "completed" || entry.status === "error" || entry.status === "terminated";
    const rehydrated: SuperagentInstance = {
      id: entry.id,
      role: entry.role,
      task: `(restored from worktree registry) ${entry.name}`,
      branch: entry.branch,
      worktreePath: entry.worktreePath,
      agent: undefined as any,
      status: isTerminal ? entry.status : "error",
      logs: [],
    };
    instances.set(entry.id, rehydrated);
    result.rehydratedIds.push(entry.id);
  }
  if (dirty) {
    removeEntries(result.droppedIds);
  }
  return result;
}
