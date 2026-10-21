import type { EffectDefinition } from "../types.js";
import { createTrack } from "../registry.js";

function getBaseCoords(ctx: any): { x: number; y: number } {
  return {
    x: ctx.targetLayer?.x ?? 0,
    y: ctx.targetLayer?.y ?? 0,
  };
}

export const exitEffects: EffectDefinition[] = [
  {
    id: "exit-fade-out",
    name: "Fade Out",
    category: "exit",
    description: "Smooth linear or eased opacity drop from full visibility to transparent.",
    tags: ["fade", "opacity", "smooth", "exit"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      durationFrames: { name: "Duration", type: "number", description: "Frames to complete fade", default: 15, min: 2, max: 120 },
      easing: { name: "Easing", type: "enum", description: "Easing function", default: "easeInOut", choices: ["linear", "easeInOut"] },
    },
    apply: (ctx, params) => {
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      const exitStart = Math.max(ctx.startFrame, ctx.endFrame - dur);
      return {
        tracks: [
          createTrack("opacity", [
            { frame: ctx.startFrame, value: 1, easing: "linear" },
            { frame: exitStart, value: 1, easing: params.easing },
            { frame: ctx.endFrame, value: 0, easing: "linear" },
          ]),
        ],
      };
    },
  },
  {
    id: "exit-slide-left",
    name: "Slide Out Left",
    category: "exit",
    description: "Leaves the frame by sliding smoothly to the left.",
    tags: ["slide", "horizontal", "exit"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      offset: { name: "Offset", type: "number", description: "Exit travel distance in pixels", default: 160, min: 20, max: 2000 },
      durationFrames: { name: "Duration", type: "number", description: "Frames for exit", default: 14, min: 2, max: 90 },
    },
    apply: (ctx, params) => {
      const { x } = getBaseCoords(ctx);
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      const exitStart = Math.max(ctx.startFrame, ctx.endFrame - dur);
      return {
        tracks: [
          createTrack("x", [
            { frame: ctx.startFrame, value: x, easing: "linear" },
            { frame: exitStart, value: x, easing: "easeInOut" },
            { frame: ctx.endFrame, value: x - params.offset, easing: "easeInOut" },
          ]),
          createTrack("opacity", [
            { frame: ctx.startFrame, value: 1, easing: "linear" },
            { frame: exitStart, value: 1, easing: "easeInOut" },
            { frame: ctx.endFrame, value: 0, easing: "linear" },
          ]),
        ],
      };
    },
  },
  {
    id: "exit-slide-right",
    name: "Slide Out Right",
    category: "exit",
    description: "Leaves the frame by sliding smoothly to the right.",
    tags: ["slide", "horizontal", "exit"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      offset: { name: "Offset", type: "number", description: "Exit travel distance in pixels", default: 160, min: 20, max: 2000 },
      durationFrames: { name: "Duration", type: "number", description: "Frames for exit", default: 14, min: 2, max: 90 },
    },
    apply: (ctx, params) => {
      const { x } = getBaseCoords(ctx);
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      const exitStart = Math.max(ctx.startFrame, ctx.endFrame - dur);
      return {
        tracks: [
          createTrack("x", [
            { frame: ctx.startFrame, value: x, easing: "linear" },
            { frame: exitStart, value: x, easing: "easeInOut" },
            { frame: ctx.endFrame, value: x + params.offset, easing: "easeInOut" },
          ]),
          createTrack("opacity", [
            { frame: ctx.startFrame, value: 1, easing: "linear" },
            { frame: exitStart, value: 1, easing: "easeInOut" },
            { frame: ctx.endFrame, value: 0, easing: "linear" },
          ]),
        ],
      };
    },
  },
  {
    id: "exit-slide-up",
    name: "Slide Out Upward",
    category: "exit",
    description: "Leaves the frame by moving smoothly upward.",
    tags: ["slide", "vertical", "rise", "exit"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      offset: { name: "Offset", type: "number", description: "Distance in pixels", default: 140, min: 20, max: 2000 },
      durationFrames: { name: "Duration", type: "number", description: "Frames for exit", default: 14, min: 2, max: 90 },
    },
    apply: (ctx, params) => {
      const { y } = getBaseCoords(ctx);
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      const exitStart = Math.max(ctx.startFrame, ctx.endFrame - dur);
      return {
        tracks: [
          createTrack("y", [
            { frame: ctx.startFrame, value: y, easing: "linear" },
            { frame: exitStart, value: y, easing: "easeInOut" },
            { frame: ctx.endFrame, value: y - params.offset, easing: "easeInOut" },
          ]),
          createTrack("opacity", [
            { frame: ctx.startFrame, value: 1, easing: "linear" },
            { frame: exitStart, value: 1, easing: "easeInOut" },
            { frame: ctx.endFrame, value: 0, easing: "linear" },
          ]),
        ],
      };
    },
  },
  {
    id: "exit-slide-down",
    name: "Slide Out Downward",
    category: "exit",
    description: "Leaves the frame by descending downward.",
    tags: ["slide", "vertical", "descend", "exit"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      offset: { name: "Offset", type: "number", description: "Distance in pixels", default: 140, min: 20, max: 2000 },
      durationFrames: { name: "Duration", type: "number", description: "Frames for exit", default: 14, min: 2, max: 90 },
    },
    apply: (ctx, params) => {
      const { y } = getBaseCoords(ctx);
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      const exitStart = Math.max(ctx.startFrame, ctx.endFrame - dur);
      return {
        tracks: [
          createTrack("y", [
            { frame: ctx.startFrame, value: y, easing: "linear" },
            { frame: exitStart, value: y, easing: "easeInOut" },
            { frame: ctx.endFrame, value: y + params.offset, easing: "easeInOut" },
          ]),
          createTrack("opacity", [
            { frame: ctx.startFrame, value: 1, easing: "linear" },
            { frame: exitStart, value: 1, easing: "easeInOut" },
            { frame: ctx.endFrame, value: 0, easing: "linear" },
          ]),
        ],
      };
    },
  },
  {
    id: "exit-pop-left",
    name: "Pop Launch Left",
    category: "exit",
    description: "Anticipates slightly to the right, then snaps briskly off to the left.",
    tags: ["pop", "anticipation", "snap", "exit"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      offset: { name: "Offset", type: "number", description: "Launch distance", default: 220, min: 30, max: 2500 },
      durationFrames: { name: "Duration", type: "number", description: "Frames for exit", default: 15, min: 4, max: 90 },
    },
    apply: (ctx, params) => {
      const { x } = getBaseCoords(ctx);
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      const exitStart = Math.max(ctx.startFrame, ctx.endFrame - dur);
      const anticipate = exitStart + Math.floor(dur * 0.3);
      return {
        tracks: [
          createTrack("x", [
            { frame: ctx.startFrame, value: x, easing: "linear" },
            { frame: exitStart, value: x, easing: "easeInOut" },
            { frame: anticipate, value: x + 18, easing: "easeInOut" },
            { frame: ctx.endFrame, value: x - params.offset, easing: "easeInOut" },
          ]),
          createTrack("opacity", [
            { frame: ctx.startFrame, value: 1, easing: "linear" },
            { frame: anticipate, value: 1, easing: "easeInOut" },
            { frame: ctx.endFrame, value: 0, easing: "linear" },
          ]),
        ],
      };
    },
  },
  {
    id: "exit-pop-right",
    name: "Pop Launch Right",
    category: "exit",
    description: "Anticipates slightly to the left, then snaps briskly off to the right.",
    tags: ["pop", "anticipation", "snap", "exit"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      offset: { name: "Offset", type: "number", description: "Launch distance", default: 220, min: 30, max: 2500 },
      durationFrames: { name: "Duration", type: "number", description: "Frames for exit", default: 15, min: 4, max: 90 },
    },
    apply: (ctx, params) => {
      const { x } = getBaseCoords(ctx);
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      const exitStart = Math.max(ctx.startFrame, ctx.endFrame - dur);
      const anticipate = exitStart + Math.floor(dur * 0.3);
      return {
        tracks: [
          createTrack("x", [
            { frame: ctx.startFrame, value: x, easing: "linear" },
            { frame: exitStart, value: x, easing: "easeInOut" },
            { frame: anticipate, value: x - 18, easing: "easeInOut" },
            { frame: ctx.endFrame, value: x + params.offset, easing: "easeInOut" },
          ]),
          createTrack("opacity", [
            { frame: ctx.startFrame, value: 1, easing: "linear" },
            { frame: anticipate, value: 1, easing: "easeInOut" },
            { frame: ctx.endFrame, value: 0, easing: "linear" },
          ]),
        ],
      };
    },
  },
  {
    id: "exit-pop-up",
    name: "Pop Rocket Up",
    category: "exit",
    description: "Crouches downward momentarily then launches rapidly up and out.",
    tags: ["pop", "anticipation", "rocket", "exit"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      offset: { name: "Offset", type: "number", description: "Launch distance", default: 220, min: 30, max: 2500 },
      durationFrames: { name: "Duration", type: "number", description: "Frames for exit", default: 15, min: 4, max: 90 },
    },
    apply: (ctx, params) => {
      const { y } = getBaseCoords(ctx);
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      const exitStart = Math.max(ctx.startFrame, ctx.endFrame - dur);
      const crouch = exitStart + Math.floor(dur * 0.3);
      return {
        tracks: [
          createTrack("y", [
            { frame: ctx.startFrame, value: y, easing: "linear" },
            { frame: exitStart, value: y, easing: "easeInOut" },
            { frame: crouch, value: y + 16, easing: "easeInOut" },
            { frame: ctx.endFrame, value: y - params.offset, easing: "easeInOut" },
          ]),
          createTrack("opacity", [
            { frame: ctx.startFrame, value: 1, easing: "linear" },
            { frame: crouch, value: 1, easing: "easeInOut" },
            { frame: ctx.endFrame, value: 0, easing: "linear" },
          ]),
        ],
      };
    },
  },
  {
    id: "exit-pop-down",
    name: "Pop Plunge Down",
    category: "exit",
    description: "Rises slightly in anticipation then plunges decisively down through floor.",
    tags: ["pop", "anticipation", "plunge", "exit"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      offset: { name: "Offset", type: "number", description: "Plunge distance", default: 220, min: 30, max: 2500 },
      durationFrames: { name: "Duration", type: "number", description: "Frames for exit", default: 15, min: 4, max: 90 },
    },
    apply: (ctx, params) => {
      const { y } = getBaseCoords(ctx);
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      const exitStart = Math.max(ctx.startFrame, ctx.endFrame - dur);
      const lift = exitStart + Math.floor(dur * 0.3);
      return {
        tracks: [
          createTrack("y", [
            { frame: ctx.startFrame, value: y, easing: "linear" },
            { frame: exitStart, value: y, easing: "easeInOut" },
            { frame: lift, value: y - 16, easing: "easeInOut" },
            { frame: ctx.endFrame, value: y + params.offset, easing: "easeInOut" },
          ]),
          createTrack("opacity", [
            { frame: ctx.startFrame, value: 1, easing: "linear" },
            { frame: lift, value: 1, easing: "easeInOut" },
            { frame: ctx.endFrame, value: 0, easing: "linear" },
          ]),
        ],
      };
    },
  },
  {
    id: "exit-sink-away",
    name: "Sink Away",
    category: "exit",
    description: "Gently sinks downward under gravitational pull while fading.",
    tags: ["sink", "gravity", "slow", "exit"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      offset: { name: "Depth", type: "number", description: "Sink distance", default: 110, min: 10, max: 1000 },
      durationFrames: { name: "Duration", type: "number", description: "Frames for sink", default: 16, min: 3, max: 90 },
    },
    apply: (ctx, params) => {
      const { y } = getBaseCoords(ctx);
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      const exitStart = Math.max(ctx.startFrame, ctx.endFrame - dur);
      return {
        tracks: [
          createTrack("y", [
            { frame: ctx.startFrame, value: y, easing: "linear" },
            { frame: exitStart, value: y, easing: "easeInOut" },
            { frame: ctx.endFrame, value: y + params.offset, easing: "easeInOut" },
          ]),
          createTrack("opacity", [
            { frame: ctx.startFrame, value: 1, easing: "linear" },
            { frame: exitStart, value: 1, easing: "easeInOut" },
            { frame: ctx.endFrame, value: 0, easing: "linear" },
          ]),
        ],
      };
    },
  },
  {
    id: "exit-float-away",
    name: "Float Away",
    category: "exit",
    description: "Floats effortlessly upward into the sky and dissolves.",
    tags: ["float", "levitate", "ambient", "exit"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      offset: { name: "Distance", type: "number", description: "Ascent distance", default: 110, min: 10, max: 1000 },
      durationFrames: { name: "Duration", type: "number", description: "Frames for float", default: 16, min: 3, max: 90 },
    },
    apply: (ctx, params) => {
      const { y } = getBaseCoords(ctx);
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      const exitStart = Math.max(ctx.startFrame, ctx.endFrame - dur);
      return {
        tracks: [
          createTrack("y", [
            { frame: ctx.startFrame, value: y, easing: "linear" },
            { frame: exitStart, value: y, easing: "easeInOut" },
            { frame: ctx.endFrame, value: y - params.offset, easing: "easeInOut" },
          ]),
          createTrack("opacity", [
            { frame: ctx.startFrame, value: 1, easing: "linear" },
            { frame: exitStart, value: 1, easing: "easeInOut" },
            { frame: ctx.endFrame, value: 0, easing: "linear" },
          ]),
        ],
      };
    },
  },
  {
    id: "exit-spin-out-cw",
    name: "Spin Out CW",
    category: "exit",
    description: "Accelerating 360 clockwise revolution while evaporating.",
    tags: ["spin", "rotation", "exit"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      durationFrames: { name: "Duration", type: "number", description: "Frames for spin", default: 16, min: 4, max: 90 },
    },
    apply: (ctx, params) => {
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      const exitStart = Math.max(ctx.startFrame, ctx.endFrame - dur);
      return {
        tracks: [
          createTrack("rotation", [
            { frame: ctx.startFrame, value: 0, easing: "linear" },
            { frame: exitStart, value: 0, easing: "easeInOut" },
            { frame: ctx.endFrame, value: 360, easing: "easeInOut" },
          ]),
          createTrack("opacity", [
            { frame: ctx.startFrame, value: 1, easing: "linear" },
            { frame: exitStart, value: 1, easing: "easeInOut" },
            { frame: ctx.endFrame, value: 0, easing: "linear" },
          ]),
        ],
      };
    },
  },
  {
    id: "exit-spin-out-ccw",
    name: "Spin Out CCW",
    category: "exit",
    description: "Accelerating -360 counter-clockwise revolution while evaporating.",
    tags: ["spin", "rotation", "exit"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      durationFrames: { name: "Duration", type: "number", description: "Frames for spin", default: 16, min: 4, max: 90 },
    },
    apply: (ctx, params) => {
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      const exitStart = Math.max(ctx.startFrame, ctx.endFrame - dur);
      return {
        tracks: [
          createTrack("rotation", [
            { frame: ctx.startFrame, value: 0, easing: "linear" },
            { frame: exitStart, value: 0, easing: "easeInOut" },
            { frame: ctx.endFrame, value: -360, easing: "easeInOut" },
          ]),
          createTrack("opacity", [
            { frame: ctx.startFrame, value: 1, easing: "linear" },
            { frame: exitStart, value: 1, easing: "easeInOut" },
            { frame: ctx.endFrame, value: 0, easing: "linear" },
          ]),
        ],
      };
    },
  },
  {
    id: "exit-half-spin-cw",
    name: "Half Flip Out CW",
    category: "exit",
    description: "Flips 180 degrees clockwise and fades out.",
    tags: ["flip", "rotation", "exit"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      durationFrames: { name: "Duration", type: "number", description: "Frames for flip", default: 14, min: 3, max: 60 },
    },
    apply: (ctx, params) => {
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      const exitStart = Math.max(ctx.startFrame, ctx.endFrame - dur);
      return {
        tracks: [
          createTrack("rotation", [
            { frame: ctx.startFrame, value: 0, easing: "linear" },
            { frame: exitStart, value: 0, easing: "easeInOut" },
            { frame: ctx.endFrame, value: 180, easing: "easeInOut" },
          ]),
          createTrack("opacity", [
            { frame: ctx.startFrame, value: 1, easing: "linear" },
            { frame: exitStart, value: 1, easing: "easeInOut" },
            { frame: ctx.endFrame, value: 0, easing: "linear" },
          ]),
        ],
      };
    },
  },
  {
    id: "exit-half-spin-ccw",
    name: "Half Flip Out CCW",
    category: "exit",
    description: "Flips -180 degrees counter-clockwise and fades out.",
    tags: ["flip", "rotation", "exit"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      durationFrames: { name: "Duration", type: "number", description: "Frames for flip", default: 14, min: 3, max: 60 },
    },
    apply: (ctx, params) => {
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      const exitStart = Math.max(ctx.startFrame, ctx.endFrame - dur);
      return {
        tracks: [
          createTrack("rotation", [
            { frame: ctx.startFrame, value: 0, easing: "linear" },
            { frame: exitStart, value: 0, easing: "easeInOut" },
            { frame: ctx.endFrame, value: -180, easing: "easeInOut" },
          ]),
          createTrack("opacity", [
            { frame: ctx.startFrame, value: 1, easing: "linear" },
            { frame: exitStart, value: 1, easing: "easeInOut" },
            { frame: ctx.endFrame, value: 0, easing: "linear" },
          ]),
        ],
      };
    },
  },
  {
    id: "exit-tilt-fall",
    name: "Tilt and Fall Out",
    category: "exit",
    description: "Tilts sideways off-balance then drops rapidly through frame.",
    tags: ["tilt", "fall", "gravity", "exit"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      angle: { name: "Tilt Angle", type: "number", description: "Fall tilt angle", default: 22, min: 5, max: 90 },
      drop: { name: "Drop", type: "number", description: "Vertical drop", default: 160, min: 30, max: 1500 },
      durationFrames: { name: "Duration", type: "number", description: "Frames for fall", default: 15, min: 4, max: 90 },
    },
    apply: (ctx, params) => {
      const { y } = getBaseCoords(ctx);
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      const exitStart = Math.max(ctx.startFrame, ctx.endFrame - dur);
      return {
        tracks: [
          createTrack("rotation", [
            { frame: ctx.startFrame, value: 0, easing: "linear" },
            { frame: exitStart, value: 0, easing: "easeInOut" },
            { frame: ctx.endFrame, value: params.angle, easing: "easeInOut" },
          ]),
          createTrack("y", [
            { frame: ctx.startFrame, value: y, easing: "linear" },
            { frame: exitStart, value: y, easing: "easeInOut" },
            { frame: ctx.endFrame, value: y + params.drop, easing: "easeInOut" },
          ]),
          createTrack("opacity", [
            { frame: ctx.startFrame, value: 1, easing: "linear" },
            { frame: exitStart, value: 1, easing: "easeInOut" },
            { frame: ctx.endFrame, value: 0, easing: "linear" },
          ]),
        ],
      };
    },
  },
  {
    id: "exit-whip-left",
    name: "Whip Exit Left",
    category: "exit",
    description: "High-velocity snap exit speeding off to the left.",
    tags: ["whip", "fast", "speed", "exit"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      offset: { name: "Distance", type: "number", description: "Pixels", default: 350, min: 50, max: 3000 },
      durationFrames: { name: "Duration", type: "number", description: "Fast frames", default: 8, min: 2, max: 30 },
    },
    apply: (ctx, params) => {
      const { x } = getBaseCoords(ctx);
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      const exitStart = Math.max(ctx.startFrame, ctx.endFrame - dur);
      return {
        tracks: [
          createTrack("x", [
            { frame: ctx.startFrame, value: x, easing: "linear" },
            { frame: exitStart, value: x, easing: "easeInOut" },
            { frame: ctx.endFrame, value: x - params.offset, easing: "linear" },
          ]),
          createTrack("opacity", [
            { frame: ctx.startFrame, value: 1, easing: "linear" },
            { frame: exitStart, value: 1, easing: "easeInOut" },
            { frame: ctx.endFrame, value: 0, easing: "linear" },
          ]),
        ],
      };
    },
  },
  {
    id: "exit-whip-right",
    name: "Whip Exit Right",
    category: "exit",
    description: "High-velocity snap exit speeding off to the right.",
    tags: ["whip", "fast", "speed", "exit"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      offset: { name: "Distance", type: "number", description: "Pixels", default: 350, min: 50, max: 3000 },
      durationFrames: { name: "Duration", type: "number", description: "Fast frames", default: 8, min: 2, max: 30 },
    },
    apply: (ctx, params) => {
      const { x } = getBaseCoords(ctx);
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      const exitStart = Math.max(ctx.startFrame, ctx.endFrame - dur);
      return {
        tracks: [
          createTrack("x", [
            { frame: ctx.startFrame, value: x, easing: "linear" },
            { frame: exitStart, value: x, easing: "easeInOut" },
            { frame: ctx.endFrame, value: x + params.offset, easing: "linear" },
          ]),
          createTrack("opacity", [
            { frame: ctx.startFrame, value: 1, easing: "linear" },
            { frame: exitStart, value: 1, easing: "easeInOut" },
            { frame: ctx.endFrame, value: 0, easing: "linear" },
          ]),
        ],
      };
    },
  },
  {
    id: "exit-whip-up",
    name: "Whip Exit Upward",
    category: "exit",
    description: "High-velocity rocket snap straight up.",
    tags: ["whip", "vertical", "rocket", "exit"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      offset: { name: "Distance", type: "number", description: "Pixels", default: 300, min: 50, max: 3000 },
      durationFrames: { name: "Duration", type: "number", description: "Fast frames", default: 8, min: 2, max: 30 },
    },
    apply: (ctx, params) => {
      const { y } = getBaseCoords(ctx);
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      const exitStart = Math.max(ctx.startFrame, ctx.endFrame - dur);
      return {
        tracks: [
          createTrack("y", [
            { frame: ctx.startFrame, value: y, easing: "linear" },
            { frame: exitStart, value: y, easing: "easeInOut" },
            { frame: ctx.endFrame, value: y - params.offset, easing: "linear" },
          ]),
          createTrack("opacity", [
            { frame: ctx.startFrame, value: 1, easing: "linear" },
            { frame: exitStart, value: 1, easing: "easeInOut" },
            { frame: ctx.endFrame, value: 0, easing: "linear" },
          ]),
        ],
      };
    },
  },
  {
    id: "exit-whip-down",
    name: "Whip Exit Downward",
    category: "exit",
    description: "High-velocity plunge snap straight down.",
    tags: ["whip", "vertical", "plunge", "exit"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      offset: { name: "Distance", type: "number", description: "Pixels", default: 300, min: 50, max: 3000 },
      durationFrames: { name: "Duration", type: "number", description: "Fast frames", default: 8, min: 2, max: 30 },
    },
    apply: (ctx, params) => {
      const { y } = getBaseCoords(ctx);
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      const exitStart = Math.max(ctx.startFrame, ctx.endFrame - dur);
      return {
        tracks: [
          createTrack("y", [
            { frame: ctx.startFrame, value: y, easing: "linear" },
            { frame: exitStart, value: y, easing: "easeInOut" },
            { frame: ctx.endFrame, value: y + params.offset, easing: "linear" },
          ]),
          createTrack("opacity", [
            { frame: ctx.startFrame, value: 1, easing: "linear" },
            { frame: exitStart, value: 1, easing: "easeInOut" },
            { frame: ctx.endFrame, value: 0, easing: "linear" },
          ]),
        ],
      };
    },
  },
  {
    id: "exit-diagonal-tl",
    name: "Diagonal Exit Top-Left",
    category: "exit",
    description: "Leaves through the top-left corner.",
    tags: ["diagonal", "corner", "exit"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      offsetX: { name: "X Distance", type: "number", description: "Left distance", default: 160, min: 20, max: 2000 },
      offsetY: { name: "Y Distance", type: "number", description: "Up distance", default: 120, min: 20, max: 2000 },
      durationFrames: { name: "Duration", type: "number", description: "Frames for exit", default: 14, min: 2, max: 90 },
    },
    apply: (ctx, params) => {
      const { x, y } = getBaseCoords(ctx);
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      const exitStart = Math.max(ctx.startFrame, ctx.endFrame - dur);
      return {
        tracks: [
          createTrack("x", [
            { frame: ctx.startFrame, value: x, easing: "linear" },
            { frame: exitStart, value: x, easing: "easeInOut" },
            { frame: ctx.endFrame, value: x - params.offsetX, easing: "easeInOut" },
          ]),
          createTrack("y", [
            { frame: ctx.startFrame, value: y, easing: "linear" },
            { frame: exitStart, value: y, easing: "easeInOut" },
            { frame: ctx.endFrame, value: y - params.offsetY, easing: "easeInOut" },
          ]),
          createTrack("opacity", [
            { frame: ctx.startFrame, value: 1, easing: "linear" },
            { frame: exitStart, value: 1, easing: "easeInOut" },
            { frame: ctx.endFrame, value: 0, easing: "linear" },
          ]),
        ],
      };
    },
  },
  {
    id: "exit-diagonal-tr",
    name: "Diagonal Exit Top-Right",
    category: "exit",
    description: "Leaves through the top-right corner.",
    tags: ["diagonal", "corner", "exit"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      offsetX: { name: "X Distance", type: "number", description: "Right distance", default: 160, min: 20, max: 2000 },
      offsetY: { name: "Y Distance", type: "number", description: "Up distance", default: 120, min: 20, max: 2000 },
      durationFrames: { name: "Duration", type: "number", description: "Frames for exit", default: 14, min: 2, max: 90 },
    },
    apply: (ctx, params) => {
      const { x, y } = getBaseCoords(ctx);
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      const exitStart = Math.max(ctx.startFrame, ctx.endFrame - dur);
      return {
        tracks: [
          createTrack("x", [
            { frame: ctx.startFrame, value: x, easing: "linear" },
            { frame: exitStart, value: x, easing: "easeInOut" },
            { frame: ctx.endFrame, value: x + params.offsetX, easing: "easeInOut" },
          ]),
          createTrack("y", [
            { frame: ctx.startFrame, value: y, easing: "linear" },
            { frame: exitStart, value: y, easing: "easeInOut" },
            { frame: ctx.endFrame, value: y - params.offsetY, easing: "easeInOut" },
          ]),
          createTrack("opacity", [
            { frame: ctx.startFrame, value: 1, easing: "linear" },
            { frame: exitStart, value: 1, easing: "easeInOut" },
            { frame: ctx.endFrame, value: 0, easing: "linear" },
          ]),
        ],
      };
    },
  },
  {
    id: "exit-diagonal-bl",
    name: "Diagonal Exit Bottom-Left",
    category: "exit",
    description: "Leaves through the bottom-left corner.",
    tags: ["diagonal", "corner", "exit"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      offsetX: { name: "X Distance", type: "number", description: "Left distance", default: 160, min: 20, max: 2000 },
      offsetY: { name: "Y Distance", type: "number", description: "Down distance", default: 120, min: 20, max: 2000 },
      durationFrames: { name: "Duration", type: "number", description: "Frames for exit", default: 14, min: 2, max: 90 },
    },
    apply: (ctx, params) => {
      const { x, y } = getBaseCoords(ctx);
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      const exitStart = Math.max(ctx.startFrame, ctx.endFrame - dur);
      return {
        tracks: [
          createTrack("x", [
            { frame: ctx.startFrame, value: x, easing: "linear" },
            { frame: exitStart, value: x, easing: "easeInOut" },
            { frame: ctx.endFrame, value: x - params.offsetX, easing: "easeInOut" },
          ]),
          createTrack("y", [
            { frame: ctx.startFrame, value: y, easing: "linear" },
            { frame: exitStart, value: y, easing: "easeInOut" },
            { frame: ctx.endFrame, value: y + params.offsetY, easing: "easeInOut" },
          ]),
          createTrack("opacity", [
            { frame: ctx.startFrame, value: 1, easing: "linear" },
            { frame: exitStart, value: 1, easing: "easeInOut" },
            { frame: ctx.endFrame, value: 0, easing: "linear" },
          ]),
        ],
      };
    },
  },
  {
    id: "exit-diagonal-br",
    name: "Diagonal Exit Bottom-Right",
    category: "exit",
    description: "Leaves through the bottom-right corner.",
    tags: ["diagonal", "corner", "exit"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      offsetX: { name: "X Distance", type: "number", description: "Right distance", default: 160, min: 20, max: 2000 },
      offsetY: { name: "Y Distance", type: "number", description: "Down distance", default: 120, min: 20, max: 2000 },
      durationFrames: { name: "Duration", type: "number", description: "Frames for exit", default: 14, min: 2, max: 90 },
    },
    apply: (ctx, params) => {
      const { x, y } = getBaseCoords(ctx);
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      const exitStart = Math.max(ctx.startFrame, ctx.endFrame - dur);
      return {
        tracks: [
          createTrack("x", [
            { frame: ctx.startFrame, value: x, easing: "linear" },
            { frame: exitStart, value: x, easing: "easeInOut" },
            { frame: ctx.endFrame, value: x + params.offsetX, easing: "easeInOut" },
          ]),
          createTrack("y", [
            { frame: ctx.startFrame, value: y, easing: "linear" },
            { frame: exitStart, value: y, easing: "easeInOut" },
            { frame: ctx.endFrame, value: y + params.offsetY, easing: "easeInOut" },
          ]),
          createTrack("opacity", [
            { frame: ctx.startFrame, value: 1, easing: "linear" },
            { frame: exitStart, value: 1, easing: "easeInOut" },
            { frame: ctx.endFrame, value: 0, easing: "linear" },
          ]),
        ],
      };
    },
  },
  {
    id: "exit-drift-slow",
    name: "Slow Drift Exit",
    category: "exit",
    description: "Subtle calm dissipation wandering gently sideways.",
    tags: ["drift", "slow", "ambient", "exit"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      offset: { name: "Offset", type: "number", description: "Drift pixels", default: 50, min: 10, max: 400 },
      durationFrames: { name: "Duration", type: "number", description: "Frames for drift", default: 35, min: 10, max: 120 },
    },
    apply: (ctx, params) => {
      const { x } = getBaseCoords(ctx);
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      const exitStart = Math.max(ctx.startFrame, ctx.endFrame - dur);
      return {
        tracks: [
          createTrack("x", [
            { frame: ctx.startFrame, value: x, easing: "linear" },
            { frame: exitStart, value: x, easing: "easeInOut" },
            { frame: ctx.endFrame, value: x + params.offset, easing: "linear" },
          ]),
          createTrack("opacity", [
            { frame: ctx.startFrame, value: 1, easing: "linear" },
            { frame: exitStart, value: 1, easing: "easeInOut" },
            { frame: ctx.endFrame, value: 0, easing: "linear" },
          ]),
        ],
      };
    },
  },
  {
    id: "exit-vortex-out",
    name: "Vortex Spiral Out",
    category: "exit",
    description: "Spirals out of the scene with simultaneous rotation and translation.",
    tags: ["spiral", "vortex", "rotation", "exit"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      rotations: { name: "Rotation Degrees", type: "number", description: "Total angle", default: 270, min: 45, max: 720 },
      offset: { name: "Displacement", type: "number", description: "Offset pixels", default: 120, min: 20, max: 600 },
      durationFrames: { name: "Duration", type: "number", description: "Frames for spiral", default: 18, min: 5, max: 90 },
    },
    apply: (ctx, params) => {
      const { x, y } = getBaseCoords(ctx);
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      const exitStart = Math.max(ctx.startFrame, ctx.endFrame - dur);
      return {
        tracks: [
          createTrack("x", [
            { frame: ctx.startFrame, value: x, easing: "linear" },
            { frame: exitStart, value: x, easing: "easeInOut" },
            { frame: ctx.endFrame, value: x + params.offset, easing: "easeInOut" },
          ]),
          createTrack("y", [
            { frame: ctx.startFrame, value: y, easing: "linear" },
            { frame: exitStart, value: y, easing: "easeInOut" },
            { frame: ctx.endFrame, value: y - params.offset, easing: "easeInOut" },
          ]),
          createTrack("rotation", [
            { frame: ctx.startFrame, value: 0, easing: "linear" },
            { frame: exitStart, value: 0, easing: "easeInOut" },
            { frame: ctx.endFrame, value: params.rotations, easing: "easeInOut" },
          ]),
          createTrack("opacity", [
            { frame: ctx.startFrame, value: 1, easing: "linear" },
            { frame: exitStart, value: 1, easing: "easeInOut" },
            { frame: ctx.endFrame, value: 0, easing: "linear" },
          ]),
        ],
      };
    },
  },
  {
    id: "exit-stutter-out",
    name: "Stutter Stepped Exit",
    category: "exit",
    description: "Leaves in discrete robotic stair-steps.",
    tags: ["step", "mechanical", "tech", "exit"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      offset: { name: "Offset", type: "number", description: "Distance", default: 140, min: 20, max: 800 },
      steps: { name: "Steps", type: "number", description: "Number of steps", default: 3, min: 2, max: 6 },
      durationFrames: { name: "Duration", type: "number", description: "Frames for exit", default: 18, min: 6, max: 90 },
    },
    apply: (ctx, params) => {
      const { x } = getBaseCoords(ctx);
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      const exitStart = Math.max(ctx.startFrame, ctx.endFrame - dur);
      const stepCount = Math.floor(params.steps);
      const kfX: { frame: number; value: number; easing?: "step" | "linear" }[] = [
        { frame: ctx.startFrame, value: x, easing: "step" },
      ];
      const kfOp: { frame: number; value: number; easing?: "step" | "linear" }[] = [
        { frame: ctx.startFrame, value: 1, easing: "step" },
      ];
      for (let s = 0; s <= stepCount; s++) {
        const f = exitStart + Math.floor((s * dur) / stepCount);
        const frac = s / stepCount;
        kfX.push({ frame: f, value: Math.round(x + params.offset * frac), easing: "step" });
        kfOp.push({ frame: f, value: Number((1 - frac).toFixed(2)), easing: "step" });
      }
      return {
        tracks: [createTrack("x", kfX), createTrack("opacity", kfOp)],
      };
    },
  },
  {
    id: "exit-glissando-left",
    name: "Glissando Exit Left",
    category: "exit",
    description: "Expansive wide-travel exit glide sailing leftward.",
    tags: ["glide", "cinematic", "smooth", "exit"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      offset: { name: "Distance", type: "number", description: "Pixels", default: 500, min: 100, max: 3000 },
      durationFrames: { name: "Duration", type: "number", description: "Frames for glide", default: 28, min: 10, max: 120 },
    },
    apply: (ctx, params) => {
      const { x } = getBaseCoords(ctx);
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      const exitStart = Math.max(ctx.startFrame, ctx.endFrame - dur);
      return {
        tracks: [
          createTrack("x", [
            { frame: ctx.startFrame, value: x, easing: "linear" },
            { frame: exitStart, value: x, easing: "easeInOut" },
            { frame: ctx.endFrame, value: x - params.offset, easing: "easeInOut" },
          ]),
          createTrack("opacity", [
            { frame: ctx.startFrame, value: 1, easing: "linear" },
            { frame: exitStart, value: 1, easing: "easeInOut" },
            { frame: ctx.endFrame, value: 0, easing: "linear" },
          ]),
        ],
      };
    },
  },
  {
    id: "exit-glissando-right",
    name: "Glissando Exit Right",
    category: "exit",
    description: "Expansive wide-travel exit glide sailing rightward.",
    tags: ["glide", "cinematic", "smooth", "exit"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      offset: { name: "Distance", type: "number", description: "Pixels", default: 500, min: 100, max: 3000 },
      durationFrames: { name: "Duration", type: "number", description: "Frames for glide", default: 28, min: 10, max: 120 },
    },
    apply: (ctx, params) => {
      const { x } = getBaseCoords(ctx);
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      const exitStart = Math.max(ctx.startFrame, ctx.endFrame - dur);
      return {
        tracks: [
          createTrack("x", [
            { frame: ctx.startFrame, value: x, easing: "linear" },
            { frame: exitStart, value: x, easing: "easeInOut" },
            { frame: ctx.endFrame, value: x + params.offset, easing: "easeInOut" },
          ]),
          createTrack("opacity", [
            { frame: ctx.startFrame, value: 1, easing: "linear" },
            { frame: exitStart, value: 1, easing: "easeInOut" },
            { frame: ctx.endFrame, value: 0, easing: "linear" },
          ]),
        ],
      };
    },
  },
  {
    id: "exit-pendulum-fade",
    name: "Pendulum Swing Fade Out",
    category: "exit",
    description: "Oscillates sideways like an unpowered pendulum while gently fading out.",
    tags: ["pendulum", "swing", "rotation", "exit"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      amplitude: { name: "Max Angle", type: "number", description: "Degrees", default: 16, min: 4, max: 60 },
      durationFrames: { name: "Duration", type: "number", description: "Frames for oscillation", default: 24, min: 8, max: 90 },
    },
    apply: (ctx, params) => {
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      const exitStart = Math.max(ctx.startFrame, ctx.endFrame - dur);
      const fMid1 = exitStart + Math.floor(dur * 0.33);
      const fMid2 = exitStart + Math.floor(dur * 0.66);
      return {
        tracks: [
          createTrack("rotation", [
            { frame: ctx.startFrame, value: 0, easing: "linear" },
            { frame: exitStart, value: 0, easing: "easeInOut" },
            { frame: fMid1, value: params.amplitude, easing: "easeInOut" },
            { frame: fMid2, value: -Math.floor(params.amplitude * 0.6), easing: "easeInOut" },
            { frame: ctx.endFrame, value: 0, easing: "easeInOut" },
          ]),
          createTrack("opacity", [
            { frame: ctx.startFrame, value: 1, easing: "linear" },
            { frame: exitStart, value: 1, easing: "easeInOut" },
            { frame: ctx.endFrame, value: 0, easing: "linear" },
          ]),
        ],
      };
    },
  },
];
