import type { MotionComposition, MotionLayer, MotionProject } from "./schema/types.js";
import { validateMotionProject, MotionValidationError } from "./schema/validation.js";
import { compileMotionEffectStack } from "./effects/effectStack.js";

export type MotionOutputAspect = "16:9" | "1:1" | "9:16";
const aspect: Record<MotionOutputAspect, number> = { "16:9": 16 / 9, "1:1": 1, "9:16": 9 / 16 };

const even = (n: number) => Math.max(16, Math.round(n / 2) * 2);
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Retains layer visibility, animation timing and optical center while reframing.
 * The source stack is resized before effects are recompiled to avoid baking.
 */
export function resizeMotionComposition(project: MotionProject, target: MotionOutputAspect, width?: number): MotionComposition {
  validateMotionProject(project);
  if (!Object.hasOwn(aspect, target)) throw new MotionValidationError(["Unsupported target aspect ratio"]);
  const source = project.composition.stackBase ?? project.composition;
  const targetWidth = width ?? (target === "9:16" ? 720 : target === "1:1" ? 1080 : 1280);
  if (!Number.isSafeInteger(targetWidth) || targetWidth < 160 || targetWidth > 3840 || targetWidth % 2 !== 0)
    throw new MotionValidationError(["Width must be even and between 160 and 3840"]);
  const targetHeight = even(targetWidth / aspect[target]);
  if (targetHeight > 3840) throw new MotionValidationError(["Height exceeds render limit"]);
  const scale = Math.min(targetWidth / source.width, targetHeight / source.height);
  const scaledWidth = source.width * scale;
  const scaledHeight = source.height * scale;
  const dx = (targetWidth - scaledWidth) / 2, dy = (targetHeight - scaledHeight) / 2;
  const layers: MotionLayer[] = source.layers.map(layer => {
    const w = clamp(layer.width * scale, 1, 100000);
    const h = clamp(layer.height * scale, 1, 100000);
    const resizeCoord = (v: number, size: number, limit: number) =>
      clamp(Math.round(v * scale + (limit === targetWidth ? dx : dy)), -100000, 100000);
    const x = resizeCoord(layer.x, w, targetWidth);
    const y = resizeCoord(layer.y, h, targetHeight);
    const result: MotionLayer = { ...structuredClone(layer), x, y, width: w, height: h,
      tracks: layer.tracks.map(t => (t.property === "x" || t.property === "y")
        ? { ...t, keyframes: t.keyframes.map(k => ({ ...k, value: clamp(
          Math.round(k.value * scale + (t.property === "x" ? dx : dy)), -100000, 100000) })) }
        : structuredClone(t)),
    };
    if (result.kind === "text") result.fontSize = clamp(result.fontSize * scale, 1, 512);
    if (result.kind === "rect" && result.cornerRadius !== undefined)
      result.cornerRadius = Math.min(result.cornerRadius * scale, w / 2, h / 2);
    if (result.kind === "path") {
      if (result.strokeWidth !== undefined) result.strokeWidth = Math.max(0.1, result.strokeWidth * scale);
      if (scale !== 1) {
        result.scaleX = (result.scaleX ?? 1) * scale;
        result.scaleY = (result.scaleY ?? 1) * scale;
      }
    }
    return result;
  });
  const base: MotionComposition = { ...structuredClone(source), width: targetWidth,
    height: targetHeight, layers };
  delete base.effectStack;
  delete base.stackBase;
  const result = project.composition.effectStack
    ? compileMotionEffectStack({ ...project, composition: base }, project.composition.effectStack)
    : base;
  validateMotionProject({ ...project, composition: result });
  return result;
}
