import { MOTION_SCHEMA_VERSION } from "./types.js";
import type { MotionEdit, MotionKeyframe, MotionProject, MotionTrack } from "./types.js";

export class MotionValidationError extends Error {
  constructor(public readonly diagnostics: string[]) {
    super("Invalid Motion Studio data: " + diagnostics.join("; "));
    this.name = "MotionValidationError";
  }
}

const color = /^#[0-9a-fA-F]{6}$/;
const id = /^[a-z][a-z0-9-]{1,63}$/;
const propertyNames = new Set(["x", "y", "opacity", "rotation"]);
const easingNames = new Set(["linear", "step", "easeInOut", "easeOutBack"]);
const fontNames = new Set(["Arial", "Helvetica", "Georgia", "Verdana", "sans-serif", "serif", "monospace"]);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function allowedKeys(value: Record<string, unknown>, keys: string[], location: string, errors: string[]): void {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) errors.push(location + ": unsupported field " + key);
  }
}
function finite(value: unknown, min: number, max: number): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}
function integer(value: unknown, min: number, max: number): boolean {
  return Number.isSafeInteger(value) && finite(value, min, max);
}
function string(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

export function validateMotionTrack(raw: unknown, durationFrames: number, at = "track"): string[] {
  const errors: string[] = [];
  if (!record(raw)) return [at + ": expected object"];
  allowedKeys(raw, ["property", "keyframes"], at, errors);
  if (!propertyNames.has(String(raw.property))) errors.push(at + ": unsupported property");
  if (!Array.isArray(raw.keyframes) || raw.keyframes.length < 1 || raw.keyframes.length > 1024) {
    errors.push(at + ": keyframes must contain 1-1024 items");
    return errors;
  }
  let previousFrame = -1;
  raw.keyframes.forEach((keyframe: unknown, index: number) => {
    const location = at + ".keyframes[" + index + "]";
    if (!record(keyframe)) { errors.push(location + ": expected object"); return; }
    allowedKeys(keyframe, ["frame", "value", "easing"], location, errors);
    if (!integer(keyframe.frame, 0, durationFrames - 1) || Number(keyframe.frame) <= previousFrame) {
      errors.push(location + ": frames must be integers, increasing and inside composition");
    } else previousFrame = keyframe.frame as number;
    const range = raw.property === "opacity" ? [0, 1] : raw.property === "rotation" ? [-36000, 36000] : [-100000, 100000];
    if (!finite(keyframe.value, range[0], range[1])) errors.push(location + ": invalid value");
    if (keyframe.easing !== undefined && !easingNames.has(String(keyframe.easing))) errors.push(location + ": invalid easing");
    if (keyframe.easing === "easeOutBack" && raw.property === "opacity") errors.push(location + ": overshoot easing cannot affect opacity");
  });
  return errors;
}

export function validateMotionAudio(raw: unknown, durationFrames: number): string[] {
  if (!record(raw)) return ["audio: expected object"];
  const errors: string[] = [];
  allowedKeys(raw, ["assetId", "startFrame", "volume", "fadeInFrames", "fadeOutFrames", "loop", "role"], "audio", errors);
  if (typeof raw.assetId !== "string" || !/^audio-[a-f0-9]{64}$/.test(raw.assetId)) errors.push("audio: invalid assetId");
  if (!integer(raw.startFrame, 0, durationFrames - 1)) errors.push("audio: invalid startFrame");
  if (!finite(raw.volume, 0, 2)) errors.push("audio: invalid volume");
  if (raw.loop !== undefined && typeof raw.loop !== "boolean") errors.push("audio: invalid loop");
  if (raw.role !== undefined && raw.role !== "music" && raw.role !== "voiceover") errors.push("audio: invalid role");
  if (raw.fadeInFrames !== undefined && !integer(raw.fadeInFrames, 0, durationFrames)) errors.push("audio: invalid fadeInFrames");
  if (raw.fadeOutFrames !== undefined && !integer(raw.fadeOutFrames, 0, durationFrames)) errors.push("audio: invalid fadeOutFrames");
  return errors;
}

export function validateMotionProject(raw: unknown): asserts raw is MotionProject {
  const errors: string[] = [];
  if (!record(raw)) throw new MotionValidationError(["project must be an object"]);
  allowedKeys(raw, ["schemaVersion", "id", "workspaceRoot", "name", "revision", "createdAt", "updatedAt", "composition"], "project", errors);
  if (raw.schemaVersion !== MOTION_SCHEMA_VERSION) errors.push("unsupported schemaVersion");
  if (!string(raw.id, 64) || !id.test(raw.id)) errors.push("invalid project id");
  if (!string(raw.workspaceRoot, 4096)) errors.push("workspaceRoot is required");
  if (!string(raw.name, 160)) errors.push("name must be 1-160 characters");
  if (!integer(raw.revision, 1, 2_000_000_000)) errors.push("invalid revision");
  for (const field of ["createdAt", "updatedAt"]) {
    if (!string(raw[field], 64) || !Number.isFinite(Date.parse(raw[field] as string))) errors.push("invalid " + field);
  }
  const c = raw.composition;
  if (!record(c)) {
    errors.push("composition is required");
  } else {
    allowedKeys(c, ["width", "height", "fps", "durationFrames", "background", "layers", "audio", "audioTracks", "effectStack", "stackBase"], "composition", errors);
    if (c.effectStack !== undefined || c.stackBase !== undefined) {
      if (!Array.isArray(c.effectStack) || !record(c.stackBase)) {
        errors.push("effectStack and stackBase must both be present");
      } else {
        if (c.effectStack.length > 24) errors.push("effectStack must have at most 24 entries");
        const seen = new Set<string>();
        c.effectStack.forEach((value: unknown, i: number) => {
          const at = "effectStack[" + i + "]";
          if (!record(value)) { errors.push(at + ": expected object"); return; }
          allowedKeys(value, ["id", "effectId", "enabled", "targetLayerId", "params", "startFrame", "durationFrames"], at, errors);
          if (!string(value.id, 64) || !id.test(value.id) || seen.has(value.id)) errors.push(at + ": invalid/duplicate stack entry id");
          else seen.add(value.id);
          if (!string(value.effectId, 64) || !id.test(value.effectId)) errors.push(at + ": invalid effectId");
          if (typeof value.enabled !== "boolean") errors.push(at + ": enabled must be boolean");
          if (value.targetLayerId !== undefined && (!string(value.targetLayerId, 64) || !id.test(value.targetLayerId))) errors.push(at + ": invalid targetLayerId");
          if (value.startFrame !== undefined && !integer(value.startFrame, 0, Number(c.durationFrames) - 1)) errors.push(at + ": invalid start frame");
          if (value.durationFrames !== undefined && !integer(value.durationFrames, 1, Number(c.durationFrames))) errors.push(at + ": invalid duration");
          if (value.params !== undefined) {
            if (!record(value.params) || Object.keys(value.params).length > 32) errors.push(at + ": invalid params");
            else for (const [key, val] of Object.entries(value.params)) {
              if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(key) || key.length > 64 || !(typeof val === "boolean" ||
                  (typeof val === "number" && Number.isFinite(val)) ||
                  (typeof val === "string" && val.length <= 256 && !/[<>]/.test(val)))) errors.push(at + ": invalid parameter " + key);
            }
          }
        });
        const rawBase = c.stackBase;
        if (record(rawBase)) {
          if (rawBase.effectStack !== undefined || rawBase.stackBase !== undefined) errors.push("stackBase cannot nest stacks");
          if (rawBase.width !== c.width || rawBase.height !== c.height ||
              rawBase.durationFrames !== c.durationFrames || JSON.stringify(rawBase.fps) !== JSON.stringify(c.fps)) {
            errors.push("stackBase dimensions, duration and fps must match composition");
          }
          try { validateMotionProject({ ...raw, composition: rawBase }); }
          catch (cause) {
            errors.push("stackBase: " + (cause instanceof Error ? cause.message : String(cause)));
          }
        }
      }
    }
    if (!integer(c.width, 16, 8192) || !integer(c.height, 16, 8192)) errors.push("invalid dimensions");
    if (!integer(c.durationFrames, 1, 216000)) errors.push("durationFrames must be 1-216000");
    if (typeof c.background !== "string" || !color.test(c.background)) errors.push("invalid background color");
    if (c.audio !== undefined) errors.push(...validateMotionAudio(c.audio, c.durationFrames as number));
    if (c.audio !== undefined && c.audioTracks !== undefined) errors.push("audio and audioTracks cannot both be present");
    if (c.audioTracks !== undefined) {
      if (!Array.isArray(c.audioTracks) || c.audioTracks.length > 4) errors.push("audioTracks must have at most 4 clips");
      else c.audioTracks.forEach((track: unknown, index: number) =>
        errors.push(...validateMotionAudio(track, c.durationFrames as number).map(issue => "audioTracks[" + index + "]: " + issue)));
    }
    if (!record(c.fps) || !integer(c.fps.numerator, 1, 240000) || !integer(c.fps.denominator, 1, 1001) ||
      Number(c.fps.numerator) / Number(c.fps.denominator) > 240 || Number(c.fps.numerator) / Number(c.fps.denominator) < 1) {
      errors.push("invalid rational fps");
    } else allowedKeys(c.fps, ["numerator", "denominator"], "fps", errors);
    if (!Array.isArray(c.layers) || c.layers.length > 200) {
      errors.push("layers must be an array of up to 200");
    } else {
      const layerIds = new Set<string>();
      c.layers.forEach((layer: unknown, i) => {
        const at = "layers[" + i + "]";
        if (!record(layer)) { errors.push(at + ": expected object"); return; }
        const kind = layer.kind;
        const common = ["id", "kind", "x", "y", "width", "height", "rotation", "opacity", "fill", "tracks"];
        allowedKeys(layer, kind === "text" ? [...common, "text", "fontSize", "fontFamily"] :
          kind === "image" ? [...common, "assetId"] :
          kind === "rect" ? [...common, "cornerRadius"] : common, at, errors);
        if (kind !== "text" && kind !== "rect" && kind !== "image") errors.push(at + ": unsupported layer kind");
        if (kind === "rect" && layer.cornerRadius !== undefined &&
            (!finite(layer.cornerRadius, 0, 4096) ||
              !finite(layer.width, 1, 100000) || !finite(layer.height, 1, 100000) ||
              Number(layer.cornerRadius) > Math.min(Number(layer.width), Number(layer.height)) / 2)) {
          errors.push(at + ": invalid cornerRadius");
        }
        if (kind === "image" && (typeof layer.assetId !== "string" || !/^asset-[a-f0-9]{64}$/.test(layer.assetId))) {
          errors.push(at + ": invalid image assetId");
        }
        if (!string(layer.id, 64) || !id.test(layer.id) || layerIds.has(layer.id)) errors.push(at + ": invalid or duplicate layer id");
        else layerIds.add(layer.id);
        if (!finite(layer.x, -100000, 100000) || !finite(layer.y, -100000, 100000) ||
          !finite(layer.width, 1, 100000) || !finite(layer.height, 1, 100000)) errors.push(at + ": invalid geometry");
        if (!finite(layer.rotation, -36000, 36000) || !finite(layer.opacity, 0, 1)) errors.push(at + ": invalid transform/opacity");
        if (typeof layer.fill !== "string" || !color.test(layer.fill)) errors.push(at + ": invalid fill");
        if (kind === "text") {
          if (typeof layer.text !== "string" || layer.text.length > 8192) errors.push(at + ": invalid text");
          if (!finite(layer.fontSize, 1, 512) || !fontNames.has(String(layer.fontFamily))) errors.push(at + ": invalid font");
        }
        if (!Array.isArray(layer.tracks) || layer.tracks.length > 4) errors.push(at + ": invalid tracks");
        else {
          const seen = new Set<string>();
          layer.tracks.forEach((track: unknown, index) => {
            if (record(track) && typeof track.property === "string") {
              if (seen.has(track.property)) errors.push(at + ": duplicate animated property");
              seen.add(track.property);
            }
            if (integer(c.durationFrames, 1, 216000)) errors.push(...validateMotionTrack(track, c.durationFrames as number, at + ".tracks[" + index + "]"));
          });
        }
      });
    }
  }
  if (errors.length) throw new MotionValidationError(errors);
}

