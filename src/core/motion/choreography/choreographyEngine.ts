import type { MotionLayer, MotionTrack, MotionKeyframe, MotionEasing } from "../schema/types.js";

export interface ChoreographyOptions {
  staggerIntervalFrames?: number; // Default 3 frames (Apple/Linear 2-4 frame standard)
  defaultEasing?: MotionEasing;   // Default "apple"
  applyMicroDrift?: boolean;      // Subtle hold-phase momentum
  durationFrames?: number;
}

export type LayerSemanticRole =
  | "ambient"
  | "container"
  | "badge"
  | "headline"
  | "subtitle"
  | "telemetry"
  | "accent";

const ROLE_RANKS: Record<LayerSemanticRole, number> = {
  ambient: 0,
  container: 1,
  badge: 2,
  headline: 3,
  subtitle: 4,
  telemetry: 5,
  accent: 6,
};

function inferLayerRole(layer: MotionLayer): LayerSemanticRole {
  const id = layer.id.toLowerCase();
  if (id.includes("ambient") || id.includes("aura") || id.includes("backdrop") || id.includes("background")) {
    return "ambient";
  }
  if (id.includes("card") || id.includes("lid") || id.includes("chassis") || id.includes("window") || id.includes("frame")) {
    return "container";
  }
  if (id.includes("badge") || id.includes("pill") || id.includes("kicker") || id.includes("chip") || id.includes("tag") || id.includes("dot")) {
    return "badge";
  }
  if (id.includes("title") || id.includes("headline")) {
    return "headline";
  }
  if (id.includes("subtitle") || id.includes("sub-txt") || id.includes("desc") || id.includes("narration")) {
    return "subtitle";
  }
  if (id.includes("bar") || id.includes("chart") || id.includes("code") || id.includes("val") || id.includes("sparkline") || id.includes("visualizer")) {
    return "telemetry";
  }
  return "accent";
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
 * Applies professional 2–4 frame cascade choreography across a set of scene layers.
 * Shifts entrance keyframes according to visual hierarchy rank to guide the human eye.
 */
export function choreographSceneLayers(
  layers: MotionLayer[],
  options: ChoreographyOptions = {},
): MotionLayer[] {
  const interval = options.staggerIntervalFrames ?? 3;
  const easing = options.defaultEasing ?? "apple";
  const duration = options.durationFrames ?? 180;
  const maxAllowed = duration - 1;

  return layers.map(layer => {
    if (!layer.tracks || layer.tracks.length === 0) return layer;

    const role = inferLayerRole(layer);
    const rank = ROLE_RANKS[role];
    const frameOffset = rank * interval;

    const updatedTracks: MotionTrack[] = layer.tracks.map(track => {
      // Find the initial entrance keyframe (typically first frame where value changes from 0 to 1)
      const adjustedKeyframes = track.keyframes.map((kf, i) => {
        let targetFrame = kf.frame;

        // Apply stagger delay to early entrance keyframes (first half of layer lifecycle)
        if (kf.frame < Math.floor(duration * 0.45) && kf.frame > 0) {
          targetFrame = Math.min(maxAllowed, kf.frame + frameOffset);
        }

        // Upgrade legacy linear or generic easings on entrances to Apple/Linear curve
        let kfEasing = kf.easing;
        if (i === 0 || (kf.value > 0 && (!kfEasing || kfEasing === "linear" || kfEasing === "easeIn"))) {
          kfEasing = easing;
        }

        return {
          frame: targetFrame,
          value: kf.value,
          easing: kfEasing,
        };
      });

      return {
        property: track.property,
        keyframes: cleanKeyframes(adjustedKeyframes, maxAllowed),
      };
    });

    // Optional subtle hold-phase kinetic momentum (prevents dead static holds)
    if (options.applyMicroDrift && (role === "headline" || role === "container")) {
      const existingScale = updatedTracks.find(t => t.property === "scale");
      if (!existingScale) {
        updatedTracks.push({
          property: "scale",
          keyframes: cleanKeyframes([
            { frame: 0, value: 0.96 },
            { frame: frameOffset + 12, value: 1.0, easing },
            { frame: Math.round(duration * 0.8), value: 1.018, easing: "easeInOut" },
            { frame: maxAllowed, value: 1.0 },
          ], maxAllowed),
        });
      }
    }

    return {
      ...layer,
      tracks: updatedTracks,
    };
  });
}

/**
 * Anchor Point Discipline: computes compensated position keyframes
 * so that scaling occurs from an edge rather than the default center.
 */
export function computeAnchoredScaling(
  anchor: "left" | "right" | "top" | "bottom",
  baseX: number,
  baseY: number,
  width: number,
  height: number,
  startFrame: number,
  endFrame: number,
  maxAllowedFrame: number,
  easing: MotionEasing = "apple",
): { scaleTrack: MotionTrack; posTrack: MotionTrack } {
  if (anchor === "left") {
    const scaleXTrack: MotionTrack = {
      property: "scaleX",
      keyframes: cleanKeyframes([
        { frame: 0, value: 0 },
        { frame: startFrame, value: 0 },
        { frame: endFrame, value: 1.0, easing },
        { frame: maxAllowedFrame, value: 1.0 },
      ], maxAllowedFrame),
    };
    const xTrack: MotionTrack = {
      property: "x",
      keyframes: cleanKeyframes([
        { frame: 0, value: baseX - width * 0.5 },
        { frame: startFrame, value: baseX - width * 0.5 },
        { frame: endFrame, value: baseX, easing },
        { frame: maxAllowedFrame, value: baseX },
      ], maxAllowedFrame),
    };
    return { scaleTrack: scaleXTrack, posTrack: xTrack };
  }

  if (anchor === "right") {
    const scaleXTrack: MotionTrack = {
      property: "scaleX",
      keyframes: cleanKeyframes([
        { frame: 0, value: 0 },
        { frame: startFrame, value: 0 },
        { frame: endFrame, value: 1.0, easing },
        { frame: maxAllowedFrame, value: 1.0 },
      ], maxAllowedFrame),
    };
    const xTrack: MotionTrack = {
      property: "x",
      keyframes: cleanKeyframes([
        { frame: 0, value: baseX + width * 0.5 },
        { frame: startFrame, value: baseX + width * 0.5 },
        { frame: endFrame, value: baseX, easing },
        { frame: maxAllowedFrame, value: baseX },
      ], maxAllowedFrame),
    };
    return { scaleTrack: scaleXTrack, posTrack: xTrack };
  }

  if (anchor === "bottom") {
    const scaleYTrack: MotionTrack = {
      property: "scaleY",
      keyframes: cleanKeyframes([
        { frame: 0, value: 0 },
        { frame: startFrame, value: 0 },
        { frame: endFrame, value: 1.0, easing },
        { frame: maxAllowedFrame, value: 1.0 },
      ], maxAllowedFrame),
    };
    const yTrack: MotionTrack = {
      property: "y",
      keyframes: cleanKeyframes([
        { frame: 0, value: baseY + height * 0.5 },
        { frame: startFrame, value: baseY + height * 0.5 },
        { frame: endFrame, value: baseY, easing },
        { frame: maxAllowedFrame, value: baseY },
      ], maxAllowedFrame),
    };
    return { scaleTrack: scaleYTrack, posTrack: yTrack };
  }

  // anchor === "top"
  const scaleYTrack: MotionTrack = {
    property: "scaleY",
    keyframes: cleanKeyframes([
      { frame: 0, value: 0 },
      { frame: startFrame, value: 0 },
      { frame: endFrame, value: 1.0, easing },
      { frame: maxAllowedFrame, value: 1.0 },
    ], maxAllowedFrame),
  };
  const yTrack: MotionTrack = {
    property: "y",
    keyframes: cleanKeyframes([
      { frame: 0, value: baseY - height * 0.5 },
      { frame: startFrame, value: baseY - height * 0.5 },
      { frame: endFrame, value: baseY, easing },
      { frame: maxAllowedFrame, value: baseY },
    ], maxAllowedFrame),
  };
  return { scaleTrack: scaleYTrack, posTrack: yTrack };
}
