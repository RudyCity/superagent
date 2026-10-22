import type { MotionComposition, MotionProject, MotionStackEntry } from "../schema/types.js";
import { MotionValidationError, validateMotionProject } from "../schema/validation.js";
import { effectRegistry } from "./index.js";

/** Builds visible tracks from a preserved immutable source composition. Each
 * operation is deterministic and the previous source never gets modified.
 * Renderer and frame preview consume exactly the same compiled layers.
 */
export function compileMotionEffectStack(project: MotionProject, entries: MotionStackEntry[]): MotionComposition {
  if (!Array.isArray(entries) || entries.length > 24) {
    throw new MotionValidationError(["Effect stack must contain at most 24 entries"]);
  }
  const original: MotionComposition = structuredClone(project.composition.stackBase ?? project.composition);
  delete original.effectStack;
  delete original.stackBase;
  let current: MotionProject = { ...project, composition: structuredClone(original) };
  const ids = new Set<string>();
  for (const entry of entries) {
    if (!/^[a-z][a-z0-9-]{1,63}$/.test(entry.id) || typeof entry.enabled !== "boolean" ||
        !/^[a-z][a-z0-9-]{1,63}$/.test(entry.effectId)) {
      throw new MotionValidationError(["Invalid effect stack entry"]);
    }
    if (ids.has(entry.id)) throw new MotionValidationError(["Duplicate effect stack entry: " + entry.id]);
    ids.add(entry.id);
    if (!entry.enabled) continue;
    current = effectRegistry.applyToProject(current, {
      effectId: entry.effectId,
      targetLayerId: entry.targetLayerId,
      params: entry.params,
      startFrame: entry.startFrame,
      durationFrames: entry.durationFrames,
    });
  }
  const result: MotionComposition = {
    ...current.composition,
    effectStack: structuredClone(entries),
    stackBase: original,
  };
  validateMotionProject({ ...project, composition: result });
  return result;
}

export type MotionStackOperation =
  | { type: "add"; entry: MotionStackEntry }
  | { type: "remove"; id: string }
  | { type: "toggle"; id: string; enabled: boolean }
  | { type: "move"; id: string; toIndex: number }
  | { type: "update"; id: string; changes: Partial<Omit<MotionStackEntry, "id">> };

export function changeMotionEffectStack(project: MotionProject, operation: MotionStackOperation): MotionComposition {
  validateMotionProject(project);
  let entries = structuredClone(project.composition.effectStack ?? []);
  const index = "id" in operation ? entries.findIndex(item => item.id === operation.id) : -1;
  if (operation.type === "add") {
    if (entries.length >= 24) throw new MotionValidationError(["Effect stack is full"]);
    if (entries.some(item => item.id === operation.entry.id)) throw new MotionValidationError(["Duplicate stack ID"]);
    entries.push(structuredClone(operation.entry));
  } else {
    if (index < 0) throw new MotionValidationError(["Stack entry not found"]);
    if (operation.type === "remove") entries.splice(index, 1);
    else if (operation.type === "toggle") entries[index].enabled = operation.enabled;
    else if (operation.type === "update") {
      if (!operation.changes || Object.keys(operation.changes).some(k =>
        !["enabled", "effectId", "targetLayerId", "params", "startFrame", "durationFrames"].includes(k))) {
        throw new MotionValidationError(["Invalid effect stack update"]);
      }
      entries[index] = { ...entries[index], ...operation.changes };
    }
    else if (operation.type === "move") {
      if (!Number.isSafeInteger(operation.toIndex) || operation.toIndex < 0 || operation.toIndex >= entries.length)
        throw new MotionValidationError(["Invalid effect stack position"]);
      const [entry] = entries.splice(index, 1);
      entries.splice(operation.toIndex, 0, entry);
    }
  }
  return compileMotionEffectStack(project, entries);
}
