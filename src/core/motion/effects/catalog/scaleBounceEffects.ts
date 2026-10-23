import type { MotionEasing } from "../../schema/types.js";
import type { EffectDefinition } from "../types.js";
import { createTrack } from "../registry.js";

function getBaseCoords(ctx: any): { x: number; y: number } {
  return {
    x: ctx.targetLayer?.x ?? 0,
    y: ctx.targetLayer?.y ?? 0,
  };
}

export const scaleBounceEffects: EffectDefinition[] = [
  {
    id: "entrance-scale-pop",
    name: "Scale Pop In",
    category: "entrance",
    description: "Explosive scale expansion from 0 to full size with energetic bounce easing.",
    tags: ["scale", "pop", "bounce", "zoom", "entrance"],
    targetKinds: ["text", "rect", "image", "video"],
    parameters: {
      durationFrames: { name: "Duration", type: "number", description: "Frames to complete pop", default: 18, min: 4, max: 90 },
      withFade: { name: "Fade in", type: "boolean", description: "Fade opacity concurrently", default: true },
    },
    apply: (ctx, params) => {
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      const f0 = ctx.startFrame;
      const tracks = [
        createTrack("scale", [
          { frame: f0, value: 0, easing: "bounce" },
          { frame: f0 + dur, value: 1, easing: "linear" },
        ]),
      ];
      if (params.withFade) {
        const fadeDur = Math.max(2, Math.floor(dur * 0.5));
        tracks.push(
          createTrack("opacity", [
            { frame: f0, value: 0, easing: "easeInOut" },
            { frame: f0 + fadeDur, value: 1, easing: "linear" },
          ]),
        );
      }
      return { tracks };
    },
  },
  {
    id: "entrance-zoom-in",
    name: "Smooth Zoom In",
    category: "entrance",
    description: "Cinematic zoom-in entrance gliding from fractional scale to full proportion.",
    tags: ["zoom", "cinematic", "scale", "smooth", "entrance"],
    targetKinds: ["text", "rect", "image", "video"],
    parameters: {
      startScale: { name: "Start Scale", type: "number", description: "Initial scale factor", default: 0.4, min: 0.1, max: 0.9 },
      durationFrames: { name: "Duration", type: "number", description: "Frames to arrival", default: 20, min: 4, max: 120 },
    },
    apply: (ctx, params) => {
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      const f0 = ctx.startFrame;
      return {
        tracks: [
          createTrack("scale", [
            { frame: f0, value: params.startScale, easing: "easeOut" },
            { frame: f0 + dur, value: 1, easing: "linear" },
          ]),
          createTrack("opacity", [
            { frame: f0, value: 0, easing: "easeOut" },
            { frame: f0 + dur, value: 1, easing: "linear" },
          ]),
        ],
      };
    },
  },
  {
    id: "entrance-overshoot-drop",
    name: "Overshoot Drop & Scale",
    category: "entrance",
    description: "Drops in from an enlarged scale settling into place with elastic bounce.",
    tags: ["drop", "overshoot", "scale", "bounce", "entrance"],
    targetKinds: ["text", "rect", "image", "video"],
    parameters: {
      startScale: { name: "Start Scale", type: "number", description: "Initial scale", default: 1.8, min: 1.2, max: 4 },
      yOffset: { name: "Y Offset", type: "number", description: "Drop distance", default: -80, min: -500, max: 0 },
      durationFrames: { name: "Duration", type: "number", description: "Frames for drop", default: 22, min: 6, max: 90 },
    },
    apply: (ctx, params) => {
      const { y } = getBaseCoords(ctx);
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      const f0 = ctx.startFrame;
      const fadeDur = Math.max(2, Math.floor(dur * 0.4));
      return {
        tracks: [
          createTrack("scale", [
            { frame: f0, value: params.startScale, easing: "bounce" },
            { frame: f0 + dur, value: 1, easing: "linear" },
          ]),
          createTrack("y", [
            { frame: f0, value: y + params.yOffset, easing: "bounce" },
            { frame: f0 + dur, value: y, easing: "linear" },
          ]),
          createTrack("opacity", [
            { frame: f0, value: 0, easing: "easeOut" },
            { frame: f0 + fadeDur, value: 1, easing: "linear" },
          ]),
        ],
      };
    },
  },
  {
    id: "entrance-elastic-scale",
    name: "Anamorphic Elastic Stretch",
    category: "entrance",
    description: "Dynamic rubber-band entrance stretching horizontally before snapping to proportion.",
    tags: ["elastic", "rubber", "stretch", "anamorphic", "entrance"],
    targetKinds: ["text", "rect", "image", "video"],
    parameters: {
      durationFrames: { name: "Duration", type: "number", description: "Animation duration", default: 24, min: 8, max: 90 },
    },
    apply: (ctx, params) => {
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      const f0 = ctx.startFrame;
      const fadeDur = Math.max(2, Math.floor(dur * 0.35));
      return {
        tracks: [
          createTrack("scaleX", [
            { frame: f0, value: 0.2, easing: "bounce" },
            { frame: f0 + dur, value: 1, easing: "linear" },
          ]),
          createTrack("scaleY", [
            { frame: f0, value: 1.8, easing: "bounce" },
            { frame: f0 + dur, value: 1, easing: "linear" },
          ]),
          createTrack("opacity", [
            { frame: f0, value: 0, easing: "linear" },
            { frame: f0 + fadeDur, value: 1, easing: "linear" },
          ]),
        ],
      };
    },
  },
  {
    id: "kinetic-pulse-scale",
    name: "Pulse Breathing Scale",
    category: "kinetic-typography",
    description: "Continuous rhythmic pulse scaling gently up and down to emphasize importance.",
    tags: ["pulse", "scale", "rhythm", "breathing", "emphasis"],
    targetKinds: ["text", "rect", "image", "video"],
    parameters: {
      amplitude: { name: "Amplitude", type: "number", description: "Scale expansion amount", default: 0.15, min: 0.05, max: 0.5 },
      cycles: { name: "Cycles", type: "number", description: "Number of pulses", default: 2, min: 1, max: 8 },
    },
    apply: (ctx, params) => {
      const dur = ctx.durationFrames;
      const f0 = ctx.startFrame;
      const cycles = Math.max(1, params.cycles);
      const cycleLen = dur / cycles;
      const keyframes = [{ frame: f0, value: 1, easing: "easeInOut" as const }];
      for (let c = 0; c < cycles; c++) {
        const mid = f0 + Math.round((c + 0.5) * cycleLen);
        const end = f0 + Math.round((c + 1) * cycleLen);
        keyframes.push({ frame: Math.min(ctx.endFrame, mid), value: 1 + params.amplitude, easing: "easeInOut" as const });
        keyframes.push({ frame: Math.min(ctx.endFrame, end), value: 1, easing: "easeInOut" as const });
      }
      return {
        tracks: [createTrack("scale", keyframes)],
      };
    },
  },
  {
    id: "kinetic-heartbeat-scale",
    name: "Heartbeat Double Thump",
    category: "kinetic-typography",
    description: "Distinctive lub-dub double heartbeat scale thumping.",
    tags: ["heartbeat", "pulse", "thump", "scale", "kinetic"],
    targetKinds: ["text", "rect", "image", "video"],
    parameters: {
      scalePeak: { name: "Peak Scale", type: "number", description: "Maximum scale peak", default: 1.25, min: 1.05, max: 1.6 },
      cycles: { name: "Cycles", type: "number", description: "Heartbeat pulses", default: 2, min: 1, max: 6 },
    },
    apply: (ctx, params) => {
      const dur = ctx.durationFrames;
      const f0 = ctx.startFrame;
      const cycles = Math.max(1, params.cycles);
      const cycleLen = dur / cycles;
      const keyframes = [{ frame: f0, value: 1, easing: "easeInOut" as const }];
      for (let c = 0; c < cycles; c++) {
        const cStart = f0 + Math.round(c * cycleLen);
        const f1 = cStart + Math.max(1, Math.round(cycleLen * 0.15));
        const f2 = cStart + Math.max(2, Math.round(cycleLen * 0.3));
        const f3 = cStart + Math.max(3, Math.round(cycleLen * 0.45));
        const f4 = cStart + Math.round(cycleLen);
        keyframes.push({ frame: Math.min(ctx.endFrame, f1), value: 1 + (params.scalePeak - 1) * 0.6, easing: "easeInOut" as const });
        keyframes.push({ frame: Math.min(ctx.endFrame, f2), value: 1 + (params.scalePeak - 1) * 0.1, easing: "easeInOut" as const });
        keyframes.push({ frame: Math.min(ctx.endFrame, f3), value: params.scalePeak, easing: "easeInOut" as const });
        keyframes.push({ frame: Math.min(ctx.endFrame, f4), value: 1, easing: "easeInOut" as const });
      }
      return {
        tracks: [createTrack("scale", keyframes)],
      };
    },
  },
  {
    id: "kinetic-bounce-hop",
    name: "Squash & Stretch Bounce Hop",
    category: "kinetic-typography",
    description: "Playful bouncing hop with authentic squash and stretch deformation.",
    tags: ["squash", "stretch", "hop", "bounce", "playful"],
    targetKinds: ["text", "rect", "image", "video"],
    parameters: {
      height: { name: "Hop Height", type: "number", description: "Vertical lift in pixels", default: 45, min: 10, max: 200 },
      hops: { name: "Hop Count", type: "number", description: "Number of hops", default: 2, min: 1, max: 5 },
    },
    apply: (ctx, params) => {
      const { y } = getBaseCoords(ctx);
      const dur = ctx.durationFrames;
      const f0 = ctx.startFrame;
      const hops = Math.max(1, params.hops);
      const hopLen = dur / hops;
      const yKeys: { frame: number; value: number; easing?: MotionEasing }[] = [{ frame: f0, value: y, easing: "bounce" }];
      const syKeys: { frame: number; value: number; easing?: MotionEasing }[] = [{ frame: f0, value: 1, easing: "easeInOut" }];
      const sxKeys: { frame: number; value: number; easing?: MotionEasing }[] = [{ frame: f0, value: 1, easing: "easeInOut" }];
      for (let h = 0; h < hops; h++) {
        const hStart = f0 + Math.round(h * hopLen);
        const peak = hStart + Math.round(hopLen * 0.5);
        const end = hStart + Math.round(hopLen);
        yKeys.push({ frame: Math.min(ctx.endFrame, peak), value: y - params.height, easing: "easeIn" as const });
        yKeys.push({ frame: Math.min(ctx.endFrame, end), value: y, easing: "bounce" as const });
        syKeys.push({ frame: Math.min(ctx.endFrame, peak), value: 1.25, easing: "easeIn" as const });
        syKeys.push({ frame: Math.min(ctx.endFrame, end), value: 0.8, easing: "easeInOut" as const });
        sxKeys.push({ frame: Math.min(ctx.endFrame, peak), value: 0.85, easing: "easeIn" as const });
        sxKeys.push({ frame: Math.min(ctx.endFrame, end), value: 1.2, easing: "easeInOut" as const });
      }
      return {
        tracks: [
          createTrack("y", yKeys),
          createTrack("scaleY", syKeys),
          createTrack("scaleX", sxKeys),
        ],
      };
    },
  },
  {
    id: "exit-scale-shrink",
    name: "Scale Shrink & Vanish",
    category: "exit",
    description: "Smooth scale shrink collapsing to center point while fading out.",
    tags: ["shrink", "scale", "fade", "exit"],
    targetKinds: ["text", "rect", "image", "video"],
    parameters: {
      durationFrames: { name: "Duration", type: "number", description: "Collapse frames", default: 15, min: 4, max: 90 },
    },
    apply: (ctx, params) => {
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      const f1 = ctx.endFrame;
      const f0 = f1 - dur;
      return {
        tracks: [
          createTrack("scale", [
            { frame: f0, value: 1, easing: "easeIn" },
            { frame: f1, value: 0, easing: "linear" },
          ]),
          createTrack("opacity", [
            { frame: f0, value: 1, easing: "easeIn" },
            { frame: f1, value: 0, easing: "linear" },
          ]),
        ],
      };
    },
  },
  {
    id: "exit-zoom-out",
    name: "Cinematic Zoom Blast",
    category: "exit",
    description: "Enlarges past the screen viewport while rapidly fading into transparency.",
    tags: ["zoom", "blast", "expand", "cinematic", "exit"],
    targetKinds: ["text", "rect", "image", "video"],
    parameters: {
      endScale: { name: "End Scale", type: "number", description: "Target zoom multiplier", default: 2.5, min: 1.5, max: 5 },
      durationFrames: { name: "Duration", type: "number", description: "Frames for blast", default: 14, min: 4, max: 60 },
    },
    apply: (ctx, params) => {
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      const f1 = ctx.endFrame;
      const f0 = f1 - dur;
      return {
        tracks: [
          createTrack("scale", [
            { frame: f0, value: 1, easing: "easeIn" },
            { frame: f1, value: params.endScale, easing: "linear" },
          ]),
          createTrack("opacity", [
            { frame: f0, value: 1, easing: "easeIn" },
            { frame: f1, value: 0, easing: "linear" },
          ]),
        ],
      };
    },
  },
  {
    id: "exit-elastic-collapse",
    name: "Elastic Spring Collapse",
    category: "exit",
    description: "Squashes flat horizontally like a compressed spring before vanishing.",
    tags: ["elastic", "squash", "spring", "collapse", "exit"],
    targetKinds: ["text", "rect", "image", "video"],
    parameters: {
      durationFrames: { name: "Duration", type: "number", description: "Collapse frames", default: 16, min: 6, max: 60 },
    },
    apply: (ctx, params) => {
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      const f1 = ctx.endFrame;
      const f0 = f1 - dur;
      return {
        tracks: [
          createTrack("scaleX", [
            { frame: f0, value: 1, easing: "easeIn" },
            { frame: f1, value: 2.2, easing: "linear" },
          ]),
          createTrack("scaleY", [
            { frame: f0, value: 1, easing: "easeIn" },
            { frame: f1, value: 0, easing: "linear" },
          ]),
          createTrack("opacity", [
            { frame: f0, value: 1, easing: "easeIn" },
            { frame: f1, value: 0, easing: "linear" },
          ]),
        ],
      };
    },
  },
];
