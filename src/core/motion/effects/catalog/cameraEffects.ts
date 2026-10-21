import type { EffectDefinition } from "../types.js";
import { createTrack } from "../registry.js";

function getBaseCoords(ctx: any): { x: number; y: number } {
  return {
    x: ctx.targetLayer?.x ?? 0,
    y: ctx.targetLayer?.y ?? 0,
  };
}

export const cameraEffects: EffectDefinition[] = [
  {
    id: "camera-pan-left",
    name: "Camera Pan Left",
    category: "camera",
    description: "Simulates a cinematic camera panning to the left by moving layers rightward.",
    tags: ["camera", "pan", "horizontal", "cinematic"],
    targetKinds: ["text", "rect", "image", "scene"],
    parameters: {
      distance: { name: "Pan Distance", type: "number", description: "Pixels", default: 90, min: 10, max: 800 },
      easing: { name: "Easing", type: "enum", description: "Easing curve", default: "easeInOut", choices: ["linear", "easeInOut"] },
    },
    apply: (ctx, params) => {
      const { x } = getBaseCoords(ctx);
      return {
        tracks: [
          createTrack("x", [
            { frame: ctx.startFrame, value: x, easing: params.easing },
            { frame: ctx.endFrame, value: x + params.distance, easing: "easeInOut" },
          ]),
        ],
      };
    },
  },
  {
    id: "camera-pan-right",
    name: "Camera Pan Right",
    category: "camera",
    description: "Simulates a cinematic camera panning to the right by moving layers leftward.",
    tags: ["camera", "pan", "horizontal", "cinematic"],
    targetKinds: ["text", "rect", "image", "scene"],
    parameters: {
      distance: { name: "Pan Distance", type: "number", description: "Pixels", default: 90, min: 10, max: 800 },
      easing: { name: "Easing", type: "enum", description: "Easing curve", default: "easeInOut", choices: ["linear", "easeInOut"] },
    },
    apply: (ctx, params) => {
      const { x } = getBaseCoords(ctx);
      return {
        tracks: [
          createTrack("x", [
            { frame: ctx.startFrame, value: x, easing: params.easing },
            { frame: ctx.endFrame, value: x - params.distance, easing: "easeInOut" },
          ]),
        ],
      };
    },
  },
  {
    id: "camera-pan-up",
    name: "Camera Pedestal Up",
    category: "camera",
    description: "Simulates camera elevating upward by shifting framing downward.",
    tags: ["camera", "pedestal", "vertical", "crane"],
    targetKinds: ["text", "rect", "image", "scene"],
    parameters: {
      distance: { name: "Distance", type: "number", description: "Pixels", default: 80, min: 10, max: 600 },
    },
    apply: (ctx, params) => {
      const { y } = getBaseCoords(ctx);
      return {
        tracks: [
          createTrack("y", [
            { frame: ctx.startFrame, value: y, easing: "easeInOut" },
            { frame: ctx.endFrame, value: y + params.distance, easing: "easeInOut" },
          ]),
        ],
      };
    },
  },
  {
    id: "camera-pan-down",
    name: "Camera Pedestal Down",
    category: "camera",
    description: "Simulates camera sinking downward by shifting framing upward.",
    tags: ["camera", "pedestal", "vertical", "crane"],
    targetKinds: ["text", "rect", "image", "scene"],
    parameters: {
      distance: { name: "Distance", type: "number", description: "Pixels", default: 80, min: 10, max: 600 },
    },
    apply: (ctx, params) => {
      const { y } = getBaseCoords(ctx);
      return {
        tracks: [
          createTrack("y", [
            { frame: ctx.startFrame, value: y, easing: "easeInOut" },
            { frame: ctx.endFrame, value: y - params.distance, easing: "easeInOut" },
          ]),
        ],
      };
    },
  },
  {
    id: "camera-push-in-slow",
    name: "Slow Push-In",
    category: "camera",
    description: "Slow progressive zoom-in framing focus onto the central subject.",
    tags: ["camera", "push-in", "zoom", "subtle"],
    targetKinds: ["text", "rect", "image", "scene"],
    parameters: {
      travel: { name: "Travel Pixels", type: "number", description: "Framing offset", default: 35, min: 5, max: 200 },
    },
    apply: (ctx, params) => {
      const { y } = getBaseCoords(ctx);
      return {
        tracks: [
          createTrack("y", [
            { frame: ctx.startFrame, value: y, easing: "easeInOut" },
            { frame: ctx.endFrame, value: y - params.travel, easing: "easeInOut" },
          ]),
        ],
      };
    },
  },
  {
    id: "camera-push-in-dramatic",
    name: "Dramatic Push-In",
    category: "camera",
    description: "Fast dramatic camera push-in accelerating toward key narrative moment.",
    tags: ["camera", "push-in", "dramatic", "fast"],
    targetKinds: ["text", "rect", "image", "scene"],
    parameters: {
      travel: { name: "Travel Pixels", type: "number", description: "Framing offset", default: 75, min: 15, max: 400 },
      durationFrames: { name: "Duration", type: "number", description: "Frames", default: 18, min: 5, max: 90 },
    },
    apply: (ctx, params) => {
      const { y } = getBaseCoords(ctx);
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      return {
        tracks: [
          createTrack("y", [
            { frame: ctx.startFrame, value: y, easing: "easeInOut" },
            { frame: ctx.startFrame + dur, value: y - params.travel, easing: "easeInOut" },
          ]),
        ],
      };
    },
  },
  {
    id: "camera-pull-out-slow",
    name: "Slow Pull-Out",
    category: "camera",
    description: "Slow progressive pull-out revealing broader composition context.",
    tags: ["camera", "pull-out", "wide", "reveal"],
    targetKinds: ["text", "rect", "image", "scene"],
    parameters: {
      travel: { name: "Travel Pixels", type: "number", description: "Framing offset", default: 35, min: 5, max: 200 },
    },
    apply: (ctx, params) => {
      const { y } = getBaseCoords(ctx);
      return {
        tracks: [
          createTrack("y", [
            { frame: ctx.startFrame, value: y - params.travel, easing: "easeInOut" },
            { frame: ctx.endFrame, value: y, easing: "easeInOut" },
          ]),
        ],
      };
    },
  },
  {
    id: "camera-pull-out-dramatic",
    name: "Dramatic Pull-Out",
    category: "camera",
    description: "Fast dramatic snap pull-back into wide establishing view.",
    tags: ["camera", "pull-out", "dramatic", "wide"],
    targetKinds: ["text", "rect", "image", "scene"],
    parameters: {
      travel: { name: "Travel Pixels", type: "number", description: "Framing offset", default: 80, min: 15, max: 400 },
      durationFrames: { name: "Duration", type: "number", description: "Frames", default: 16, min: 5, max: 90 },
    },
    apply: (ctx, params) => {
      const { y } = getBaseCoords(ctx);
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      return {
        tracks: [
          createTrack("y", [
            { frame: ctx.startFrame, value: y - params.travel, easing: "easeOutBack" },
            { frame: ctx.startFrame + dur, value: y, easing: "easeInOut" },
          ]),
        ],
      };
    },
  },
  {
    id: "camera-dutch-angle-cw",
    name: "Dutch Angle CW",
    category: "camera",
    description: "Cinematic canted dutch tilt introducing tension clockwise.",
    tags: ["camera", "dutch", "tilt", "tension"],
    targetKinds: ["text", "rect", "image", "scene"],
    parameters: {
      angle: { name: "Tilt Angle", type: "number", description: "Degrees", default: 6, min: 1, max: 25 },
      durationFrames: { name: "Duration", type: "number", description: "Frames to angle", default: 24, min: 6, max: 120 },
    },
    apply: (ctx, params) => {
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      return {
        tracks: [
          createTrack("rotation", [
            { frame: ctx.startFrame, value: 0, easing: "easeInOut" },
            { frame: ctx.startFrame + dur, value: params.angle, easing: "easeInOut" },
          ]),
        ],
      };
    },
  },
  {
    id: "camera-dutch-angle-ccw",
    name: "Dutch Angle CCW",
    category: "camera",
    description: "Cinematic canted dutch tilt introducing tension counter-clockwise.",
    tags: ["camera", "dutch", "tilt", "tension"],
    targetKinds: ["text", "rect", "image", "scene"],
    parameters: {
      angle: { name: "Tilt Angle", type: "number", description: "Degrees", default: -6, min: -25, max: -1 },
      durationFrames: { name: "Duration", type: "number", description: "Frames to angle", default: 24, min: 6, max: 120 },
    },
    apply: (ctx, params) => {
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      return {
        tracks: [
          createTrack("rotation", [
            { frame: ctx.startFrame, value: 0, easing: "easeInOut" },
            { frame: ctx.startFrame + dur, value: params.angle, easing: "easeInOut" },
          ]),
        ],
      };
    },
  },
  {
    id: "camera-whip-pan-left",
    name: "Camera Whip Pan Left",
    category: "camera",
    description: "High-speed simulated camera whip pan scanning swiftly to the left.",
    tags: ["camera", "whip", "fast", "pan"],
    targetKinds: ["text", "rect", "image", "scene"],
    parameters: {
      distance: { name: "Travel Distance", type: "number", description: "Pixels", default: 250, min: 50, max: 1500 },
      durationFrames: { name: "Duration", type: "number", description: "Frames", default: 8, min: 3, max: 24 },
    },
    apply: (ctx, params) => {
      const { x } = getBaseCoords(ctx);
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      return {
        tracks: [
          createTrack("x", [
            { frame: ctx.startFrame, value: x, easing: "easeInOut" },
            { frame: ctx.startFrame + dur, value: x + params.distance, easing: "linear" },
          ]),
        ],
      };
    },
  },
  {
    id: "camera-whip-pan-right",
    name: "Camera Whip Pan Right",
    category: "camera",
    description: "High-speed simulated camera whip pan scanning swiftly to the right.",
    tags: ["camera", "whip", "fast", "pan"],
    targetKinds: ["text", "rect", "image", "scene"],
    parameters: {
      distance: { name: "Travel Distance", type: "number", description: "Pixels", default: 250, min: 50, max: 1500 },
      durationFrames: { name: "Duration", type: "number", description: "Frames", default: 8, min: 3, max: 24 },
    },
    apply: (ctx, params) => {
      const { x } = getBaseCoords(ctx);
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      return {
        tracks: [
          createTrack("x", [
            { frame: ctx.startFrame, value: x, easing: "easeInOut" },
            { frame: ctx.startFrame + dur, value: x - params.distance, easing: "linear" },
          ]),
        ],
      };
    },
  },
  {
    id: "camera-handheld-drift",
    name: "Organic Handheld Drift",
    category: "camera",
    description: "Simulates human operator breathing and gentle handheld camera sway.",
    tags: ["camera", "handheld", "organic", "realism"],
    targetKinds: ["text", "rect", "image", "scene"],
    parameters: {
      driftAmount: { name: "Max Drift", type: "number", description: "Pixels", default: 12, min: 2, max: 40 },
      periodFrames: { name: "Sway Period", type: "number", description: "Frames", default: 36, min: 10, max: 120 },
    },
    apply: (ctx, params) => {
      const { x, y } = getBaseCoords(ctx);
      const kfX: { frame: number; value: number; easing?: "easeInOut" }[] = [];
      const kfY: { frame: number; value: number; easing?: "easeInOut" }[] = [];
      const period = Math.max(10, Math.floor(params.periodFrames));
      for (let f = ctx.startFrame; f <= ctx.endFrame; f += period) {
        kfX.push({ frame: f, value: x, easing: "easeInOut" });
        kfX.push({ frame: Math.min(ctx.endFrame, f + Math.floor(period * 0.3)), value: x + params.driftAmount, easing: "easeInOut" });
        kfX.push({ frame: Math.min(ctx.endFrame, f + Math.floor(period * 0.7)), value: x - params.driftAmount, easing: "easeInOut" });

        kfY.push({ frame: f, value: y, easing: "easeInOut" });
        kfY.push({ frame: Math.min(ctx.endFrame, f + Math.floor(period * 0.4)), value: y - Math.floor(params.driftAmount * 0.7), easing: "easeInOut" });
        kfY.push({ frame: Math.min(ctx.endFrame, f + Math.floor(period * 0.8)), value: y + Math.floor(params.driftAmount * 0.7), easing: "easeInOut" });
      }
      kfX.push({ frame: ctx.endFrame, value: x, easing: "easeInOut" });
      kfY.push({ frame: ctx.endFrame, value: y, easing: "easeInOut" });
      return { tracks: [createTrack("x", kfX), createTrack("y", kfY)] };
    },
  },
  {
    id: "camera-crane-rise",
    name: "Sweeping Crane Rise",
    category: "camera",
    description: "Sweeping crane camera shot elevating high above the horizon.",
    tags: ["camera", "crane", "epic", "vertical"],
    targetKinds: ["text", "rect", "image", "scene"],
    parameters: {
      elevation: { name: "Elevation", type: "number", description: "Pixels", default: 140, min: 20, max: 800 },
    },
    apply: (ctx, params) => {
      const { y } = getBaseCoords(ctx);
      return {
        tracks: [
          createTrack("y", [
            { frame: ctx.startFrame, value: y - Math.floor(params.elevation * 0.3), easing: "easeInOut" },
            { frame: ctx.endFrame, value: y + params.elevation, easing: "easeInOut" },
          ]),
        ],
      };
    },
  },
  {
    id: "camera-crane-descend",
    name: "Sweeping Crane Descent",
    category: "camera",
    description: "Sweeping crane camera shot descending from sky down toward subject.",
    tags: ["camera", "crane", "epic", "vertical"],
    targetKinds: ["text", "rect", "image", "scene"],
    parameters: {
      descent: { name: "Descent", type: "number", description: "Pixels", default: 140, min: 20, max: 800 },
    },
    apply: (ctx, params) => {
      const { y } = getBaseCoords(ctx);
      return {
        tracks: [
          createTrack("y", [
            { frame: ctx.startFrame, value: y + Math.floor(params.descent * 0.3), easing: "easeInOut" },
            { frame: ctx.endFrame, value: y - params.descent, easing: "easeInOut" },
          ]),
        ],
      };
    },
  },
  {
    id: "camera-truck-left",
    name: "Camera Truck Left",
    category: "camera",
    description: "Linear lateral dolly track moving alongside subject leftward.",
    tags: ["camera", "truck", "dolly", "lateral"],
    targetKinds: ["text", "rect", "image", "scene"],
    parameters: {
      trackDistance: { name: "Track Distance", type: "number", description: "Pixels", default: 110, min: 20, max: 600 },
    },
    apply: (ctx, params) => {
      const { x } = getBaseCoords(ctx);
      return {
        tracks: [
          createTrack("x", [
            { frame: ctx.startFrame, value: x - Math.floor(params.trackDistance * 0.5), easing: "easeInOut" },
            { frame: ctx.endFrame, value: x + Math.floor(params.trackDistance * 0.5), easing: "easeInOut" },
          ]),
        ],
      };
    },
  },
  {
    id: "camera-truck-right",
    name: "Camera Truck Right",
    category: "camera",
    description: "Linear lateral dolly track moving alongside subject rightward.",
    tags: ["camera", "truck", "dolly", "lateral"],
    targetKinds: ["text", "rect", "image", "scene"],
    parameters: {
      trackDistance: { name: "Track Distance", type: "number", description: "Pixels", default: 110, min: 20, max: 600 },
    },
    apply: (ctx, params) => {
      const { x } = getBaseCoords(ctx);
      return {
        tracks: [
          createTrack("x", [
            { frame: ctx.startFrame, value: x + Math.floor(params.trackDistance * 0.5), easing: "easeInOut" },
            { frame: ctx.endFrame, value: x - Math.floor(params.trackDistance * 0.5), easing: "easeInOut" },
          ]),
        ],
      };
    },
  },
  {
    id: "camera-crash-zoom",
    name: "Crash Zoom Snap",
    category: "camera",
    description: "Extremely rapid Quentin Tarantino style snap crash zoom.",
    tags: ["camera", "crash-zoom", "snap", "dramatic"],
    targetKinds: ["text", "rect", "image", "scene"],
    parameters: {
      displacement: { name: "Displacement", type: "number", description: "Pixels", default: 60, min: 10, max: 200 },
      snapFrames: { name: "Snap Frames", type: "number", description: "Frames", default: 6, min: 2, max: 18 },
    },
    apply: (ctx, params) => {
      const { y } = getBaseCoords(ctx);
      const snap = Math.min(ctx.durationFrames, params.snapFrames);
      return {
        tracks: [
          createTrack("y", [
            { frame: ctx.startFrame, value: y, easing: "easeInOut" },
            { frame: ctx.startFrame + snap, value: y - params.displacement, easing: "easeInOut" },
          ]),
        ],
      };
    },
  },
  {
    id: "camera-tracking-shot",
    name: "Constant Velocity Tracking",
    category: "camera",
    description: "Linear constant-velocity tracking shot maintaining fluid uniform motion.",
    tags: ["camera", "tracking", "linear", "uniform"],
    targetKinds: ["text", "rect", "image", "scene"],
    parameters: {
      travel: { name: "Travel", type: "number", description: "Pixels", default: 80, min: 10, max: 500 },
    },
    apply: (ctx, params) => {
      const { x } = getBaseCoords(ctx);
      return {
        tracks: [
          createTrack("x", [
            { frame: ctx.startFrame, value: x - Math.floor(params.travel * 0.5), easing: "linear" },
            { frame: ctx.endFrame, value: x + Math.floor(params.travel * 0.5), easing: "linear" },
          ]),
        ],
      };
    },
  },
  {
    id: "camera-shake-subtle",
    name: "Subtle Motor Rumble",
    category: "camera",
    description: "Light mechanical motor vibration on the camera tripod.",
    tags: ["camera", "shake", "motor", "mechanical"],
    targetKinds: ["text", "rect", "image", "scene"],
    parameters: {
      intensity: { name: "Intensity", type: "number", description: "Pixels", default: 3, min: 1, max: 10 },
    },
    apply: (ctx, params) => {
      const { y } = getBaseCoords(ctx);
      const kfY: { frame: number; value: number }[] = [];
      let sign = 1;
      for (let f = ctx.startFrame; f <= ctx.endFrame; f += 2) {
        kfY.push({ frame: f, value: y + sign * params.intensity });
        sign = -sign;
      }
      return { tracks: [createTrack("y", kfY)] };
    },
  },
  {
    id: "camera-shake-explosive",
    name: "Explosive Shockwave Jolt",
    category: "camera",
    description: "Heavy shockwave impact jolting camera violently before settling.",
    tags: ["camera", "shockwave", "impact", "explosion"],
    targetKinds: ["text", "rect", "image", "scene"],
    parameters: {
      magnitude: { name: "Magnitude", type: "number", description: "Pixels", default: 28, min: 8, max: 100 },
      decayFrames: { name: "Decay Frames", type: "number", description: "Frames", default: 18, min: 6, max: 60 },
    },
    apply: (ctx, params) => {
      const { x, y } = getBaseCoords(ctx);
      const dur = Math.min(ctx.durationFrames, params.decayFrames);
      const f0 = ctx.startFrame;
      return {
        tracks: [
          createTrack("x", [
            { frame: f0, value: x + params.magnitude },
            { frame: f0 + 2, value: x - Math.floor(params.magnitude * 0.75) },
            { frame: f0 + 5, value: x + Math.floor(params.magnitude * 0.5) },
            { frame: f0 + 9, value: x - Math.floor(params.magnitude * 0.2) },
            { frame: f0 + dur, value: x },
          ]),
          createTrack("y", [
            { frame: f0, value: y - Math.floor(params.magnitude * 0.6) },
            { frame: f0 + 2, value: y + Math.floor(params.magnitude * 0.5) },
            { frame: f0 + 5, value: y - Math.floor(params.magnitude * 0.3) },
            { frame: f0 + dur, value: y },
          ]),
        ],
      };
    },
  },
  {
    id: "camera-tilt-up-reveal",
    name: "Tilt-Up Horizon Reveal",
    category: "camera",
    description: "Angles from grounded angle tilting upward to reveal headline.",
    tags: ["camera", "tilt", "reveal", "low-angle"],
    targetKinds: ["text", "rect", "image", "scene"],
    parameters: {
      angle: { name: "Tilt Angle", type: "number", description: "Degrees", default: 10, min: 2, max: 30 },
      durationFrames: { name: "Duration", type: "number", description: "Frames", default: 20, min: 6, max: 90 },
    },
    apply: (ctx, params) => {
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      return {
        tracks: [
          createTrack("rotation", [
            { frame: ctx.startFrame, value: params.angle, easing: "easeInOut" },
            { frame: ctx.startFrame + dur, value: 0, easing: "easeInOut" },
          ]),
        ],
      };
    },
  },
  {
    id: "camera-tilt-down-reveal",
    name: "Tilt-Down High-Angle Reveal",
    category: "camera",
    description: "Angles from high ceiling angle tilting downward to subject level.",
    tags: ["camera", "tilt", "reveal", "high-angle"],
    targetKinds: ["text", "rect", "image", "scene"],
    parameters: {
      angle: { name: "Tilt Angle", type: "number", description: "Degrees", default: -10, min: -30, max: -2 },
      durationFrames: { name: "Duration", type: "number", description: "Frames", default: 20, min: 6, max: 90 },
    },
    apply: (ctx, params) => {
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      return {
        tracks: [
          createTrack("rotation", [
            { frame: ctx.startFrame, value: params.angle, easing: "easeInOut" },
            { frame: ctx.startFrame + dur, value: 0, easing: "easeInOut" },
          ]),
        ],
      };
    },
  },
  {
    id: "camera-recenter-snap",
    name: "Recenter Snap",
    category: "camera",
    description: "Snaps off-center camera back to exact center frame.",
    tags: ["camera", "recenter", "snap", "framing"],
    targetKinds: ["text", "rect", "image", "scene"],
    parameters: {
      offset: { name: "Off-Center Offset", type: "number", description: "Pixels", default: 60, min: 10, max: 300 },
      snapFrames: { name: "Snap Frames", type: "number", description: "Frames", default: 12, min: 4, max: 40 },
    },
    apply: (ctx, params) => {
      const { x } = getBaseCoords(ctx);
      const snap = Math.min(ctx.durationFrames, params.snapFrames);
      return {
        tracks: [
          createTrack("x", [
            { frame: ctx.startFrame, value: x + params.offset, easing: "easeInOut" },
            { frame: ctx.startFrame + snap, value: x, easing: "easeInOut" },
          ]),
        ],
      };
    },
  },
  {
    id: "camera-orbit-drift-cw",
    name: "Orbit Drift CW",
    category: "camera",
    description: "Simulates continuous circular orbit pan circling subject clockwise.",
    tags: ["camera", "orbit", "pan", "cinematic"],
    targetKinds: ["text", "rect", "image", "scene"],
    parameters: {
      orbitRadius: { name: "Orbit Radius", type: "number", description: "Pixels", default: 18, min: 4, max: 60 },
      cycleFrames: { name: "Orbit Cycle", type: "number", description: "Frames", default: 45, min: 15, max: 150 },
    },
    apply: (ctx, params) => {
      const { x, y } = getBaseCoords(ctx);
      const kfX: { frame: number; value: number; easing?: "easeInOut" }[] = [];
      const kfY: { frame: number; value: number; easing?: "easeInOut" }[] = [];
      const period = Math.max(15, Math.floor(params.cycleFrames));
      for (let f = ctx.startFrame; f <= ctx.endFrame; f += period) {
        kfX.push({ frame: f, value: x, easing: "easeInOut" });
        kfX.push({ frame: Math.min(ctx.endFrame, f + Math.floor(period * 0.25)), value: x + params.orbitRadius, easing: "easeInOut" });
        kfX.push({ frame: Math.min(ctx.endFrame, f + Math.floor(period * 0.5)), value: x, easing: "easeInOut" });
        kfX.push({ frame: Math.min(ctx.endFrame, f + Math.floor(period * 0.75)), value: x - params.orbitRadius, easing: "easeInOut" });

        kfY.push({ frame: f, value: y - params.orbitRadius, easing: "easeInOut" });
        kfY.push({ frame: Math.min(ctx.endFrame, f + Math.floor(period * 0.25)), value: y, easing: "easeInOut" });
        kfY.push({ frame: Math.min(ctx.endFrame, f + Math.floor(period * 0.5)), value: y + params.orbitRadius, easing: "easeInOut" });
        kfY.push({ frame: Math.min(ctx.endFrame, f + Math.floor(period * 0.75)), value: y, easing: "easeInOut" });
      }
      kfX.push({ frame: ctx.endFrame, value: x, easing: "easeInOut" });
      kfY.push({ frame: ctx.endFrame, value: y - params.orbitRadius, easing: "easeInOut" });
      return { tracks: [createTrack("x", kfX), createTrack("y", kfY)] };
    },
  },
  {
    id: "camera-orbit-drift-ccw",
    name: "Orbit Drift CCW",
    category: "camera",
    description: "Simulates continuous circular orbit pan circling subject counter-clockwise.",
    tags: ["camera", "orbit", "pan", "cinematic"],
    targetKinds: ["text", "rect", "image", "scene"],
    parameters: {
      orbitRadius: { name: "Orbit Radius", type: "number", description: "Pixels", default: 18, min: 4, max: 60 },
      cycleFrames: { name: "Orbit Cycle", type: "number", description: "Frames", default: 45, min: 15, max: 150 },
    },
    apply: (ctx, params) => {
      const { x, y } = getBaseCoords(ctx);
      const kfX: { frame: number; value: number; easing?: "easeInOut" }[] = [];
      const kfY: { frame: number; value: number; easing?: "easeInOut" }[] = [];
      const period = Math.max(15, Math.floor(params.cycleFrames));
      for (let f = ctx.startFrame; f <= ctx.endFrame; f += period) {
        kfX.push({ frame: f, value: x, easing: "easeInOut" });
        kfX.push({ frame: Math.min(ctx.endFrame, f + Math.floor(period * 0.25)), value: x - params.orbitRadius, easing: "easeInOut" });
        kfX.push({ frame: Math.min(ctx.endFrame, f + Math.floor(period * 0.5)), value: x, easing: "easeInOut" });
        kfX.push({ frame: Math.min(ctx.endFrame, f + Math.floor(period * 0.75)), value: x + params.orbitRadius, easing: "easeInOut" });

        kfY.push({ frame: f, value: y - params.orbitRadius, easing: "easeInOut" });
        kfY.push({ frame: Math.min(ctx.endFrame, f + Math.floor(period * 0.25)), value: y, easing: "easeInOut" });
        kfY.push({ frame: Math.min(ctx.endFrame, f + Math.floor(period * 0.5)), value: y + params.orbitRadius, easing: "easeInOut" });
        kfY.push({ frame: Math.min(ctx.endFrame, f + Math.floor(period * 0.75)), value: y, easing: "easeInOut" });
      }
      kfX.push({ frame: ctx.endFrame, value: x, easing: "easeInOut" });
      kfY.push({ frame: ctx.endFrame, value: y - params.orbitRadius, easing: "easeInOut" });
      return { tracks: [createTrack("x", kfX), createTrack("y", kfY)] };
    },
  },
  {
    id: "camera-vertigo-dolly",
    name: "Vertigo Dolly Counter-Drift",
    category: "camera",
    description: "Simulates Hitchcock vertigo effect combining opposing horizontal and vertical vectors.",
    tags: ["camera", "vertigo", "hitchcock", "dolly-zoom"],
    targetKinds: ["text", "rect", "image", "scene"],
    parameters: {
      displacement: { name: "Displacement", type: "number", description: "Pixels", default: 45, min: 10, max: 200 },
    },
    apply: (ctx, params) => {
      const { x, y } = getBaseCoords(ctx);
      return {
        tracks: [
          createTrack("x", [
            { frame: ctx.startFrame, value: x + Math.floor(params.displacement * 0.5), easing: "easeInOut" },
            { frame: ctx.endFrame, value: x - Math.floor(params.displacement * 0.5), easing: "easeInOut" },
          ]),
          createTrack("y", [
            { frame: ctx.startFrame, value: y - params.displacement, easing: "easeInOut" },
            { frame: ctx.endFrame, value: y + params.displacement, easing: "easeInOut" },
          ]),
        ],
      };
    },
  },
  {
    id: "camera-whip-pan-up",
    name: "Camera Whip Tilt Up",
    category: "camera",
    description: "Rapid vertical whip pan snapping upward.",
    tags: ["camera", "whip", "vertical"],
    targetKinds: ["text", "rect", "image", "scene"],
    parameters: {
      distance: { name: "Travel Distance", type: "number", description: "Pixels", default: 220, min: 40, max: 1000 },
      durationFrames: { name: "Duration", type: "number", description: "Frames", default: 8, min: 3, max: 24 },
    },
    apply: (ctx, params) => {
      const { y } = getBaseCoords(ctx);
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      return {
        tracks: [
          createTrack("y", [
            { frame: ctx.startFrame, value: y, easing: "easeInOut" },
            { frame: ctx.startFrame + dur, value: y + params.distance, easing: "linear" },
          ]),
        ],
      };
    },
  },
  {
    id: "camera-whip-pan-down",
    name: "Camera Whip Tilt Down",
    category: "camera",
    description: "Rapid vertical whip pan snapping downward.",
    tags: ["camera", "whip", "vertical"],
    targetKinds: ["text", "rect", "image", "scene"],
    parameters: {
      distance: { name: "Travel Distance", type: "number", description: "Pixels", default: 220, min: 40, max: 1000 },
      durationFrames: { name: "Duration", type: "number", description: "Frames", default: 8, min: 3, max: 24 },
    },
    apply: (ctx, params) => {
      const { y } = getBaseCoords(ctx);
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      return {
        tracks: [
          createTrack("y", [
            { frame: ctx.startFrame, value: y, easing: "easeInOut" },
            { frame: ctx.startFrame + dur, value: y - params.distance, easing: "linear" },
          ]),
        ],
      };
    },
  },
  {
    id: "camera-parallax-layer",
    name: "Parallax Layer Drift",
    category: "camera",
    description: "Slow relative differential drift creating depth perception against background.",
    tags: ["camera", "parallax", "depth", "cinematic"],
    targetKinds: ["text", "rect", "image", "scene"],
    parameters: {
      rate: { name: "Parallax Rate", type: "number", description: "Drift pixels", default: 25, min: 5, max: 100 },
    },
    apply: (ctx, params) => {
      const { x } = getBaseCoords(ctx);
      return {
        tracks: [
          createTrack("x", [
            { frame: ctx.startFrame, value: x - params.rate, easing: "linear" },
            { frame: ctx.endFrame, value: x + params.rate, easing: "linear" },
          ]),
        ],
      };
    },
  },
];
