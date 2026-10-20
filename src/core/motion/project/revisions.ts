import type { MotionEdit, MotionProject, MotionTrack } from "../schema/types.js";
import { validateMotionEdits, validateMotionProject } from "../schema/validation.js";

export class MotionRevisionConflict extends Error {
  constructor(public readonly expected: number, public readonly actual: number) {
    super(`Motion project revision conflict: expected ${expected}, current ${actual}`);
    this.name = "MotionRevisionConflict";
  }
}

/** Applies a validated semantic transaction, never mutating the input revision. */
export function applyMotionEdits(project: MotionProject, baseRevision: number, operations: MotionEdit[]): MotionProject {
  validateMotionProject(project);
  if (baseRevision !== project.revision) throw new MotionRevisionConflict(baseRevision, project.revision);
  validateMotionEdits(operations, project.composition.durationFrames);
  const next: MotionProject = structuredClone(project);
  for (const operation of operations) {
    const layer = next.composition.layers.find(item => item.id === operation.layerId);
    if (!layer) throw new Error("Motion layer not found: " + operation.layerId);
    if (operation.type === "set-text") {
      if (layer.kind !== "text") throw new Error("Cannot edit text on a non-text layer");
      layer.text = operation.text;
    } else if (operation.type === "set-property") {
      layer[operation.property] = operation.value;
    } else {
      const track: MotionTrack = structuredClone(operation.track);
      const position = layer.tracks.findIndex(item => item.property === track.property);
      if (position >= 0) layer.tracks[position] = track;
      else layer.tracks.push(track);
    }
  }
  next.revision++;
  next.updatedAt = new Date().toISOString();
  validateMotionProject(next);
  return next;
}
