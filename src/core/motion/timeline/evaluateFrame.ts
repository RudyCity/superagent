import type { EvaluatedFrame, MotionLayer, MotionProject, MotionProperty, MotionTrack } from "../schema/types.js";
import { validateMotionProject } from "../schema/validation.js";

function ease(t: number, kind: string): number {
  if (kind === "step") return 0;
  if (kind === "easeIn") return t * t;
  if (kind === "easeOut") return t * (2 - t);
  if (kind === "easeInOut") return t * t * (3 - 2 * t);
  if (kind === "easeOutCubic") { const u = 1 - t; return 1 - u * u * u; }
  if (kind === "easeOutQuart") { const u = 1 - t; return 1 - u * u * u * u; }
  if (kind === "easeOutExpo") { return t === 1 ? 1 : 1 - Math.pow(2, -10 * t); }
  if (kind === "apple") {
    // Signature Apple/Linear velocity curve: cubic-bezier(0.16, 1, 0.3, 1)
    // Snappy front-loaded entry with long, luxurious ease-out settling
    const u = 1 - t;
    return 1 - Math.pow(u, 3.8);
  }
  if (kind === "spring") {
    const damping = 9;
    const frequency = 4.2;
    return 1 - Math.exp(-damping * t * 0.5) * Math.cos(frequency * t * Math.PI);
  }
  if (kind === "easeOutBack") { const u = t - 1; return 1 + 2.70158 * u * u * u + 1.70158 * u * u; }
  if (kind === "bounce") {
    const n1 = 7.5625;
    const d1 = 2.75;
    let x = t;
    if (x < 1 / d1) return n1 * x * x;
    if (x < 2 / d1) { x -= 1.5 / d1; return n1 * x * x + 0.75; }
    if (x < 2.5 / d1) { x -= 2.25 / d1; return n1 * x * x + 0.9375; }
    x -= 2.625 / d1;
    return n1 * x * x + 0.984375;
  }
  return t;
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
      const defaultScale = layer.scale ?? 1;
      const values: Record<MotionProperty, number> = {
        x: layer.x, y: layer.y, opacity: layer.opacity, rotation: layer.rotation,
        scale: defaultScale, scaleX: layer.scaleX ?? defaultScale, scaleY: layer.scaleY ?? defaultScale,
        strokeDashoffset: (layer as any).strokeDashoffset ?? 0,
      };
      for (const track of layer.tracks) {
        const val = evaluateTrack(track, frame);
        values[track.property] = val;
        if (track.property === "scale") {
          values.scaleX = val;
          values.scaleY = val;
        }
      }
      if (project.composition.tracks && project.composition.tracks.length > 0) {
        const associatedTracks = project.composition.tracks.filter(t =>
          t.clips.some(c => c.layerId === layer.id)
        );
        if (associatedTracks.length > 0) {
          const hasActiveClip = associatedTracks.some(t =>
            !t.muted && t.clips.some(c =>
              c.layerId === layer.id &&
              frame >= c.startFrame &&
              frame < c.startFrame + c.durationFrames
            )
          );
          if (!hasActiveClip) {
            values.opacity = 0;
          } else {
            const activeClip = associatedTracks
              .flatMap(t => t.clips)
              .find(c => c.layerId === layer.id && frame >= c.startFrame && frame < c.startFrame + c.durationFrames);
            if (activeClip && typeof activeClip.opacity === "number") {
              values.opacity = values.opacity * activeClip.opacity;
            }
          }
        }
      }
      return { layer, values };
    }),
  };
}
