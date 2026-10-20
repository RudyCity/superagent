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
    if (operation.type === "set-audio-tracks") {
      delete next.composition.audio;
      next.composition.audioTracks = structuredClone(operation.audioTracks);
      continue;
    }
    if (operation.type === "set-audio") {
      delete next.composition.audioTracks;
      if (operation.audio === null) delete next.composition.audio;
      else next.composition.audio = structuredClone(operation.audio);
      continue;
    }
    if (operation.type === "replace-composition") {
      next.composition = structuredClone(operation.composition);
      continue;
    }
    if (operation.type === "add-layer") {
      const index = operation.index ?? next.composition.layers.length;
      if (index < 0 || index > next.composition.layers.length) throw new Error("Motion insertion index outside layer range");
      if (next.composition.layers.some(item => item.id === operation.layer.id)) throw new Error("Motion layer id already exists");
      next.composition.layers.splice(index, 0, structuredClone(operation.layer));
      continue;
    }
    const layer = next.composition.layers.find(item => item.id === operation.layerId);
    if (!layer) throw new Error("Motion layer not found: " + operation.layerId);
    if (operation.type === "remove-layer") {
      next.composition.layers = next.composition.layers.filter(item => item.id !== operation.layerId);
      continue;
    }
    if (operation.type === "move-layer") {
      if (operation.toIndex < 0 || operation.toIndex >= next.composition.layers.length) throw new Error("Motion target index outside layer range");
      const from = next.composition.layers.findIndex(item => item.id === operation.layerId);
      next.composition.layers.splice(from, 1);
      next.composition.layers.splice(operation.toIndex, 0, layer);
      continue;
    }
    if (operation.type === "set-text") {
      if (layer.kind !== "text") throw new Error("Cannot edit text on a non-text layer");
      layer.text = operation.text;
    } else if (operation.type === "set-property") {
      layer[operation.property] = operation.value;
    } else if (operation.type === "set-track") {
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
