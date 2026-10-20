import type { EvaluatedFrame, MotionLayer, MotionProject, MotionProperty, MotionTrack } from "../schema/types.js";
import { validateMotionProject } from "../schema/validation.js";

function ease(t: number, kind: string): number {
  if (kind === "step") return 0;
  return kind === "easeInOut" ? t * t * (3 - 2 * t) : t;
}
export function evaluateTrack(track: MotionTrack, frame: number): number {
  const frames = track.keyframes;
  if (!frames.length) throw new Error("An animation track needs keyframes");
  if (frame <= frames[0].frame) return frames[0].value;
  for (let i = 1; i < frames.length; i++) {
    const right = frames[i];
    const left = frames[i - 1];
    if (frame <= right.frame) {
      const fraction = (frame - left.frame) / (right.frame - left.frame);
      const eased = ease(fraction, left.easing ?? "linear");
      return left.value + (right.value - left.value) * eased;
    }
  }
  return frames[frames.length - 1].value;
}

export function evaluateFrame(project: MotionProject, frame: number): EvaluatedFrame {
  validateMotionProject(project);
  if (!Number.isSafeInteger(frame) || frame < 0 || frame >= project.composition.durationFrames) {
    throw new RangeError("Frame index must be within composition duration");
  }
  return {
    frame,
    width: project.composition.width,
    height: project.composition.height,
    background: project.composition.background,
    layers: project.composition.layers.map((layer: MotionLayer) => {
      const values: Record<MotionProperty, number> = {
        x: layer.x, y: layer.y, opacity: layer.opacity, rotation: layer.rotation,
      };
      for (const track of layer.tracks) values[track.property] = evaluateTrack(track, frame);
      return { layer, values };
    }),
  };
}
