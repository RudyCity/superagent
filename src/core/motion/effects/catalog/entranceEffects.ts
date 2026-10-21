import type { EffectDefinition } from "../types.js";
import { createTrack } from "../registry.js";

function getBaseCoords(ctx: any): { x: number; y: number } {
  return {
    x: ctx.targetLayer?.x ?? 0,
    y: ctx.targetLayer?.y ?? 0,
  };
}

export const entranceEffects: EffectDefinition[] = [
  {
    id: "entrance-fade-in",
    name: "Fade In",
    category: "entrance",
    description: "Smooth linear or eased opacity rise from transparent to fully opaque.",
    tags: ["fade", "opacity", "smooth", "basic"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      durationFrames: { name: "Duration", type: "number", description: "Frames to complete fade", default: 15, min: 2, max: 120 },
      easing: { name: "Easing", type: "enum", description: "Easing function", default: "easeInOut", choices: ["linear", "easeInOut"] },
    },
    apply: (ctx, params) => {
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      return {
        tracks: [
          createTrack("opacity", [
            { frame: ctx.startFrame, value: 0, easing: params.easing },
            { frame: ctx.startFrame + dur, value: 1, easing: "linear" },
          ]),
        ],
      };
    },
  },
  {
    id: "entrance-slide-left",
    name: "Slide from Right",
    category: "entrance",
    description: "Enters smoothly by sliding leftward from an offset.",
    tags: ["slide", "horizontal", "entrance"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      offset: { name: "Offset", type: "number", description: "Distance in pixels", default: 120, min: 10, max: 2000 },
      durationFrames: { name: "Duration", type: "number", description: "Frames to arrival", default: 14, min: 2, max: 90 },
      withFade: { name: "Fade in", type: "boolean", description: "Fade opacity concurrently", default: true },
    },
    apply: (ctx, params) => {
      const { x } = getBaseCoords(ctx);
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      const tracks = [
        createTrack("x", [
          { frame: ctx.startFrame, value: x + params.offset, easing: "easeInOut" },
          { frame: ctx.startFrame + dur, value: x, easing: "easeInOut" },
        ]),
      ];
      if (params.withFade) {
        tracks.push(
          createTrack("opacity", [
            { frame: ctx.startFrame, value: 0, easing: "easeInOut" },
            { frame: ctx.startFrame + dur, value: 1, easing: "linear" },
          ]),
        );
      }
      return { tracks };
    },
  },
  {
    id: "entrance-slide-right",
    name: "Slide from Left",
    category: "entrance",
    description: "Enters smoothly by sliding rightward from a negative horizontal offset.",
    tags: ["slide", "horizontal", "entrance"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      offset: { name: "Offset", type: "number", description: "Distance in pixels", default: 120, min: 10, max: 2000 },
      durationFrames: { name: "Duration", type: "number", description: "Frames to arrival", default: 14, min: 2, max: 90 },
      withFade: { name: "Fade in", type: "boolean", description: "Fade opacity concurrently", default: true },
    },
    apply: (ctx, params) => {
      const { x } = getBaseCoords(ctx);
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      const tracks = [
        createTrack("x", [
          { frame: ctx.startFrame, value: x - params.offset, easing: "easeInOut" },
          { frame: ctx.startFrame + dur, value: x, easing: "easeInOut" },
        ]),
      ];
      if (params.withFade) {
        tracks.push(
          createTrack("opacity", [
            { frame: ctx.startFrame, value: 0, easing: "easeInOut" },
            { frame: ctx.startFrame + dur, value: 1, easing: "linear" },
          ]),
        );
      }
      return { tracks };
    },
  },
  {
    id: "entrance-slide-up",
    name: "Slide Upward",
    category: "entrance",
    description: "Rises upward from below into its target anchor position.",
    tags: ["slide", "vertical", "rise", "entrance"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      offset: { name: "Offset", type: "number", description: "Distance in pixels", default: 100, min: 10, max: 2000 },
      durationFrames: { name: "Duration", type: "number", description: "Frames to arrival", default: 14, min: 2, max: 90 },
      withFade: { name: "Fade in", type: "boolean", description: "Fade opacity concurrently", default: true },
    },
    apply: (ctx, params) => {
      const { y } = getBaseCoords(ctx);
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      const tracks = [
        createTrack("y", [
          { frame: ctx.startFrame, value: y + params.offset, easing: "easeInOut" },
          { frame: ctx.startFrame + dur, value: y, easing: "easeInOut" },
        ]),
      ];
      if (params.withFade) {
        tracks.push(
          createTrack("opacity", [
            { frame: ctx.startFrame, value: 0, easing: "easeInOut" },
            { frame: ctx.startFrame + dur, value: 1, easing: "linear" },
          ]),
        );
      }
      return { tracks };
    },
  },
  {
    id: "entrance-slide-down",
    name: "Slide Downward",
    category: "entrance",
    description: "Descends downward from above into its target anchor position.",
    tags: ["slide", "vertical", "descend", "entrance"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      offset: { name: "Offset", type: "number", description: "Distance in pixels", default: 100, min: 10, max: 2000 },
      durationFrames: { name: "Duration", type: "number", description: "Frames to arrival", default: 14, min: 2, max: 90 },
      withFade: { name: "Fade in", type: "boolean", description: "Fade opacity concurrently", default: true },
    },
    apply: (ctx, params) => {
      const { y } = getBaseCoords(ctx);
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      const tracks = [
        createTrack("y", [
          { frame: ctx.startFrame, value: y - params.offset, easing: "easeInOut" },
          { frame: ctx.startFrame + dur, value: y, easing: "easeInOut" },
        ]),
      ];
      if (params.withFade) {
        tracks.push(
          createTrack("opacity", [
            { frame: ctx.startFrame, value: 0, easing: "easeInOut" },
            { frame: ctx.startFrame + dur, value: 1, easing: "linear" },
          ]),
        );
      }
      return { tracks };
    },
  },
  {
    id: "entrance-pop-left",
    name: "Pop from Right",
    category: "entrance",
    description: "Brisk entrance with spring-like overshoot settling from right.",
    tags: ["pop", "overshoot", "spring", "horizontal"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      offset: { name: "Offset", type: "number", description: "Distance in pixels", default: 160, min: 20, max: 2000 },
      durationFrames: { name: "Duration", type: "number", description: "Frames to arrival", default: 15, min: 3, max: 90 },
    },
    apply: (ctx, params) => {
      const { x } = getBaseCoords(ctx);
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      return {
        tracks: [
          createTrack("x", [
            { frame: ctx.startFrame, value: x + params.offset, easing: "easeOutBack" },
            { frame: ctx.startFrame + dur, value: x, easing: "easeInOut" },
          ]),
          createTrack("opacity", [
            { frame: ctx.startFrame, value: 0, easing: "easeInOut" },
            { frame: ctx.startFrame + Math.min(dur, 8), value: 1, easing: "linear" },
          ]),
        ],
      };
    },
  },
  {
    id: "entrance-pop-right",
    name: "Pop from Left",
    category: "entrance",
    description: "Brisk entrance with spring-like overshoot settling from left.",
    tags: ["pop", "overshoot", "spring", "horizontal"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      offset: { name: "Offset", type: "number", description: "Distance in pixels", default: 160, min: 20, max: 2000 },
      durationFrames: { name: "Duration", type: "number", description: "Frames to arrival", default: 15, min: 3, max: 90 },
    },
    apply: (ctx, params) => {
      const { x } = getBaseCoords(ctx);
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      return {
        tracks: [
          createTrack("x", [
            { frame: ctx.startFrame, value: x - params.offset, easing: "easeOutBack" },
            { frame: ctx.startFrame + dur, value: x, easing: "easeInOut" },
          ]),
          createTrack("opacity", [
            { frame: ctx.startFrame, value: 0, easing: "easeInOut" },
            { frame: ctx.startFrame + Math.min(dur, 8), value: 1, easing: "linear" },
          ]),
        ],
      };
    },
  },
  {
    id: "entrance-pop-up",
    name: "Pop Upward",
    category: "entrance",
    description: "Spring-loaded entrance surging upward with snappy overshoot settling.",
    tags: ["pop", "overshoot", "spring", "vertical"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      offset: { name: "Offset", type: "number", description: "Distance in pixels", default: 150, min: 20, max: 2000 },
      durationFrames: { name: "Duration", type: "number", description: "Frames to arrival", default: 15, min: 3, max: 90 },
    },
    apply: (ctx, params) => {
      const { y } = getBaseCoords(ctx);
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      return {
        tracks: [
          createTrack("y", [
            { frame: ctx.startFrame, value: y + params.offset, easing: "easeOutBack" },
            { frame: ctx.startFrame + dur, value: y, easing: "easeInOut" },
          ]),
          createTrack("opacity", [
            { frame: ctx.startFrame, value: 0, easing: "easeInOut" },
            { frame: ctx.startFrame + Math.min(dur, 8), value: 1, easing: "linear" },
          ]),
        ],
      };
    },
  },
  {
    id: "entrance-pop-down",
    name: "Pop Downward",
    category: "entrance",
    description: "Spring-loaded entrance plunging downward with snappy overshoot settling.",
    tags: ["pop", "overshoot", "spring", "vertical"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      offset: { name: "Offset", type: "number", description: "Distance in pixels", default: 150, min: 20, max: 2000 },
      durationFrames: { name: "Duration", type: "number", description: "Frames to arrival", default: 15, min: 3, max: 90 },
    },
    apply: (ctx, params) => {
      const { y } = getBaseCoords(ctx);
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      return {
        tracks: [
          createTrack("y", [
            { frame: ctx.startFrame, value: y - params.offset, easing: "easeOutBack" },
            { frame: ctx.startFrame + dur, value: y, easing: "easeInOut" },
          ]),
          createTrack("opacity", [
            { frame: ctx.startFrame, value: 0, easing: "easeInOut" },
            { frame: ctx.startFrame + Math.min(dur, 8), value: 1, easing: "linear" },
          ]),
        ],
      };
    },
  },
  {
    id: "entrance-drop-in",
    name: "Drop In",
    category: "entrance",
    description: "Drops vertically with high initial velocity and soft landing.",
    tags: ["drop", "gravity", "vertical"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      offset: { name: "Drop Height", type: "number", description: "Height above target", default: 120, min: 10, max: 2000 },
      durationFrames: { name: "Duration", type: "number", description: "Frames to landing", default: 14, min: 2, max: 90 },
    },
    apply: (ctx, params) => {
      const { y } = getBaseCoords(ctx);
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      return {
        tracks: [
          createTrack("y", [
            { frame: ctx.startFrame, value: y - params.offset, easing: "easeInOut" },
            { frame: ctx.startFrame + dur, value: y, easing: "easeInOut" },
          ]),
          createTrack("opacity", [
            { frame: ctx.startFrame, value: 0, easing: "easeInOut" },
            { frame: ctx.startFrame + Math.min(dur, 6), value: 1, easing: "linear" },
          ]),
        ],
      };
    },
  },
  {
    id: "entrance-spring-drop",
    name: "Spring Drop",
    category: "entrance",
    description: "Drops with overshoot gravity rebound before resting at anchor.",
    tags: ["drop", "spring", "rebound"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      offset: { name: "Drop Height", type: "number", description: "Height in pixels", default: 180, min: 20, max: 2000 },
      durationFrames: { name: "Duration", type: "number", description: "Frames to settle", default: 16, min: 3, max: 90 },
    },
    apply: (ctx, params) => {
      const { y } = getBaseCoords(ctx);
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      return {
        tracks: [
          createTrack("y", [
            { frame: ctx.startFrame, value: y - params.offset, easing: "easeOutBack" },
            { frame: ctx.startFrame + dur, value: y, easing: "easeInOut" },
          ]),
          createTrack("opacity", [
            { frame: ctx.startFrame, value: 0, easing: "easeInOut" },
            { frame: ctx.startFrame + Math.min(dur, 6), value: 1, easing: "linear" },
          ]),
        ],
      };
    },
  },
  {
    id: "entrance-tilt-cw",
    name: "Tilt Clockwise",
    category: "entrance",
    description: "Enters rotated clockwise, straightening to upright orientation.",
    tags: ["rotation", "tilt", "entrance"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      angle: { name: "Starting Angle", type: "number", description: "Initial tilt in degrees", default: 12, min: 1, max: 180 },
      durationFrames: { name: "Duration", type: "number", description: "Frames to straighten", default: 14, min: 2, max: 90 },
    },
    apply: (ctx, params) => {
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      return {
        tracks: [
          createTrack("rotation", [
            { frame: ctx.startFrame, value: params.angle, easing: "easeInOut" },
            { frame: ctx.startFrame + dur, value: 0, easing: "easeInOut" },
          ]),
          createTrack("opacity", [
            { frame: ctx.startFrame, value: 0, easing: "easeInOut" },
            { frame: ctx.startFrame + dur, value: 1, easing: "linear" },
          ]),
        ],
      };
    },
  },
  {
    id: "entrance-tilt-ccw",
    name: "Tilt Counter-Clockwise",
    category: "entrance",
    description: "Enters rotated counter-clockwise, straightening to upright orientation.",
    tags: ["rotation", "tilt", "entrance"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      angle: { name: "Starting Angle", type: "number", description: "Initial tilt in degrees", default: -12, min: -180, max: -1 },
      durationFrames: { name: "Duration", type: "number", description: "Frames to straighten", default: 14, min: 2, max: 90 },
    },
    apply: (ctx, params) => {
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      return {
        tracks: [
          createTrack("rotation", [
            { frame: ctx.startFrame, value: params.angle, easing: "easeInOut" },
            { frame: ctx.startFrame + dur, value: 0, easing: "easeInOut" },
          ]),
          createTrack("opacity", [
            { frame: ctx.startFrame, value: 0, easing: "easeInOut" },
            { frame: ctx.startFrame + dur, value: 1, easing: "linear" },
          ]),
        ],
      };
    },
  },
  {
    id: "entrance-swing",
    name: "Swing In",
    category: "entrance",
    description: "Pendulum swing with spring rebound into stable level posture.",
    tags: ["swing", "pendulum", "rotation"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      amplitude: { name: "Swing Angle", type: "number", description: "Initial angle in degrees", default: 18, min: 2, max: 90 },
      durationFrames: { name: "Duration", type: "number", description: "Frames to stabilize", default: 16, min: 3, max: 90 },
    },
    apply: (ctx, params) => {
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      return {
        tracks: [
          createTrack("rotation", [
            { frame: ctx.startFrame, value: params.amplitude, easing: "easeOutBack" },
            { frame: ctx.startFrame + dur, value: 0, easing: "easeInOut" },
          ]),
          createTrack("opacity", [
            { frame: ctx.startFrame, value: 0, easing: "easeInOut" },
            { frame: ctx.startFrame + Math.min(dur, 6), value: 1, easing: "linear" },
          ]),
        ],
      };
    },
  },
  {
    id: "entrance-diagonal-tl",
    name: "Diagonal from Top-Left",
    category: "entrance",
    description: "Enters simultaneously along X and Y from top-left quadrant.",
    tags: ["diagonal", "entrance", "corner"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      offsetX: { name: "X Offset", type: "number", description: "Distance left in pixels", default: 140, min: 10, max: 2000 },
      offsetY: { name: "Y Offset", type: "number", description: "Distance up in pixels", default: 100, min: 10, max: 2000 },
      durationFrames: { name: "Duration", type: "number", description: "Frames to arrival", default: 14, min: 2, max: 90 },
    },
    apply: (ctx, params) => {
      const { x, y } = getBaseCoords(ctx);
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      return {
        tracks: [
          createTrack("x", [
            { frame: ctx.startFrame, value: x - params.offsetX, easing: "easeInOut" },
            { frame: ctx.startFrame + dur, value: x, easing: "easeInOut" },
          ]),
          createTrack("y", [
            { frame: ctx.startFrame, value: y - params.offsetY, easing: "easeInOut" },
            { frame: ctx.startFrame + dur, value: y, easing: "easeInOut" },
          ]),
          createTrack("opacity", [
            { frame: ctx.startFrame, value: 0, easing: "easeInOut" },
            { frame: ctx.startFrame + dur, value: 1, easing: "linear" },
          ]),
        ],
      };
    },
  },
  {
    id: "entrance-diagonal-tr",
    name: "Diagonal from Top-Right",
    category: "entrance",
    description: "Enters simultaneously along X and Y from top-right quadrant.",
    tags: ["diagonal", "entrance", "corner"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      offsetX: { name: "X Offset", type: "number", description: "Distance right in pixels", default: 140, min: 10, max: 2000 },
      offsetY: { name: "Y Offset", type: "number", description: "Distance up in pixels", default: 100, min: 10, max: 2000 },
      durationFrames: { name: "Duration", type: "number", description: "Frames to arrival", default: 14, min: 2, max: 90 },
    },
    apply: (ctx, params) => {
      const { x, y } = getBaseCoords(ctx);
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      return {
        tracks: [
          createTrack("x", [
            { frame: ctx.startFrame, value: x + params.offsetX, easing: "easeInOut" },
            { frame: ctx.startFrame + dur, value: x, easing: "easeInOut" },
          ]),
          createTrack("y", [
            { frame: ctx.startFrame, value: y - params.offsetY, easing: "easeInOut" },
            { frame: ctx.startFrame + dur, value: y, easing: "easeInOut" },
          ]),
          createTrack("opacity", [
            { frame: ctx.startFrame, value: 0, easing: "easeInOut" },
            { frame: ctx.startFrame + dur, value: 1, easing: "linear" },
          ]),
        ],
      };
    },
  },
  {
    id: "entrance-diagonal-bl",
    name: "Diagonal from Bottom-Left",
    category: "entrance",
    description: "Enters simultaneously along X and Y from bottom-left quadrant.",
    tags: ["diagonal", "entrance", "corner"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      offsetX: { name: "X Offset", type: "number", description: "Distance left in pixels", default: 140, min: 10, max: 2000 },
      offsetY: { name: "Y Offset", type: "number", description: "Distance down in pixels", default: 100, min: 10, max: 2000 },
      durationFrames: { name: "Duration", type: "number", description: "Frames to arrival", default: 14, min: 2, max: 90 },
    },
    apply: (ctx, params) => {
      const { x, y } = getBaseCoords(ctx);
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      return {
        tracks: [
          createTrack("x", [
            { frame: ctx.startFrame, value: x - params.offsetX, easing: "easeInOut" },
            { frame: ctx.startFrame + dur, value: x, easing: "easeInOut" },
          ]),
          createTrack("y", [
            { frame: ctx.startFrame, value: y + params.offsetY, easing: "easeInOut" },
            { frame: ctx.startFrame + dur, value: y, easing: "easeInOut" },
          ]),
          createTrack("opacity", [
            { frame: ctx.startFrame, value: 0, easing: "easeInOut" },
            { frame: ctx.startFrame + dur, value: 1, easing: "linear" },
          ]),
        ],
      };
    },
  },
  {
    id: "entrance-diagonal-br",
    name: "Diagonal from Bottom-Right",
    category: "entrance",
    description: "Enters simultaneously along X and Y from bottom-right quadrant.",
    tags: ["diagonal", "entrance", "corner"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      offsetX: { name: "X Offset", type: "number", description: "Distance right in pixels", default: 140, min: 10, max: 2000 },
      offsetY: { name: "Y Offset", type: "number", description: "Distance down in pixels", default: 100, min: 10, max: 2000 },
      durationFrames: { name: "Duration", type: "number", description: "Frames to arrival", default: 14, min: 2, max: 90 },
    },
    apply: (ctx, params) => {
      const { x, y } = getBaseCoords(ctx);
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      return {
        tracks: [
          createTrack("x", [
            { frame: ctx.startFrame, value: x + params.offsetX, easing: "easeInOut" },
            { frame: ctx.startFrame + dur, value: x, easing: "easeInOut" },
          ]),
          createTrack("y", [
            { frame: ctx.startFrame, value: y + params.offsetY, easing: "easeInOut" },
            { frame: ctx.startFrame + dur, value: y, easing: "easeInOut" },
          ]),
          createTrack("opacity", [
            { frame: ctx.startFrame, value: 0, easing: "easeInOut" },
            { frame: ctx.startFrame + dur, value: 1, easing: "linear" },
          ]),
        ],
      };
    },
  },
  {
    id: "entrance-whip-left",
    name: "Whip Pan Left",
    category: "entrance",
    description: "High-velocity kinetic snap arriving from extreme right with rapid deceleration.",
    tags: ["whip", "fast", "velocity", "snap"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      offset: { name: "Distance", type: "number", description: "Distance in pixels", default: 320, min: 50, max: 3000 },
      durationFrames: { name: "Duration", type: "number", description: "Fast frame duration", default: 8, min: 2, max: 30 },
    },
    apply: (ctx, params) => {
      const { x } = getBaseCoords(ctx);
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      return {
        tracks: [
          createTrack("x", [
            { frame: ctx.startFrame, value: x + params.offset, easing: "easeInOut" },
            { frame: ctx.startFrame + dur, value: x, easing: "linear" },
          ]),
          createTrack("opacity", [
            { frame: ctx.startFrame, value: 0, easing: "easeInOut" },
            { frame: ctx.startFrame + Math.min(dur, 3), value: 1, easing: "linear" },
          ]),
        ],
      };
    },
  },
  {
    id: "entrance-whip-right",
    name: "Whip Pan Right",
    category: "entrance",
    description: "High-velocity kinetic snap arriving from extreme left with rapid deceleration.",
    tags: ["whip", "fast", "velocity", "snap"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      offset: { name: "Distance", type: "number", description: "Distance in pixels", default: 320, min: 50, max: 3000 },
      durationFrames: { name: "Duration", type: "number", description: "Fast frame duration", default: 8, min: 2, max: 30 },
    },
    apply: (ctx, params) => {
      const { x } = getBaseCoords(ctx);
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      return {
        tracks: [
          createTrack("x", [
            { frame: ctx.startFrame, value: x - params.offset, easing: "easeInOut" },
            { frame: ctx.startFrame + dur, value: x, easing: "linear" },
          ]),
          createTrack("opacity", [
            { frame: ctx.startFrame, value: 0, easing: "easeInOut" },
            { frame: ctx.startFrame + Math.min(dur, 3), value: 1, easing: "linear" },
          ]),
        ],
      };
    },
  },
  {
    id: "entrance-whip-up",
    name: "Whip Pan Upward",
    category: "entrance",
    description: "High-velocity vertical snap rocketing upward from below.",
    tags: ["whip", "fast", "vertical", "snap"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      offset: { name: "Distance", type: "number", description: "Distance in pixels", default: 280, min: 50, max: 3000 },
      durationFrames: { name: "Duration", type: "number", description: "Fast frame duration", default: 8, min: 2, max: 30 },
    },
    apply: (ctx, params) => {
      const { y } = getBaseCoords(ctx);
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      return {
        tracks: [
          createTrack("y", [
            { frame: ctx.startFrame, value: y + params.offset, easing: "easeInOut" },
            { frame: ctx.startFrame + dur, value: y, easing: "linear" },
          ]),
          createTrack("opacity", [
            { frame: ctx.startFrame, value: 0, easing: "easeInOut" },
            { frame: ctx.startFrame + Math.min(dur, 3), value: 1, easing: "linear" },
          ]),
        ],
      };
    },
  },
  {
    id: "entrance-whip-down",
    name: "Whip Pan Downward",
    category: "entrance",
    description: "High-velocity vertical snap driving downward into position.",
    tags: ["whip", "fast", "vertical", "snap"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      offset: { name: "Distance", type: "number", description: "Distance in pixels", default: 280, min: 50, max: 3000 },
      durationFrames: { name: "Duration", type: "number", description: "Fast frame duration", default: 8, min: 2, max: 30 },
    },
    apply: (ctx, params) => {
      const { y } = getBaseCoords(ctx);
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      return {
        tracks: [
          createTrack("y", [
            { frame: ctx.startFrame, value: y - params.offset, easing: "easeInOut" },
            { frame: ctx.startFrame + dur, value: y, easing: "linear" },
          ]),
          createTrack("opacity", [
            { frame: ctx.startFrame, value: 0, easing: "easeInOut" },
            { frame: ctx.startFrame + Math.min(dur, 3), value: 1, easing: "linear" },
          ]),
        ],
      };
    },
  },
  {
    id: "entrance-drift-slow",
    name: "Slow Drift Entrance",
    category: "entrance",
    description: "Gentle, atmospheric slow-motion horizontal drift.",
    tags: ["drift", "slow", "ambient", "calm"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      offset: { name: "Offset", type: "number", description: "Subtle pixel displacement", default: 45, min: 5, max: 300 },
      durationFrames: { name: "Duration", type: "number", description: "Frames for full drift", default: 40, min: 10, max: 180 },
    },
    apply: (ctx, params) => {
      const { x } = getBaseCoords(ctx);
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      return {
        tracks: [
          createTrack("x", [
            { frame: ctx.startFrame, value: x - params.offset, easing: "easeInOut" },
            { frame: ctx.startFrame + dur, value: x, easing: "linear" },
          ]),
          createTrack("opacity", [
            { frame: ctx.startFrame, value: 0, easing: "easeInOut" },
            { frame: ctx.startFrame + Math.floor(dur * 0.4), value: 1, easing: "linear" },
          ]),
        ],
      };
    },
  },
  {
    id: "entrance-drift-rise",
    name: "Slow Drift Rise",
    category: "entrance",
    description: "Gentle upward levitation with progressive illumination.",
    tags: ["drift", "rise", "ambient", "calm"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      offset: { name: "Offset", type: "number", description: "Subtle pixel displacement", default: 40, min: 5, max: 300 },
      durationFrames: { name: "Duration", type: "number", description: "Frames for full rise", default: 40, min: 10, max: 180 },
    },
    apply: (ctx, params) => {
      const { y } = getBaseCoords(ctx);
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      return {
        tracks: [
          createTrack("y", [
            { frame: ctx.startFrame, value: y + params.offset, easing: "easeInOut" },
            { frame: ctx.startFrame + dur, value: y, easing: "linear" },
          ]),
          createTrack("opacity", [
            { frame: ctx.startFrame, value: 0, easing: "easeInOut" },
            { frame: ctx.startFrame + Math.floor(dur * 0.4), value: 1, easing: "linear" },
          ]),
        ],
      };
    },
  },
  {
    id: "entrance-spin-in",
    name: "Full Spin In CW",
    category: "entrance",
    description: "Rotates 360 degrees clockwise while expanding in opacity.",
    tags: ["spin", "rotation", "entrance"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      durationFrames: { name: "Duration", type: "number", description: "Frames for rotation", default: 18, min: 4, max: 90 },
      rebound: { name: "Rebound", type: "boolean", description: "Overshoot rotation settling", default: true },
    },
    apply: (ctx, params) => {
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      const easing = params.rebound ? "easeOutBack" : "easeInOut";
      return {
        tracks: [
          createTrack("rotation", [
            { frame: ctx.startFrame, value: 360, easing },
            { frame: ctx.startFrame + dur, value: 0, easing: "easeInOut" },
          ]),
          createTrack("opacity", [
            { frame: ctx.startFrame, value: 0, easing: "easeInOut" },
            { frame: ctx.startFrame + Math.min(dur, 8), value: 1, easing: "linear" },
          ]),
        ],
      };
    },
  },
  {
    id: "entrance-spin-in-ccw",
    name: "Full Spin In CCW",
    category: "entrance",
    description: "Rotates -360 degrees counter-clockwise while expanding in opacity.",
    tags: ["spin", "rotation", "entrance"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      durationFrames: { name: "Duration", type: "number", description: "Frames for rotation", default: 18, min: 4, max: 90 },
      rebound: { name: "Rebound", type: "boolean", description: "Overshoot rotation settling", default: true },
    },
    apply: (ctx, params) => {
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      const easing = params.rebound ? "easeOutBack" : "easeInOut";
      return {
        tracks: [
          createTrack("rotation", [
            { frame: ctx.startFrame, value: -360, easing },
            { frame: ctx.startFrame + dur, value: 0, easing: "easeInOut" },
          ]),
          createTrack("opacity", [
            { frame: ctx.startFrame, value: 0, easing: "easeInOut" },
            { frame: ctx.startFrame + Math.min(dur, 8), value: 1, easing: "linear" },
          ]),
        ],
      };
    },
  },
  {
    id: "entrance-half-spin",
    name: "Half Flip CW",
    category: "entrance",
    description: "Rotates 180 degrees clockwise into face-forward orientation.",
    tags: ["flip", "rotation", "entrance"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      durationFrames: { name: "Duration", type: "number", description: "Frames for flip", default: 14, min: 3, max: 60 },
    },
    apply: (ctx, params) => {
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      return {
        tracks: [
          createTrack("rotation", [
            { frame: ctx.startFrame, value: 180, easing: "easeOutBack" },
            { frame: ctx.startFrame + dur, value: 0, easing: "easeInOut" },
          ]),
          createTrack("opacity", [
            { frame: ctx.startFrame, value: 0, easing: "easeInOut" },
            { frame: ctx.startFrame + Math.min(dur, 6), value: 1, easing: "linear" },
          ]),
        ],
      };
    },
  },
  {
    id: "entrance-half-spin-ccw",
    name: "Half Flip CCW",
    category: "entrance",
    description: "Rotates -180 degrees counter-clockwise into face-forward orientation.",
    tags: ["flip", "rotation", "entrance"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      durationFrames: { name: "Duration", type: "number", description: "Frames for flip", default: 14, min: 3, max: 60 },
    },
    apply: (ctx, params) => {
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      return {
        tracks: [
          createTrack("rotation", [
            { frame: ctx.startFrame, value: -180, easing: "easeOutBack" },
            { frame: ctx.startFrame + dur, value: 0, easing: "easeInOut" },
          ]),
          createTrack("opacity", [
            { frame: ctx.startFrame, value: 0, easing: "easeInOut" },
            { frame: ctx.startFrame + Math.min(dur, 6), value: 1, easing: "linear" },
          ]),
        ],
      };
    },
  },
  {
    id: "entrance-step-reveal",
    name: "Stepped Stutter Reveal",
    category: "entrance",
    description: "Arrives in discrete quantized mechanical steps.",
    tags: ["step", "mechanical", "tech", "staccato"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      offset: { name: "Offset", type: "number", description: "Distance in pixels", default: 120, min: 20, max: 800 },
      steps: { name: "Steps", type: "number", description: "Number of steps", default: 3, min: 2, max: 6 },
      durationFrames: { name: "Duration", type: "number", description: "Total duration", default: 18, min: 6, max: 90 },
    },
    apply: (ctx, params) => {
      const { x } = getBaseCoords(ctx);
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      const stepCount = Math.floor(params.steps);
      const kfX: { frame: number; value: number; easing?: "step" | "linear" }[] = [];
      const kfOp: { frame: number; value: number; easing?: "step" | "linear" }[] = [];
      for (let s = 0; s <= stepCount; s++) {
        const f = ctx.startFrame + Math.floor((s * dur) / stepCount);
        const frac = s / stepCount;
        kfX.push({ frame: f, value: Math.round(x + params.offset * (1 - frac)), easing: "step" });
        kfOp.push({ frame: f, value: Number((0.2 + 0.8 * frac).toFixed(2)), easing: "step" });
      }
      return {
        tracks: [createTrack("x", kfX), createTrack("opacity", kfOp)],
      };
    },
  },
  {
    id: "entrance-cascade-drop",
    name: "Cascade Drop",
    category: "entrance",
    description: "Two-stage multi-tier descent pausing before finalizing anchor.",
    tags: ["drop", "staged", "cascade"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      offset: { name: "Height", type: "number", description: "Total drop in pixels", default: 160, min: 30, max: 1000 },
      durationFrames: { name: "Duration", type: "number", description: "Frames for cascade", default: 20, min: 8, max: 90 },
    },
    apply: (ctx, params) => {
      const { y } = getBaseCoords(ctx);
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      const mid = ctx.startFrame + Math.floor(dur * 0.55);
      return {
        tracks: [
          createTrack("y", [
            { frame: ctx.startFrame, value: y - params.offset, easing: "easeInOut" },
            { frame: mid, value: y - Math.floor(params.offset * 0.2), easing: "easeInOut" },
            { frame: ctx.startFrame + dur, value: y, easing: "easeInOut" },
          ]),
          createTrack("opacity", [
            { frame: ctx.startFrame, value: 0, easing: "easeInOut" },
            { frame: mid, value: 0.85, easing: "linear" },
            { frame: ctx.startFrame + dur, value: 1, easing: "linear" },
          ]),
        ],
      };
    },
  },
  {
    id: "entrance-elastic-pop",
    name: "Multi-Bounce Elastic Pop",
    category: "entrance",
    description: "Elastic multi-frame bounce oscillation along vertical axis.",
    tags: ["elastic", "bounce", "spring", "playful"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      amplitude: { name: "Amplitude", type: "number", description: "Initial displacement", default: 90, min: 20, max: 500 },
      durationFrames: { name: "Duration", type: "number", description: "Oscillation frames", default: 24, min: 10, max: 90 },
    },
    apply: (ctx, params) => {
      const { y } = getBaseCoords(ctx);
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      const f0 = ctx.startFrame;
      const f1 = f0 + Math.floor(dur * 0.4);
      const f2 = f0 + Math.floor(dur * 0.7);
      const f3 = f0 + dur;
      return {
        tracks: [
          createTrack("y", [
            { frame: f0, value: y + params.amplitude, easing: "easeInOut" },
            { frame: f1, value: y - Math.floor(params.amplitude * 0.35), easing: "easeInOut" },
            { frame: f2, value: y + Math.floor(params.amplitude * 0.12), easing: "easeInOut" },
            { frame: f3, value: y, easing: "easeInOut" },
          ]),
          createTrack("opacity", [
            { frame: f0, value: 0, easing: "easeInOut" },
            { frame: f1, value: 1, easing: "linear" },
          ]),
        ],
      };
    },
  },
  {
    id: "entrance-rebound-up",
    name: "Rebound Upward",
    category: "entrance",
    description: "Snaps upward from below, overshoots past anchor, and returns.",
    tags: ["rebound", "overshoot", "vertical"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      offset: { name: "Distance", type: "number", description: "Starting depth", default: 140, min: 30, max: 1000 },
      overshoot: { name: "Overshoot", type: "number", description: "Pass distance in pixels", default: 24, min: 5, max: 150 },
      durationFrames: { name: "Duration", type: "number", description: "Total duration", default: 18, min: 6, max: 90 },
    },
    apply: (ctx, params) => {
      const { y } = getBaseCoords(ctx);
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      const f0 = ctx.startFrame;
      const fMid = f0 + Math.floor(dur * 0.65);
      const fEnd = f0 + dur;
      return {
        tracks: [
          createTrack("y", [
            { frame: f0, value: y + params.offset, easing: "easeInOut" },
            { frame: fMid, value: y - params.overshoot, easing: "easeInOut" },
            { frame: fEnd, value: y, easing: "easeInOut" },
          ]),
          createTrack("opacity", [
            { frame: f0, value: 0, easing: "easeInOut" },
            { frame: fMid, value: 1, easing: "linear" },
          ]),
        ],
      };
    },
  },
  {
    id: "entrance-rebound-down",
    name: "Rebound Downward",
    category: "entrance",
    description: "Plunges downward from above, overshoots downward, and rebounds to anchor.",
    tags: ["rebound", "overshoot", "vertical"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      offset: { name: "Distance", type: "number", description: "Starting height", default: 140, min: 30, max: 1000 },
      overshoot: { name: "Overshoot", type: "number", description: "Pass distance in pixels", default: 24, min: 5, max: 150 },
      durationFrames: { name: "Duration", type: "number", description: "Total duration", default: 18, min: 6, max: 90 },
    },
    apply: (ctx, params) => {
      const { y } = getBaseCoords(ctx);
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      const f0 = ctx.startFrame;
      const fMid = f0 + Math.floor(dur * 0.65);
      const fEnd = f0 + dur;
      return {
        tracks: [
          createTrack("y", [
            { frame: f0, value: y - params.offset, easing: "easeInOut" },
            { frame: fMid, value: y + params.overshoot, easing: "easeInOut" },
            { frame: fEnd, value: y, easing: "easeInOut" },
          ]),
          createTrack("opacity", [
            { frame: f0, value: 0, easing: "easeInOut" },
            { frame: fMid, value: 1, easing: "linear" },
          ]),
        ],
      };
    },
  },
  {
    id: "entrance-glissando-left",
    name: "Glissando Glide Left",
    category: "entrance",
    description: "Long cinematic gliding entrance crossing significant horizontal space.",
    tags: ["glide", "cinematic", "smooth"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      offset: { name: "Distance", type: "number", description: "Travel distance", default: 450, min: 100, max: 3000 },
      durationFrames: { name: "Duration", type: "number", description: "Frames for glide", default: 30, min: 10, max: 120 },
    },
    apply: (ctx, params) => {
      const { x } = getBaseCoords(ctx);
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      return {
        tracks: [
          createTrack("x", [
            { frame: ctx.startFrame, value: x + params.offset, easing: "easeInOut" },
            { frame: ctx.startFrame + dur, value: x, easing: "easeInOut" },
          ]),
          createTrack("opacity", [
            { frame: ctx.startFrame, value: 0, easing: "easeInOut" },
            { frame: ctx.startFrame + Math.floor(dur * 0.35), value: 1, easing: "linear" },
          ]),
        ],
      };
    },
  },
  {
    id: "entrance-glissando-right",
    name: "Glissando Glide Right",
    category: "entrance",
    description: "Long cinematic gliding entrance crossing significant horizontal space from left.",
    tags: ["glide", "cinematic", "smooth"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      offset: { name: "Distance", type: "number", description: "Travel distance", default: 450, min: 100, max: 3000 },
      durationFrames: { name: "Duration", type: "number", description: "Frames for glide", default: 30, min: 10, max: 120 },
    },
    apply: (ctx, params) => {
      const { x } = getBaseCoords(ctx);
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      return {
        tracks: [
          createTrack("x", [
            { frame: ctx.startFrame, value: x - params.offset, easing: "easeInOut" },
            { frame: ctx.startFrame + dur, value: x, easing: "easeInOut" },
          ]),
          createTrack("opacity", [
            { frame: ctx.startFrame, value: 0, easing: "easeInOut" },
            { frame: ctx.startFrame + Math.floor(dur * 0.35), value: 1, easing: "linear" },
          ]),
        ],
      };
    },
  },
  {
    id: "entrance-vortex-in",
    name: "Vortex Spiral In",
    category: "entrance",
    description: "Converges into place with simultaneous rotation and diagonal translation.",
    tags: ["spiral", "vortex", "rotation", "entrance"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      rotations: { name: "Full Turns", type: "number", description: "Degrees to rotate", default: 180, min: 45, max: 720 },
      offset: { name: "Offset", type: "number", description: "Offset in pixels", default: 90, min: 20, max: 500 },
      durationFrames: { name: "Duration", type: "number", description: "Frames for spiral", default: 18, min: 5, max: 90 },
    },
    apply: (ctx, params) => {
      const { x, y } = getBaseCoords(ctx);
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      return {
        tracks: [
          createTrack("x", [
            { frame: ctx.startFrame, value: x + params.offset, easing: "easeInOut" },
            { frame: ctx.startFrame + dur, value: x, easing: "easeInOut" },
          ]),
          createTrack("y", [
            { frame: ctx.startFrame, value: y - params.offset, easing: "easeInOut" },
            { frame: ctx.startFrame + dur, value: y, easing: "easeInOut" },
          ]),
          createTrack("rotation", [
            { frame: ctx.startFrame, value: params.rotations, easing: "easeInOut" },
            { frame: ctx.startFrame + dur, value: 0, easing: "easeInOut" },
          ]),
          createTrack("opacity", [
            { frame: ctx.startFrame, value: 0, easing: "easeInOut" },
            { frame: ctx.startFrame + Math.min(dur, 6), value: 1, easing: "linear" },
          ]),
        ],
      };
    },
  },
];
