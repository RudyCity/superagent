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
  if (id.includes("card") || id.includes("lid") || id.includes("chassis") || id.includes("window") || id.includes("frame") || id.includes("container") || id.includes("mockup") || id.includes("box")) {
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
      const kfs = track.keyframes;
      if (kfs.length < 2) return track;

      // Identify entrance keyframe index:
      // For opacity: index where value transitions from 0 to > 0.
      // For position/scale/rotation: index of first keyframe with frame > kfs[0].frame.
      let entranceIdx = -1;
      if (track.property === "opacity") {
        entranceIdx = kfs.findIndex((k, i) => i > 0 && k.value > 0 && kfs[i - 1].value === 0);
      } else {
        entranceIdx = kfs.findIndex((k, i) => i > 0 && k.frame > kfs[0].frame);
      }

      if (entranceIdx === -1) {
        entranceIdx = 1;
      }

      const entranceEnd = kfs[entranceIdx];
      const nextKf = kfs[entranceIdx + 1];

      // Stagger limit: entrance must never collide with or overtake hold/exit keyframe
      const maxShift = nextKf ? Math.max(0, Math.floor((nextKf.frame - entranceEnd.frame) * 0.75)) : 24;
      const actualOffset = Math.min(frameOffset, maxShift);

      const adjustedKeyframes = kfs.map((kf, i) => {
        let kfEasing = kf.easing;
        if (i === entranceIdx || (i === entranceIdx - 1 && (!kfEasing || kfEasing === "linear" || kfEasing === "easeIn"))) {
          kfEasing = easing;
        }

        // Stagger entrance keyframe
        if (i === entranceIdx) {
          return {
            frame: Math.min(maxAllowed, kf.frame + actualOffset),
            value: kf.value,
            easing: kfEasing,
          };
        }

        // Stagger preceding zero-hold frame if not anchored at 0
        if (i === entranceIdx - 1 && kf.frame > 0) {
          return {
            frame: Math.min(maxAllowed, kf.frame + actualOffset),
            value: kf.value,
            easing: kfEasing,
          };
        }

        // Anchor at frame 0 if entrance starts at 0
        if (i === entranceIdx - 1 && kf.frame === 0) {
          return {
            frame: 0,
            value: kf.value,
            easing: kfEasing,
          };
        }

        // Hold and exit keyframes (i > entranceIdx) REMAIN ANCHORED to their exact scheduled scene bounds!
        return {
          frame: kf.frame,
          value: kf.value,
          easing: kf.easing,
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
        // Determine active visibility window from opacity track
        const opacityTrack = updatedTracks.find(t => t.property === "opacity");
        const firstVisibleKf = opacityTrack?.keyframes.find(k => k.value > 0);
        const lastVisibleKf = opacityTrack?.keyframes.slice().reverse().find(k => k.value > 0);

        const startF = firstVisibleKf ? Math.max(0, firstVisibleKf.frame - 6) : 0;
        const endF = lastVisibleKf ? Math.min(maxAllowed, lastVisibleKf.frame + 6) : maxAllowed;

        if (endF > startF + 12) {
          updatedTracks.push({
            property: "scale",
            keyframes: cleanKeyframes([
              { frame: startF, value: 0.96 },
              { frame: Math.min(endF, startF + frameOffset + 12), value: 1.0, easing },
              { frame: Math.round(startF + (endF - startF) * 0.8), value: 1.018, easing: "easeInOut" },
              { frame: endF, value: 1.0 },
            ], maxAllowed),
          });
        }
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
