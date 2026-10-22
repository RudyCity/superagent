import { createCanvas } from "@napi-rs/canvas";
import crypto from "node:crypto";
import type { MotionComposition, MotionLayer, MotionProject, MotionTrack } from "./schema/types.js";
import { validateMotionProject, MotionValidationError } from "./schema/validation.js";
import { compileMotionEffectStack } from "./effects/effectStack.js";

export type MotionTypographyStyle = "letter-reveal" | "word-rise";
export interface MotionTypographyInput {
  targetLayerId: string;
  style: MotionTypographyStyle;
  startFrame?: number;
  durationFrames?: number;
}

const measure = createCanvas(1, 1).getContext("2d");
function fragments(text: string, style: MotionTypographyStyle): Array<{ text: string; prefix: string }> {
  if (style === "letter-reveal") {
    // Unicode grapheme clusters: never separate combining marks or emoji ligatures.
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    return [...segmenter.segment(text)].map(part => ({
      text: part.segment, prefix: text.slice(0, part.index),
    })).filter(part => part.text.trim().length > 0);
  }
  return [...text.matchAll(/\S+/gu)].map(match => ({
    text: match[0], prefix: text.slice(0, match.index),
  }));
}
/** Animate text using native, safe Motion text layers. No shader/text HTML.
 * Replaces one text layer with independently timed text fragments; source
 * composition is left untouched, and revision snapshots support Undo.
 */
export function compileMotionTypography(project: MotionProject, input: MotionTypographyInput): MotionComposition {
  validateMotionProject(project);
  if (!input || !["letter-reveal", "word-rise"].includes(input.style) ||
      typeof input.targetLayerId !== "string") {
    throw new MotionValidationError(["Invalid Motion typography request"]);
  }
  const base: MotionComposition = structuredClone(project.composition.stackBase ?? project.composition);
  delete base.effectStack;
  delete base.stackBase;
  const index = base.layers.findIndex(layer => layer.id === input.targetLayerId);
  const original = base.layers[index];
  if (!original || original.kind !== "text") throw new MotionValidationError(["Select an existing text layer"]);
  if (project.composition.effectStack?.some(entry => entry.targetLayerId === original.id)) {
    throw new MotionValidationError([
      "Remove effect stack entries targeting this text layer before splitting it into animated fragments",
    ]);
  }
  if (original.text.length > 256) throw new MotionValidationError(["Animated typography input text is too long"]);
  const units = fragments(original.text, input.style);
  if (!units.length || units.length > 48) throw new MotionValidationError(["Animated typography supports 1–48 text fragments"]);
  if (base.layers.length - 1 + units.length > 200) throw new MotionValidationError(["Animated typography layer limit reached"]);
  const start = input.startFrame ?? 0;
  const duration = input.durationFrames ?? Math.min(60, base.durationFrames - start);
  if (!Number.isSafeInteger(start) || start < 0 || start >= base.durationFrames ||
      !Number.isSafeInteger(duration) || duration < 1 ||
      duration > base.durationFrames - start) throw new MotionValidationError(["Invalid typography frame range"]);

  measure.font = original.fontSize + "px " + original.fontFamily;
  const idPrefix = "type-" + crypto.createHash("sha256").update(original.id).digest("hex").slice(0, 8) + "-";
  const last = base.durationFrames - 1;
  const layers: MotionLayer[] = units.map((unit, i) => {
    const appear = Math.min(last, start + Math.floor(duration * i / units.length));
    const settle = Math.min(last, appear + Math.max(1, Math.floor(duration / Math.max(5, units.length * 3))));
    const x = Math.round(original.x + measure.measureText(unit.prefix).width);
    const y = original.y;
    const w = Math.max(1, Math.ceil(measure.measureText(unit.text).width) + 4);
    const opacity = original.opacity;
    const opacityKeys: MotionTrack["keyframes"] = [];
    if (appear > 0) opacityKeys.push({ frame: 0, value: 0 });
    if (appear > 0 && appear !== 0) opacityKeys.push({ frame: appear - 1, value: 0 });
    if (appear === settle) opacityKeys.push({ frame: appear, value: opacity });
    else {
      opacityKeys.push({ frame: appear, value: 0, easing: "easeInOut" });
      opacityKeys.push({ frame: settle, value: opacity });
    }
    const uniqueOpacity = [...new Map(opacityKeys.map(key => [key.frame, key])).values()]
      .sort((a, b) => a.frame - b.frame);
    const tracks: MotionTrack[] = [{ property: "opacity", keyframes: uniqueOpacity }];
    if (input.style === "word-rise" && settle > appear) {
      tracks.push({ property: "y", keyframes: [
        { frame: appear, value: Math.round(y + original.fontSize * .25), easing: "easeInOut" },
        { frame: settle, value: y },
      ] });
    }
    return {
      id: idPrefix + String(i + 1).padStart(2, "0"),
      kind: "text", x, y, width: w, height: original.height,
      rotation: original.rotation, opacity, fill: original.fill, tracks,
      text: unit.text, fontSize: original.fontSize, fontFamily: original.fontFamily,
    };
  });
  base.layers.splice(index, 1, ...layers);
  const composition = project.composition.effectStack
    ? compileMotionEffectStack({ ...project, composition: base }, project.composition.effectStack)
    : base;
  validateMotionProject({ ...project, composition });
  return composition;
}