export function validateMotionEdits(raw: unknown, durationFrames: number): asserts raw is MotionEdit[] {
  const errors: string[] = [];
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 50) throw new MotionValidationError(["edits must contain 1-50 operations"]);
  raw.forEach((edit: unknown, i) => {
    const at = "edits[" + i + "]";
    if (!record(edit)) { errors.push(at + ": expected object"); return; }
    if (edit.type === "add-layer") {
      allowedKeys(edit, ["type", "layer", "index"], at, errors);
      if (!record(edit.layer)) errors.push(at + ": layer must be an object");
      if (edit.index !== undefined && !integer(edit.index, 0, 200)) errors.push(at + ": invalid insertion index");
      return;
    }
    if (edit.type === "set-audio-tracks") {
      allowedKeys(edit, ["type", "audioTracks"], at, errors);
      if (!Array.isArray(edit.audioTracks) || edit.audioTracks.length > 4) errors.push(at + ": audioTracks must have at most 4 clips");
      else edit.audioTracks.forEach((track: unknown, index: number) =>
        errors.push(...validateMotionAudio(track, durationFrames).map(issue => at + ".audioTracks[" + index + "]: " + issue)));
      return;
    }
    if (edit.type === "set-audio") {
      allowedKeys(edit, ["type", "audio"], at, errors);
      if (edit.audio !== null) errors.push(...validateMotionAudio(edit.audio, durationFrames));
      return;
    }
    if (edit.type === "replace-composition") {
      allowedKeys(edit, ["type", "composition"], at, errors);
      if (!record(edit.composition)) errors.push(at + ": composition must be an object");
      return;
    }
    if (!string(edit.layerId, 64) || !id.test(edit.layerId)) errors.push(at + ": invalid layerId");
    if (edit.type === "remove-layer") {
      allowedKeys(edit, ["type", "layerId"], at, errors);
    } else if (edit.type === "move-layer") {
      allowedKeys(edit, ["type", "layerId", "toIndex"], at, errors);
      if (!integer(edit.toIndex, 0, 199)) errors.push(at + ": invalid target index");
    } else if (edit.type === "set-text") {
      allowedKeys(edit, ["type", "layerId", "text"], at, errors);
      if (typeof edit.text !== "string" || edit.text.length > 8192) errors.push(at + ": invalid text");
    } else if (edit.type === "set-property") {
      allowedKeys(edit, ["type", "layerId", "property", "value"], at, errors);
      const p = String(edit.property);
      if (!propertyNames.has(p)) errors.push(at + ": invalid property");
      const range = p === "opacity" ? [0, 1] : p === "rotation" ? [-36000, 36000] : [-100000, 100000];
      if (!finite(edit.value, range[0], range[1])) errors.push(at + ": invalid value");
    } else if (edit.type === "set-track") {
      allowedKeys(edit, ["type", "layerId", "track"], at, errors);
      errors.push(...validateMotionTrack(edit.track, durationFrames, at + ".track"));
    } else errors.push(at + ": unknown operation");
  });
  if (errors.length) throw new MotionValidationError(errors);
}
