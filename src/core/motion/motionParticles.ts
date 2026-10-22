import crypto from "node:crypto";
import type { MotionComposition, MotionLayer, MotionProject, MotionTrack } from "./schema/types.js";
import { validateMotionProject, MotionValidationError } from "./schema/validation.js";
import { compileMotionEffectStack } from "./effects/effectStack.js";

export type MotionParticleKind = "confetti" | "sparks" | "snow";
export interface MotionParticleInput {
  kind: MotionParticleKind;
  count?: number;
  color?: string;
}
const prefix = "motion-particle-";
const palette = ["#F97316", "#38BDF8", "#A78BFA", "#FDE047", "#34D399"];
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
}

/** Safe deterministic CPU-layer particle motion; preview and MP4 render use
 * ordinary rectangle primitives, no GPU shader, scripting or external files.
 */
export function compileMotionParticles(project: MotionProject, options: MotionParticleInput): MotionComposition {
  validateMotionProject(project);
  if (!options || !["confetti", "sparks", "snow"].includes(options.kind)) {
    throw new MotionValidationError(["Unsupported Motion particle style"]);
  }
  const count = options.count ?? 20;
  if (!Number.isSafeInteger(count) || count < 4 || count > 36)
    throw new MotionValidationError(["Particle count must be 4–36"]);
  if (options.color !== undefined && !/^#[0-9a-fA-F]{6}$/.test(options.color))
    throw new MotionValidationError(["Invalid particle accent color"]);
  const source: MotionComposition = structuredClone(project.composition.stackBase ?? project.composition);
  delete source.effectStack;
  delete source.stackBase;
  source.layers = source.layers.filter(layer => !layer.id.startsWith(prefix));
  if (source.layers.length + count > 200)
    throw new MotionValidationError(["Particle overlay would exceed 200 Motion layers"]);
  const { width, height, durationFrames } = source;
  const seed = crypto.createHash("sha256").update(
    project.id + "|" + options.kind + "|" + (options.color ?? "") + "|" + count).digest().readUInt32LE(0);
  const random = rng(seed);
  const last = durationFrames - 1;
  const keyframes = (property: "x" | "y", from: number, to: number, delay: number): MotionTrack => {
    if (last === 0) return { property, keyframes: [{ frame: 0, value: from }] };
    const start = Math.min(delay, last - 1);
    return { property, keyframes: [
      ...(start > 0 ? [{ frame: 0, value: from }] : []),
      { frame: start, value: from, easing: "easeInOut" },
      { frame: last, value: to },
    ] };
  };
  for (let i = 0; i < count; i++) {
    const size = Math.max(3, Math.round(Math.min(width, height) * (.004 + random() * .015)));
    const x = Math.round(random() * width);
    const y = options.kind === "sparks" ? Math.round(height * (.65 + random() * .3)) :
      options.kind === "confetti" ? -size : Math.round(random() * height * .35) - size;
    const dx = (random() - .5) * width * (options.kind === "snow" ? .12 : .3);
    const dy = options.kind === "sparks" ? -height * (.45 + random() * .35) :
      height * (options.kind === "confetti" ? 1.1 : .65);
    const delay = Math.min(Math.floor(random() * Math.max(1, last / 3)), Math.max(0, last - 1));
    const opacityKeys = last < 2 ? [{ frame: 0, value: .8 }] : [
      { frame: 0, value: 0, easing: "easeInOut" as const },
      { frame: Math.max(1, Math.floor(last * .3)), value: .85, easing: "easeInOut" as const },
      { frame: last, value: 0 },
    ];
    const layer: MotionLayer = {
      id: prefix + String(i + 1).padStart(2, "0"),
      kind: "rect", x, y,
      width: size * (options.kind === "confetti" ? 1.5 : 1),
      height: size, fill: options.color ?? palette[i % palette.length],
      opacity: .8, rotation: Math.round(random() * 80 - 40),
      cornerRadius: options.kind === "confetti" ? 0 : Math.floor(size / 2),
      tracks: [
        keyframes("x", x, Math.round(x + dx), delay),
        keyframes("y", y, Math.round(y + dy), delay),
        { property: "opacity", keyframes: opacityKeys },
      ],
    };
    source.layers.unshift(layer);
  }
  const compiled = project.composition.effectStack
    ? compileMotionEffectStack({ ...project, composition: source }, project.composition.effectStack)
    : source;
  validateMotionProject({ ...project, composition: compiled });
  return compiled;
}
