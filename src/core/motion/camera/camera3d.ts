import type { MotionLayer, MotionTrack, MotionKeyframe, MotionEasing } from "../schema/types.js";

export type CameraMoveType =
  | "isometric-reveal"
  | "cinematic-push"
  | "lateral-dolly"
  | "floating-tilt";

export interface CameraOptions {
  durationFrames?: number;
  startFrame?: number;
  easing?: MotionEasing;
  intensity?: number; // 0.5 (subtle) to 2.0 (dramatic)
}

export const Z_DEPTHS = {
  BACKDROP: -200,
  SHADOW: -60,
  CANVAS: 0,
  SURFACE: 35,
  FOREGROUND: 85,
} as const;

function inferZDepth(layer: MotionLayer): number {
  const id = layer.id.toLowerCase();
  if (id.includes("shadow")) return Z_DEPTHS.SHADOW;
  if (id.includes("ambient") || id.includes("aura") || id.includes("backdrop") || id.includes("runner")) return Z_DEPTHS.BACKDROP;
  if (id.includes("card") || id.includes("lid") || id.includes("chassis") || id.includes("window")) return Z_DEPTHS.CANVAS;
  if (id.includes("sheen") || id.includes("cursor") || id.includes("badge") || id.includes("dot")) return Z_DEPTHS.FOREGROUND;
  return Z_DEPTHS.SURFACE;
}

function cleanKeyframes(
  raw: { frame: number; value: number; easing?: MotionEasing }[],
  maxAllowedFrame: number,
): { frame: number; value: number; easing?: MotionEasing }[] {
  const bounded = raw
    .map(k => ({ ...k, frame: Math.max(0, Math.min(maxAllowedFrame, Math.round(k.frame))) }))
    .sort((a, b) => a.frame - b.frame);
  const result: { frame: number; value: number; easing?: MotionEasing }[] = [];
  for (const k of bounded) {
    if (result.length > 0 && result[result.length - 1].frame === k.frame) {
      result[result.length - 1] = k;
    } else {
      result.push(k);
    }
  }
  return result.length > 0 ? result : [{ frame: 0, value: 0 }];
}

/**
 * Applies simulated 3D camera mechanics, Z-axis depth separation, and inertial camera sweeps
 * to a composition, transforming flat 2D layers into an immersive spatial ecosystem.
 */
export function applyInertialCameraMotion(
  layers: MotionLayer[],
  moveType: CameraMoveType,
  options: CameraOptions = {},
): MotionLayer[] {
  const duration = options.durationFrames ?? 180;
  const startFrame = options.startFrame ?? 0;
  const maxAllowed = duration - 1;
  const easing = options.easing ?? "apple";
  const intensity = options.intensity ?? 1.0;

  return layers.map(layer => {
    const z = inferZDepth(layer);
    // Parallax depth multiplier: layers further back move slower, layers forward move faster
    const depthFactor = 1 + (z / 300) * intensity;
    const existingTracks = layer.tracks ? [...layer.tracks] : [];

    if (moveType === "isometric-reveal") {
      // Starts tilted at isometric angle, then smoothly snaps to orthographic focus
      const rotAngle = -3.5 * intensity * (z >= Z_DEPTHS.CANVAS ? 1 : 0.4);
      const rotTrack: MotionTrack = {
        property: "rotation",
        keyframes: cleanKeyframes([
          { frame: 0, value: rotAngle },
          { frame: startFrame, value: rotAngle },
          { frame: Math.min(maxAllowed, startFrame + Math.round(duration * 0.28)), value: 0, easing },
          { frame: maxAllowed, value: 0 },
        ], maxAllowed),
      };

      const scaleTrack: MotionTrack = {
        property: "scale",
        keyframes: cleanKeyframes([
          { frame: 0, value: 0.92 },
          { frame: startFrame, value: 0.92 },
          { frame: Math.min(maxAllowed, startFrame + Math.round(duration * 0.25)), value: 1.0, easing },
          { frame: maxAllowed, value: 1.012 },
        ], maxAllowed),
      };

      // Replace or append rotation and scale tracks
      const filtered = existingTracks.filter(t => t.property !== "rotation" && t.property !== "scale");
      return {
        ...layer,
        tracks: [...filtered, rotTrack, scaleTrack],
      };
    }

    if (moveType === "cinematic-push") {
      // Slow, steady forward push-in with Z-depth differentiation
      const pushTarget = 1.0 + 0.05 * depthFactor;
      const scaleTrack: MotionTrack = {
        property: "scale",
        keyframes: cleanKeyframes([
          { frame: 0, value: 0.96 },
          { frame: startFrame, value: 0.96 },
          { frame: Math.min(maxAllowed, startFrame + 18), value: 1.0, easing },
          { frame: maxAllowed, value: pushTarget, easing: "linear" },
        ], maxAllowed),
      };

      const filtered = existingTracks.filter(t => t.property !== "scale");
      return {
        ...layer,
        tracks: [...filtered, scaleTrack],
      };
    }

    if (moveType === "lateral-dolly") {
      // Smooth lateral tracking sweep across the screen with true multi-layer parallax
      const panDistance = 70 * depthFactor;
      const xTrack: MotionTrack = {
        property: "x",
        keyframes: cleanKeyframes([
          { frame: 0, value: layer.x - panDistance * 0.5 },
          { frame: startFrame, value: layer.x - panDistance * 0.5 },
          { frame: Math.min(maxAllowed, startFrame + Math.round(duration * 0.3)), value: layer.x, easing },
          { frame: maxAllowed, value: layer.x + panDistance * 0.5, easing: "easeInOut" },
        ], maxAllowed),
      };

      const filtered = existingTracks.filter(t => t.property !== "x");
      return {
        ...layer,
        tracks: [...filtered, xTrack],
      };
    }

    if (moveType === "floating-tilt") {
      // Organic continuous floating breathing tilt
      const rotTrack: MotionTrack = {
        property: "rotation",
        keyframes: cleanKeyframes([
          { frame: 0, value: -0.6 * intensity },
          { frame: Math.round(duration * 0.25), value: 0.4 * intensity, easing: "easeInOut" },
          { frame: Math.round(duration * 0.5), value: -0.5 * intensity, easing: "easeInOut" },
          { frame: Math.round(duration * 0.75), value: 0.5 * intensity, easing: "easeInOut" },
          { frame: maxAllowed, value: 0 },
        ], maxAllowed),
      };

      const filtered = existingTracks.filter(t => t.property !== "rotation");
      return {
        ...layer,
        tracks: [...filtered, rotTrack],
      };
    }

    return layer;
  });
}
