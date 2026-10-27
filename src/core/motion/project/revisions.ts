import type { MotionEdit, MotionProject, MotionTrack } from "../schema/types.js";
import { validateMotionEdits, validateMotionProject } from "../schema/validation.js";
import { compileMotionEffectStack } from "../effects/effectStack.js";

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
  // Edit the preserved source and rebuild instead of mutating the baked
  // render output. Replace-composition intentionally restores an exact snapshot.
  if (project.composition.effectStack && project.composition.stackBase &&
      operations.every(op => op.type !== "replace-composition")) {
    const sourceProject: MotionProject = { ...structuredClone(project),
      composition: structuredClone(project.composition.stackBase) };
    const editedSource = applyMotionEdits(sourceProject, baseRevision, operations);
    editedSource.composition = compileMotionEffectStack(editedSource, project.composition.effectStack);
    validateMotionProject(editedSource);
    return editedSource;
  }
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
    if (operation.type === "set-interaction-graph") {
      if (operation.graph === null) delete next.composition.interactionGraph;
      else next.composition.interactionGraph = structuredClone(operation.graph);
      continue;
    }
    if (operation.type === "replace-composition") {
      next.composition = structuredClone(operation.composition);
      continue;
    }
    if (operation.type === "set-tracks") {
      next.composition.tracks = structuredClone(operation.tracks);
      continue;
    }
    if (operation.type === "split-clip") {
      if (!next.composition.tracks) throw new Error("No tracks found in composition");
      const track = next.composition.tracks.find(t => t.id === operation.trackId);
      if (!track) throw new Error("Track not found: " + operation.trackId);
      const clipIndex = track.clips.findIndex(c => c.id === operation.clipId);
      if (clipIndex < 0) throw new Error("Clip not found: " + operation.clipId);
      const clip = track.clips[clipIndex];
      const relFrame = operation.splitFrame - clip.startFrame;
      if (relFrame <= 0 || relFrame >= clip.durationFrames) {
        throw new Error("splitFrame must be strictly inside clip duration");
      }
      const firstDuration = relFrame;
      const secondDuration = clip.durationFrames - relFrame;
      const firstClip = {
        ...structuredClone(clip),
        durationFrames: firstDuration,
      };
      const secondClip = {
        ...structuredClone(clip),
        id: `${clip.id}-s${next.revision}`,
        name: `${clip.name} (Part 2)`,
        startFrame: operation.splitFrame,
        durationFrames: secondDuration,
        trimInFrames: clip.trimInFrames + firstDuration,
      };
      track.clips.splice(clipIndex, 1, firstClip, secondClip);
      continue;
    }
    if (operation.type === "trim-clip") {
      if (!next.composition.tracks) throw new Error("No tracks found in composition");
      const track = next.composition.tracks.find(t => t.id === operation.trackId);
      if (!track) throw new Error("Track not found: " + operation.trackId);
      const clip = track.clips.find(c => c.id === operation.clipId);
      if (!clip) throw new Error("Clip not found: " + operation.clipId);
      const newDuration = clip.durationFrames - operation.deltaIn + operation.deltaOut;
      if (newDuration < 1) throw new Error("Trim would result in non-positive duration");
      clip.startFrame += operation.deltaIn;
      clip.durationFrames = newDuration;
      clip.trimInFrames = Math.max(0, clip.trimInFrames + operation.deltaIn);
      clip.trimOutFrames = Math.max(0, clip.trimOutFrames + operation.deltaOut);
      continue;
    }
    if (operation.type === "move-clip") {
      if (!next.composition.tracks) throw new Error("No tracks found in composition");
      const fromTrack = next.composition.tracks.find(t => t.id === operation.fromTrackId);
      if (!fromTrack) throw new Error("Source track not found: " + operation.fromTrackId);
      const toTrack = next.composition.tracks.find(t => t.id === operation.toTrackId);
      if (!toTrack) throw new Error("Destination track not found: " + operation.toTrackId);
      const clipIndex = fromTrack.clips.findIndex(c => c.id === operation.clipId);
      if (clipIndex < 0) throw new Error("Clip not found: " + operation.clipId);
      const [clip] = fromTrack.clips.splice(clipIndex, 1);
      clip.trackId = operation.toTrackId;
      clip.startFrame = Math.max(0, operation.newStartFrame);
      toTrack.clips.push(clip);
      toTrack.clips.sort((a, b) => a.startFrame - b.startFrame);
      continue;
    }
    if (operation.type === "delete-clip") {
      if (!next.composition.tracks) throw new Error("No tracks found in composition");
      const track = next.composition.tracks.find(t => t.id === operation.trackId);
      if (!track) throw new Error("Track not found: " + operation.trackId);
      const clipIndex = track.clips.findIndex(c => c.id === operation.clipId);
      if (clipIndex < 0) throw new Error("Clip not found: " + operation.clipId);
      const [deletedClip] = track.clips.splice(clipIndex, 1);
      if (operation.ripple) {
        const shift = deletedClip.durationFrames;
        for (const c of track.clips) {
          if (c.startFrame > deletedClip.startFrame) {
            c.startFrame = Math.max(0, c.startFrame - shift);
          }
        }
      }
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
