import type { EffectDefinition } from "../types.js";
import { createTrack } from "../registry.js";

function getBaseCoords(ctx: any): { x: number; y: number } {
  return {
    x: ctx.targetLayer?.x ?? 0,
    y: ctx.targetLayer?.y ?? 0,
  };
}

export const kineticTypographyEffects: EffectDefinition[] = [
  {
    id: "kinetic-pulse-impact",
    name: "Pulse Impact",
    category: "kinetic-typography",
    description: "Sudden percussive surge displacement returning smoothly to anchor.",
    tags: ["punch", "percussive", "impact", "beat"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      intensity: { name: "Displacement", type: "number", description: "Displacement pixels", default: 24, min: 4, max: 120 },
      cycleFrames: { name: "Cycle Length", type: "number", description: "Frames per pulse", default: 20, min: 6, max: 60 },
    },
    apply: (ctx, params) => {
      const { y } = getBaseCoords(ctx);
      const kfY: { frame: number; value: number; easing?: "easeInOut" | "linear" }[] = [];
      const cycle = Math.max(6, Math.floor(params.cycleFrames));
      for (let f = ctx.startFrame; f <= ctx.endFrame; f += cycle) {
        kfY.push({ frame: f, value: y, easing: "easeInOut" });
        const apex = Math.min(ctx.endFrame, f + Math.floor(cycle * 0.25));
        kfY.push({ frame: apex, value: y - params.intensity, easing: "easeInOut" });
        const settle = Math.min(ctx.endFrame, f + cycle);
        kfY.push({ frame: settle, value: y, easing: "easeInOut" });
      }
      return { tracks: [createTrack("y", kfY)] };
    },
  },
  {
    id: "kinetic-heartbeat",
    name: "Heartbeat Double-Thump",
    category: "kinetic-typography",
    description: "Classic double-thump lub-dub rhythmic vertical contraction.",
    tags: ["heartbeat", "rhythm", "life", "pulse"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      amplitude: { name: "Amplitude", type: "number", description: "Displacement pixels", default: 16, min: 4, max: 80 },
      periodFrames: { name: "Beat Period", type: "number", description: "Frames per double-beat", default: 30, min: 14, max: 90 },
    },
    apply: (ctx, params) => {
      const { y } = getBaseCoords(ctx);
      const kfY: { frame: number; value: number; easing?: "easeInOut" }[] = [];
      const period = Math.max(14, Math.floor(params.periodFrames));
      for (let f = ctx.startFrame; f <= ctx.endFrame; f += period) {
        kfY.push({ frame: f, value: y, easing: "easeInOut" });
        kfY.push({ frame: Math.min(ctx.endFrame, f + 3), value: y - params.amplitude, easing: "easeInOut" });
        kfY.push({ frame: Math.min(ctx.endFrame, f + 6), value: y, easing: "easeInOut" });
        kfY.push({ frame: Math.min(ctx.endFrame, f + 9), value: y - Math.floor(params.amplitude * 0.65), easing: "easeInOut" });
        kfY.push({ frame: Math.min(ctx.endFrame, f + 14), value: y, easing: "easeInOut" });
      }
      return { tracks: [createTrack("y", kfY)] };
    },
  },
  {
    id: "kinetic-tremor",
    name: "High-Frequency Tremor",
    category: "kinetic-typography",
    description: "Continuous subtle high-frequency nervous micro-tremor in X and Y.",
    tags: ["tremor", "nervous", "vibration", "energy"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      jitterAmount: { name: "Jitter", type: "number", description: "Max pixel displacement", default: 4, min: 1, max: 20 },
      frequency: { name: "Step Interval", type: "number", description: "Frames per step", default: 2, min: 1, max: 6 },
    },
    apply: (ctx, params) => {
      const { x, y } = getBaseCoords(ctx);
      const kfX: { frame: number; value: number }[] = [];
      const kfY: { frame: number; value: number }[] = [];
      const step = Math.max(1, Math.floor(params.frequency));
      let sign = 1;
      for (let f = ctx.startFrame; f <= ctx.endFrame; f += step) {
        const dx = sign * params.jitterAmount;
        const dy = -sign * (params.jitterAmount * 0.7);
        kfX.push({ frame: f, value: Math.round(x + dx) });
        kfY.push({ frame: f, value: Math.round(y + dy) });
        sign = -sign;
      }
      return { tracks: [createTrack("x", kfX), createTrack("y", kfY)] };
    },
  },
  {
    id: "kinetic-earthquake",
    name: "Earthquake Shake",
    category: "kinetic-typography",
    description: "Violent initial tectonic shake dampening gradually over time.",
    tags: ["earthquake", "shake", "impact", "violence"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      maxDisplacement: { name: "Initial Shake", type: "number", description: "Max pixels", default: 22, min: 5, max: 100 },
      durationFrames: { name: "Decay Duration", type: "number", description: "Frames to calm", default: 24, min: 6, max: 90 },
    },
    apply: (ctx, params) => {
      const { x, y } = getBaseCoords(ctx);
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      const kfX: { frame: number; value: number }[] = [];
      const kfY: { frame: number; value: number }[] = [];
      const count = 8;
      for (let i = 0; i <= count; i++) {
        const f = ctx.startFrame + Math.floor((i * dur) / count);
        const decay = 1 - i / count;
        const sign = i % 2 === 0 ? 1 : -1;
        kfX.push({ frame: f, value: Math.round(x + sign * params.maxDisplacement * decay) });
        kfY.push({ frame: f, value: Math.round(y - sign * (params.maxDisplacement * 0.6) * decay) });
      }
      return { tracks: [createTrack("x", kfX), createTrack("y", kfY)] };
    },
  },
  {
    id: "kinetic-swing-pendulum",
    name: "Continuous Pendulum Sway",
    category: "kinetic-typography",
    description: "Smooth hypnotic back-and-forth rotational oscillation.",
    tags: ["pendulum", "swing", "hypnotic", "rotation"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      amplitude: { name: "Angle", type: "number", description: "Max tilt in degrees", default: 8, min: 2, max: 35 },
      periodFrames: { name: "Period", type: "number", description: "Frames for full swing cycle", default: 32, min: 10, max: 120 },
    },
    apply: (ctx, params) => {
      const kfRot: { frame: number; value: number; easing?: "easeInOut" }[] = [];
      const period = Math.max(10, Math.floor(params.periodFrames));
      for (let f = ctx.startFrame; f <= ctx.endFrame; f += period) {
        kfRot.push({ frame: f, value: 0, easing: "easeInOut" });
        kfRot.push({ frame: Math.min(ctx.endFrame, f + Math.floor(period * 0.25)), value: params.amplitude, easing: "easeInOut" });
        kfRot.push({ frame: Math.min(ctx.endFrame, f + Math.floor(period * 0.5)), value: 0, easing: "easeInOut" });
        kfRot.push({ frame: Math.min(ctx.endFrame, f + Math.floor(period * 0.75)), value: -params.amplitude, easing: "easeInOut" });
      }
      kfRot.push({ frame: ctx.endFrame, value: 0, easing: "easeInOut" });
      return { tracks: [createTrack("rotation", kfRot)] };
    },
  },
  {
    id: "kinetic-rhythm-hop",
    name: "Rhythm Hop",
    category: "kinetic-typography",
    description: "Bouncy uplifting repetitive hop timed like a musical note.",
    tags: ["hop", "bounce", "cheerful", "rhythm"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      height: { name: "Hop Height", type: "number", description: "Pixels off anchor", default: 25, min: 5, max: 120 },
      periodFrames: { name: "Hop Interval", type: "number", description: "Frames per hop", default: 16, min: 6, max: 60 },
    },
    apply: (ctx, params) => {
      const { y } = getBaseCoords(ctx);
      const kfY: { frame: number; value: number; easing?: "easeInOut" | "easeOutBack" }[] = [];
      const period = Math.max(6, Math.floor(params.periodFrames));
      for (let f = ctx.startFrame; f <= ctx.endFrame; f += period) {
        kfY.push({ frame: f, value: y, easing: "easeOutBack" });
        kfY.push({ frame: Math.min(ctx.endFrame, f + Math.floor(period * 0.45)), value: y - params.height, easing: "easeInOut" });
        kfY.push({ frame: Math.min(ctx.endFrame, f + Math.floor(period * 0.85)), value: y, easing: "easeInOut" });
      }
      return { tracks: [createTrack("y", kfY)] };
    },
  },
  {
    id: "kinetic-nod-emphasis",
    name: "Affirmative Head Nod",
    category: "kinetic-typography",
    description: "Brief authoritative vertical dip and return affirming key points.",
    tags: ["nod", "emphasis", "punch", "statement"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      depth: { name: "Nod Depth", type: "number", description: "Dip in pixels", default: 18, min: 4, max: 80 },
      durationFrames: { name: "Duration", type: "number", description: "Frames for nod", default: 12, min: 4, max: 30 },
    },
    apply: (ctx, params) => {
      const { y } = getBaseCoords(ctx);
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      const mid = ctx.startFrame + Math.floor(dur * 0.5);
      return {
        tracks: [
          createTrack("y", [
            { frame: ctx.startFrame, value: y, easing: "easeInOut" },
            { frame: mid, value: y + params.depth, easing: "easeInOut" },
            { frame: ctx.startFrame + dur, value: y, easing: "easeInOut" },
          ]),
        ],
      };
    },
  },
  {
    id: "kinetic-shake-horizontal",
    name: "Emphatic Head Shake",
    category: "kinetic-typography",
    description: "Rapid side-to-side horizontal oscillation signifying alert or negation.",
    tags: ["shake", "horizontal", "no", "alert"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      amplitude: { name: "Shake Width", type: "number", description: "Pixels displacement", default: 15, min: 3, max: 60 },
      durationFrames: { name: "Duration", type: "number", description: "Total duration", default: 14, min: 6, max: 40 },
    },
    apply: (ctx, params) => {
      const { x } = getBaseCoords(ctx);
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      const f0 = ctx.startFrame;
      const f1 = f0 + Math.floor(dur * 0.25);
      const f2 = f0 + Math.floor(dur * 0.5);
      const f3 = f0 + Math.floor(dur * 0.75);
      const f4 = f0 + dur;
      return {
        tracks: [
          createTrack("x", [
            { frame: f0, value: x, easing: "easeInOut" },
            { frame: f1, value: x + params.amplitude, easing: "easeInOut" },
            { frame: f2, value: x - params.amplitude, easing: "easeInOut" },
            { frame: f3, value: x + Math.floor(params.amplitude * 0.5), easing: "easeInOut" },
            { frame: f4, value: x, easing: "easeInOut" },
          ]),
        ],
      };
    },
  },
  {
    id: "kinetic-wave-float",
    name: "Harmonic Wave Float",
    category: "kinetic-typography",
    description: "Gentle sinusoidal floating motion simulating ocean wave swell.",
    tags: ["wave", "ocean", "float", "harmonic"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      amplitude: { name: "Wave Height", type: "number", description: "Vertical displacement", default: 14, min: 2, max: 50 },
      periodFrames: { name: "Wave Period", type: "number", description: "Frames for full cycle", default: 36, min: 12, max: 120 },
    },
    apply: (ctx, params) => {
      const { y } = getBaseCoords(ctx);
      const kfY: { frame: number; value: number; easing?: "easeInOut" }[] = [];
      const period = Math.max(12, Math.floor(params.periodFrames));
      for (let f = ctx.startFrame; f <= ctx.endFrame; f += period) {
        kfY.push({ frame: f, value: y, easing: "easeInOut" });
        kfY.push({ frame: Math.min(ctx.endFrame, f + Math.floor(period * 0.25)), value: y - params.amplitude, easing: "easeInOut" });
        kfY.push({ frame: Math.min(ctx.endFrame, f + Math.floor(period * 0.5)), value: y, easing: "easeInOut" });
        kfY.push({ frame: Math.min(ctx.endFrame, f + Math.floor(period * 0.75)), value: y + params.amplitude, easing: "easeInOut" });
      }
      kfY.push({ frame: ctx.endFrame, value: y, easing: "easeInOut" });
      return { tracks: [createTrack("y", kfY)] };
    },
  },
  {
    id: "kinetic-breathing",
    name: "Breathing Cycle",
    category: "kinetic-typography",
    description: "Slow meditative expansion and contraction in vertical lift and opacity.",
    tags: ["breathe", "meditative", "ambient", "calm"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      lift: { name: "Breath Lift", type: "number", description: "Vertical rise pixels", default: 8, min: 2, max: 30 },
      minOpacity: { name: "Min Opacity", type: "number", description: "Exhale opacity", default: 0.75, min: 0.3, max: 1 },
      periodFrames: { name: "Breath Period", type: "number", description: "Frames per breath", default: 45, min: 15, max: 150 },
    },
    apply: (ctx, params) => {
      const { y } = getBaseCoords(ctx);
      const kfY: { frame: number; value: number; easing?: "easeInOut" }[] = [];
      const kfOp: { frame: number; value: number; easing?: "easeInOut" }[] = [];
      const period = Math.max(15, Math.floor(params.periodFrames));
      for (let f = ctx.startFrame; f <= ctx.endFrame; f += period) {
        kfY.push({ frame: f, value: y, easing: "easeInOut" });
        kfOp.push({ frame: f, value: 1, easing: "easeInOut" });

        const inhale = Math.min(ctx.endFrame, f + Math.floor(period * 0.5));
        kfY.push({ frame: inhale, value: y - params.lift, easing: "easeInOut" });
        kfOp.push({ frame: inhale, value: params.minOpacity, easing: "easeInOut" });
      }
      kfY.push({ frame: ctx.endFrame, value: y, easing: "easeInOut" });
      kfOp.push({ frame: ctx.endFrame, value: 1, easing: "easeInOut" });
      return { tracks: [createTrack("y", kfY), createTrack("opacity", kfOp)] };
    },
  },
  {
    id: "kinetic-glitch-drift",
    name: "Glitch Displacement",
    category: "kinetic-typography",
    description: "Intermittent cybernetic micro-jumps in position like digital tape sync loss.",
    tags: ["glitch", "cyberpunk", "tech", "digital"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      jumpX: { name: "Horizontal Jump", type: "number", description: "Pixels", default: 18, min: 3, max: 80 },
      periodFrames: { name: "Glitch Period", type: "number", description: "Frames between glitch", default: 28, min: 8, max: 90 },
    },
    apply: (ctx, params) => {
      const { x } = getBaseCoords(ctx);
      const kfX: { frame: number; value: number; easing?: "step" | "linear" }[] = [];
      const period = Math.max(8, Math.floor(params.periodFrames));
      for (let f = ctx.startFrame; f <= ctx.endFrame; f += period) {
        kfX.push({ frame: f, value: x, easing: "step" });
        kfX.push({ frame: Math.min(ctx.endFrame, f + 2), value: x + params.jumpX, easing: "step" });
        kfX.push({ frame: Math.min(ctx.endFrame, f + 4), value: x - Math.floor(params.jumpX * 0.5), easing: "step" });
        kfX.push({ frame: Math.min(ctx.endFrame, f + 6), value: x, easing: "step" });
      }
      return { tracks: [createTrack("x", kfX)] };
    },
  },
  {
    id: "kinetic-wobble-cw",
    name: "Wobble CW",
    category: "kinetic-typography",
    description: "Quirky rhythmic clockwise wobble oscillation.",
    tags: ["wobble", "playful", "fun", "rotation"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      maxAngle: { name: "Max Angle", type: "number", description: "Degrees", default: 7, min: 1, max: 30 },
      durationFrames: { name: "Wobble Duration", type: "number", description: "Frames", default: 20, min: 6, max: 60 },
    },
    apply: (ctx, params) => {
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      const f0 = ctx.startFrame;
      return {
        tracks: [
          createTrack("rotation", [
            { frame: f0, value: 0, easing: "easeInOut" },
            { frame: f0 + Math.floor(dur * 0.25), value: params.maxAngle, easing: "easeInOut" },
            { frame: f0 + Math.floor(dur * 0.5), value: -Math.floor(params.maxAngle * 0.7), easing: "easeInOut" },
            { frame: f0 + Math.floor(dur * 0.75), value: Math.floor(params.maxAngle * 0.3), easing: "easeInOut" },
            { frame: f0 + dur, value: 0, easing: "easeInOut" },
          ]),
        ],
      };
    },
  },
  {
    id: "kinetic-wobble-ccw",
    name: "Wobble CCW",
    category: "kinetic-typography",
    description: "Quirky rhythmic counter-clockwise wobble oscillation.",
    tags: ["wobble", "playful", "fun", "rotation"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      maxAngle: { name: "Max Angle", type: "number", description: "Degrees", default: -7, min: -30, max: -1 },
      durationFrames: { name: "Wobble Duration", type: "number", description: "Frames", default: 20, min: 6, max: 60 },
    },
    apply: (ctx, params) => {
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      const f0 = ctx.startFrame;
      return {
        tracks: [
          createTrack("rotation", [
            { frame: f0, value: 0, easing: "easeInOut" },
            { frame: f0 + Math.floor(dur * 0.25), value: params.maxAngle, easing: "easeInOut" },
            { frame: f0 + Math.floor(dur * 0.5), value: -Math.floor(params.maxAngle * 0.7), easing: "easeInOut" },
            { frame: f0 + Math.floor(dur * 0.75), value: Math.floor(params.maxAngle * 0.3), easing: "easeInOut" },
            { frame: f0 + dur, value: 0, easing: "easeInOut" },
          ]),
        ],
      };
    },
  },
  {
    id: "kinetic-tilt-shift",
    name: "Subtle Tilt Shift",
    category: "kinetic-typography",
    description: "Slow progressive tilt shifting between slight positive and negative postures.",
    tags: ["tilt", "shift", "ambient", "editorial"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      angle: { name: "Tilt Angle", type: "number", description: "Degrees", default: 4, min: 1, max: 15 },
      periodFrames: { name: "Period", type: "number", description: "Frames per cycle", default: 40, min: 12, max: 120 },
    },
    apply: (ctx, params) => {
      const kfRot: { frame: number; value: number; easing?: "easeInOut" }[] = [];
      const period = Math.max(12, Math.floor(params.periodFrames));
      for (let f = ctx.startFrame; f <= ctx.endFrame; f += period) {
        kfRot.push({ frame: f, value: -params.angle, easing: "easeInOut" });
        kfRot.push({ frame: Math.min(ctx.endFrame, f + Math.floor(period * 0.5)), value: params.angle, easing: "easeInOut" });
      }
      kfRot.push({ frame: ctx.endFrame, value: -params.angle, easing: "easeInOut" });
      return { tracks: [createTrack("rotation", kfRot)] };
    },
  },
  {
    id: "kinetic-whisper-fade",
    name: "Whisper Opacity Glow",
    category: "kinetic-typography",
    description: "Atmospheric opacity pulsing between soft whisper and crisp presence.",
    tags: ["whisper", "glow", "opacity", "ambient"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      lowOpacity: { name: "Low Opacity", type: "number", description: "Minimum opacity", default: 0.65, min: 0.2, max: 0.95 },
      periodFrames: { name: "Pulse Period", type: "number", description: "Frames per pulse", default: 30, min: 8, max: 90 },
    },
    apply: (ctx, params) => {
      const kfOp: { frame: number; value: number; easing?: "easeInOut" }[] = [];
      const period = Math.max(8, Math.floor(params.periodFrames));
      for (let f = ctx.startFrame; f <= ctx.endFrame; f += period) {
        kfOp.push({ frame: f, value: 1, easing: "easeInOut" });
        kfOp.push({ frame: Math.min(ctx.endFrame, f + Math.floor(period * 0.5)), value: params.lowOpacity, easing: "easeInOut" });
      }
      kfOp.push({ frame: ctx.endFrame, value: 1, easing: "easeInOut" });
      return { tracks: [createTrack("opacity", kfOp)] };
    },
  },
  {
    id: "kinetic-staccato-punch",
    name: "Staccato Punch",
    category: "kinetic-typography",
    description: "Sharp staccato downward strike with immediate snapback.",
    tags: ["punch", "staccato", "sharp", "rhythm"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      strikeDistance: { name: "Strike Depth", type: "number", description: "Dip in pixels", default: 16, min: 4, max: 60 },
      cycleFrames: { name: "Interval", type: "number", description: "Frames between strikes", default: 16, min: 6, max: 45 },
    },
    apply: (ctx, params) => {
      const { y } = getBaseCoords(ctx);
      const kfY: { frame: number; value: number; easing?: "easeInOut" }[] = [];
      const cycle = Math.max(6, Math.floor(params.cycleFrames));
      for (let f = ctx.startFrame; f <= ctx.endFrame; f += cycle) {
        kfY.push({ frame: f, value: y, easing: "easeInOut" });
        kfY.push({ frame: Math.min(ctx.endFrame, f + 2), value: y + params.strikeDistance, easing: "easeInOut" });
        kfY.push({ frame: Math.min(ctx.endFrame, f + 5), value: y, easing: "easeInOut" });
      }
      return { tracks: [createTrack("y", kfY)] };
    },
  },
  {
    id: "kinetic-drum-kick",
    name: "Drum Kick Jolt",
    category: "kinetic-typography",
    description: "Bass drum kick jolt lifting upward then landing firmly on the deck.",
    tags: ["kick", "bass", "drum", "percussion"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      kickLift: { name: "Kick Height", type: "number", description: "Pixels", default: 20, min: 5, max: 80 },
      periodFrames: { name: "Measure Period", type: "number", description: "Frames per kick", default: 24, min: 8, max: 60 },
    },
    apply: (ctx, params) => {
      const { y } = getBaseCoords(ctx);
      const kfY: { frame: number; value: number; easing?: "easeOutBack" | "easeInOut" }[] = [];
      const period = Math.max(8, Math.floor(params.periodFrames));
      for (let f = ctx.startFrame; f <= ctx.endFrame; f += period) {
        kfY.push({ frame: f, value: y, easing: "easeOutBack" });
        kfY.push({ frame: Math.min(ctx.endFrame, f + 3), value: y - params.kickLift, easing: "easeInOut" });
        kfY.push({ frame: Math.min(ctx.endFrame, f + 8), value: y, easing: "easeInOut" });
      }
      return { tracks: [createTrack("y", kfY)] };
    },
  },
  {
    id: "kinetic-seesaw",
    name: "Seesaw Rocker",
    category: "kinetic-typography",
    description: "Continuous mechanical seesaw alternation rocking left and right.",
    tags: ["seesaw", "rocker", "balance", "rotation"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      maxAngle: { name: "Rock Angle", type: "number", description: "Degrees", default: 6, min: 2, max: 25 },
      periodFrames: { name: "Rock Period", type: "number", description: "Frames per rock", default: 24, min: 8, max: 60 },
    },
    apply: (ctx, params) => {
      const kfRot: { frame: number; value: number; easing?: "easeInOut" }[] = [];
      const period = Math.max(8, Math.floor(params.periodFrames));
      for (let f = ctx.startFrame; f <= ctx.endFrame; f += period) {
        kfRot.push({ frame: f, value: params.maxAngle, easing: "easeInOut" });
        kfRot.push({ frame: Math.min(ctx.endFrame, f + Math.floor(period * 0.5)), value: -params.maxAngle, easing: "easeInOut" });
      }
      kfRot.push({ frame: ctx.endFrame, value: params.maxAngle, easing: "easeInOut" });
      return { tracks: [createTrack("rotation", kfRot)] };
    },
  },
  {
    id: "kinetic-hover-sine",
    name: "Sinusoidal Hover",
    category: "kinetic-typography",
    description: "Ultra-smooth continuous sinusoidal anti-gravity levitation.",
    tags: ["hover", "levitate", "smooth", "ambient"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      hoverDistance: { name: "Hover Distance", type: "number", description: "Displacement", default: 12, min: 2, max: 40 },
      periodFrames: { name: "Float Cycle", type: "number", description: "Frames", default: 36, min: 10, max: 120 },
    },
    apply: (ctx, params) => {
      const { y } = getBaseCoords(ctx);
      const kfY: { frame: number; value: number; easing?: "easeInOut" }[] = [];
      const period = Math.max(10, Math.floor(params.periodFrames));
      for (let f = ctx.startFrame; f <= ctx.endFrame; f += period) {
        kfY.push({ frame: f, value: y - params.hoverDistance, easing: "easeInOut" });
        kfY.push({ frame: Math.min(ctx.endFrame, f + Math.floor(period * 0.5)), value: y + params.hoverDistance, easing: "easeInOut" });
      }
      kfY.push({ frame: ctx.endFrame, value: y - params.hoverDistance, easing: "easeInOut" });
      return { tracks: [createTrack("y", kfY)] };
    },
  },
  {
    id: "kinetic-slide-nudge",
    name: "Periodic Slide Nudge",
    category: "kinetic-typography",
    description: "Polite horizontal nudge nudging left-right on musical downbeats.",
    tags: ["nudge", "horizontal", "slide", "subtle"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      nudgeAmount: { name: "Nudge Pixels", type: "number", description: "Displacement", default: 12, min: 3, max: 40 },
      intervalFrames: { name: "Interval", type: "number", description: "Frames between nudges", default: 28, min: 8, max: 80 },
    },
    apply: (ctx, params) => {
      const { x } = getBaseCoords(ctx);
      const kfX: { frame: number; value: number; easing?: "easeInOut" }[] = [];
      const period = Math.max(8, Math.floor(params.intervalFrames));
      for (let f = ctx.startFrame; f <= ctx.endFrame; f += period) {
        kfX.push({ frame: f, value: x, easing: "easeInOut" });
        kfX.push({ frame: Math.min(ctx.endFrame, f + 4), value: x + params.nudgeAmount, easing: "easeInOut" });
        kfX.push({ frame: Math.min(ctx.endFrame, f + 9), value: x, easing: "easeInOut" });
      }
      return { tracks: [createTrack("x", kfX)] };
    },
  },
  {
    id: "kinetic-typewriter-punch",
    name: "Typewriter Step Punch",
    category: "kinetic-typography",
    description: "Discrete stepped horizontal shifts imitating typewriter carriage advancement.",
    tags: ["typewriter", "stepped", "retro", "mechanical"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      stepDistance: { name: "Step Pixels", type: "number", description: "Distance per punch", default: 10, min: 2, max: 30 },
      stepFrames: { name: "Frames Per Step", type: "number", description: "Interval", default: 10, min: 3, max: 30 },
    },
    apply: (ctx, params) => {
      const { x } = getBaseCoords(ctx);
      const kfX: { frame: number; value: number; easing?: "step" }[] = [];
      const step = Math.max(3, Math.floor(params.stepFrames));
      let currentX = x;
      for (let f = ctx.startFrame; f <= ctx.endFrame; f += step) {
        kfX.push({ frame: f, value: currentX, easing: "step" });
        currentX += params.stepDistance;
        if (currentX > x + 60) currentX = x;
      }
      return { tracks: [createTrack("x", kfX)] };
    },
  },
  {
    id: "kinetic-shudder",
    name: "Rapid Shudder",
    category: "kinetic-typography",
    description: "Brief violent rotational and horizontal shudder.",
    tags: ["shudder", "vibration", "impact"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      intensity: { name: "Angle", type: "number", description: "Max degrees", default: 5, min: 1, max: 20 },
      durationFrames: { name: "Duration", type: "number", description: "Frames", default: 12, min: 4, max: 30 },
    },
    apply: (ctx, params) => {
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      const f0 = ctx.startFrame;
      return {
        tracks: [
          createTrack("rotation", [
            { frame: f0, value: 0 },
            { frame: f0 + 2, value: params.intensity },
            { frame: f0 + 5, value: -params.intensity },
            { frame: f0 + 8, value: Math.floor(params.intensity * 0.5) },
            { frame: f0 + dur, value: 0 },
          ]),
        ],
      };
    },
  },
  {
    id: "kinetic-sway-subtle",
    name: "Subtle Gentle Sway",
    category: "kinetic-typography",
    description: "Relaxed slow lateral swaying offset.",
    tags: ["sway", "calm", "relax", "horizontal"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      distance: { name: "Sway Distance", type: "number", description: "Pixels", default: 15, min: 2, max: 50 },
      periodFrames: { name: "Period", type: "number", description: "Frames", default: 48, min: 16, max: 120 },
    },
    apply: (ctx, params) => {
      const { x } = getBaseCoords(ctx);
      const kfX: { frame: number; value: number; easing?: "easeInOut" }[] = [];
      const period = Math.max(16, Math.floor(params.periodFrames));
      for (let f = ctx.startFrame; f <= ctx.endFrame; f += period) {
        kfX.push({ frame: f, value: x - params.distance, easing: "easeInOut" });
        kfX.push({ frame: Math.min(ctx.endFrame, f + Math.floor(period * 0.5)), value: x + params.distance, easing: "easeInOut" });
      }
      kfX.push({ frame: ctx.endFrame, value: x - params.distance, easing: "easeInOut" });
      return { tracks: [createTrack("x", kfX)] };
    },
  },
  {
    id: "kinetic-bounce-settle",
    name: "Periodic Bounce Settle",
    category: "kinetic-typography",
    description: "Vertical drop that bounces twice and rests between measures.",
    tags: ["bounce", "playful", "vertical"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      bounceHeight: { name: "Height", type: "number", description: "Pixels", default: 22, min: 5, max: 80 },
      cycleFrames: { name: "Cycle Length", type: "number", description: "Frames", default: 32, min: 12, max: 80 },
    },
    apply: (ctx, params) => {
      const { y } = getBaseCoords(ctx);
      const kfY: { frame: number; value: number; easing?: "easeInOut" }[] = [];
      const cycle = Math.max(12, Math.floor(params.cycleFrames));
      for (let f = ctx.startFrame; f <= ctx.endFrame; f += cycle) {
        kfY.push({ frame: f, value: y, easing: "easeInOut" });
        kfY.push({ frame: Math.min(ctx.endFrame, f + 4), value: y - params.bounceHeight, easing: "easeInOut" });
        kfY.push({ frame: Math.min(ctx.endFrame, f + 8), value: y, easing: "easeInOut" });
        kfY.push({ frame: Math.min(ctx.endFrame, f + 11), value: y - Math.floor(params.bounceHeight * 0.35), easing: "easeInOut" });
        kfY.push({ frame: Math.min(ctx.endFrame, f + 15), value: y, easing: "easeInOut" });
      }
      return { tracks: [createTrack("y", kfY)] };
    },
  },
  {
    id: "kinetic-rebound-accent",
    name: "Rebound Accent Surge",
    category: "kinetic-typography",
    description: "Surges upward with an exaggerated spring overshoot before settling.",
    tags: ["rebound", "overshoot", "accent"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      displacement: { name: "Surge Pixels", type: "number", description: "Pixels", default: 26, min: 5, max: 90 },
      durationFrames: { name: "Duration", type: "number", description: "Frames", default: 16, min: 5, max: 45 },
    },
    apply: (ctx, params) => {
      const { y } = getBaseCoords(ctx);
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      return {
        tracks: [
          createTrack("y", [
            { frame: ctx.startFrame, value: y, easing: "easeOutBack" },
            { frame: ctx.startFrame + Math.floor(dur * 0.4), value: y - params.displacement, easing: "easeOutBack" },
            { frame: ctx.startFrame + dur, value: y, easing: "easeInOut" },
          ]),
        ],
      };
    },
  },
  {
    id: "kinetic-jitter-fast",
    name: "Fast Kinetic Jitter",
    category: "kinetic-typography",
    description: "Continuous rapid alternating horizontal micro-jitter.",
    tags: ["jitter", "fast", "energy"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      amount: { name: "Jitter Pixels", type: "number", description: "Pixels", default: 5, min: 1, max: 15 },
    },
    apply: (ctx, params) => {
      const { x } = getBaseCoords(ctx);
      const kfX: { frame: number; value: number }[] = [];
      let sign = 1;
      for (let f = ctx.startFrame; f <= ctx.endFrame; f += 2) {
        kfX.push({ frame: f, value: x + sign * params.amount });
        sign = -sign;
      }
      return { tracks: [createTrack("x", kfX)] };
    },
  },
  {
    id: "kinetic-bob-and-weave",
    name: "Bob and Weave",
    category: "kinetic-typography",
    description: "Coordinated figure-8 looping in both X and Y dimensions.",
    tags: ["bob", "weave", "organic", "loop"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      radius: { name: "Weave Radius", type: "number", description: "Pixels", default: 14, min: 3, max: 40 },
      periodFrames: { name: "Period", type: "number", description: "Frames", default: 36, min: 12, max: 90 },
    },
    apply: (ctx, params) => {
      const { x, y } = getBaseCoords(ctx);
      const kfX: { frame: number; value: number; easing?: "easeInOut" }[] = [];
      const kfY: { frame: number; value: number; easing?: "easeInOut" }[] = [];
      const period = Math.max(12, Math.floor(params.periodFrames));
      for (let f = ctx.startFrame; f <= ctx.endFrame; f += period) {
        const q1 = Math.min(ctx.endFrame, f + Math.floor(period * 0.25));
        const q2 = Math.min(ctx.endFrame, f + Math.floor(period * 0.5));
        const q3 = Math.min(ctx.endFrame, f + Math.floor(period * 0.75));
        kfX.push({ frame: f, value: x, easing: "easeInOut" });
        kfX.push({ frame: q1, value: x + params.radius, easing: "easeInOut" });
        kfX.push({ frame: q2, value: x, easing: "easeInOut" });
        kfX.push({ frame: q3, value: x - params.radius, easing: "easeInOut" });

        kfY.push({ frame: f, value: y - params.radius, easing: "easeInOut" });
        kfY.push({ frame: q1, value: y, easing: "easeInOut" });
        kfY.push({ frame: q2, value: y + params.radius, easing: "easeInOut" });
        kfY.push({ frame: q3, value: y, easing: "easeInOut" });
      }
      kfX.push({ frame: ctx.endFrame, value: x, easing: "easeInOut" });
      kfY.push({ frame: ctx.endFrame, value: y - params.radius, easing: "easeInOut" });
      return { tracks: [createTrack("x", kfX), createTrack("y", kfY)] };
    },
  },
  {
    id: "kinetic-elastic-snap",
    name: "Elastic Pullback Snap",
    category: "kinetic-typography",
    description: "Draws backward elastically and snaps forward through anchor.",
    tags: ["elastic", "pullback", "snap"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      tensionDistance: { name: "Tension Distance", type: "number", description: "Pixels", default: 28, min: 5, max: 90 },
      durationFrames: { name: "Snap Duration", type: "number", description: "Frames", default: 16, min: 6, max: 45 },
    },
    apply: (ctx, params) => {
      const { x } = getBaseCoords(ctx);
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      return {
        tracks: [
          createTrack("x", [
            { frame: ctx.startFrame, value: x, easing: "easeInOut" },
            { frame: ctx.startFrame + Math.floor(dur * 0.6), value: x - params.tensionDistance, easing: "easeInOut" },
            { frame: ctx.startFrame + Math.floor(dur * 0.8), value: x + Math.floor(params.tensionDistance * 0.4), easing: "easeInOut" },
            { frame: ctx.startFrame + dur, value: x, easing: "easeInOut" },
          ]),
        ],
      };
    },
  },
  {
    id: "kinetic-pendulum-decay",
    name: "Damped Pendulum Decay",
    category: "kinetic-typography",
    description: "Initial energetic angular kick smoothly damping down to zero.",
    tags: ["pendulum", "decay", "damped"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      startAngle: { name: "Initial Angle", type: "number", description: "Degrees", default: 16, min: 4, max: 45 },
      durationFrames: { name: "Damp Duration", type: "number", description: "Frames", default: 28, min: 8, max: 90 },
    },
    apply: (ctx, params) => {
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      const f0 = ctx.startFrame;
      return {
        tracks: [
          createTrack("rotation", [
            { frame: f0, value: params.startAngle, easing: "easeInOut" },
            { frame: f0 + Math.floor(dur * 0.25), value: -Math.floor(params.startAngle * 0.6), easing: "easeInOut" },
            { frame: f0 + Math.floor(dur * 0.5), value: Math.floor(params.startAngle * 0.3), easing: "easeInOut" },
            { frame: f0 + Math.floor(dur * 0.75), value: -Math.floor(params.startAngle * 0.1), easing: "easeInOut" },
            { frame: f0 + dur, value: 0, easing: "easeInOut" },
          ]),
        ],
      };
    },
  },
  {
    id: "kinetic-shiver-decay",
    name: "Shiver Dampen Decay",
    category: "kinetic-typography",
    description: "Violent initial vertical shudder decaying to total stillness.",
    tags: ["shiver", "decay", "vibration"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      initialJolt: { name: "Initial Jolt", type: "number", description: "Pixels", default: 18, min: 4, max: 60 },
      durationFrames: { name: "Decay Duration", type: "number", description: "Frames", default: 20, min: 6, max: 60 },
    },
    apply: (ctx, params) => {
      const { y } = getBaseCoords(ctx);
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      const f0 = ctx.startFrame;
      return {
        tracks: [
          createTrack("y", [
            { frame: f0, value: y + params.initialJolt, easing: "easeInOut" },
            { frame: f0 + Math.floor(dur * 0.2), value: y - Math.floor(params.initialJolt * 0.7), easing: "easeInOut" },
            { frame: f0 + Math.floor(dur * 0.45), value: y + Math.floor(params.initialJolt * 0.4), easing: "easeInOut" },
            { frame: f0 + Math.floor(dur * 0.7), value: y - Math.floor(params.initialJolt * 0.15), easing: "easeInOut" },
            { frame: f0 + dur, value: y, easing: "easeInOut" },
          ]),
        ],
      };
    },
  },
  {
    id: "kinetic-quiver",
    name: "Organic Subtle Quiver",
    category: "kinetic-typography",
    description: "Delicate organic rotational quivering like autumn leaves.",
    tags: ["quiver", "organic", "subtle"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      quiverDegrees: { name: "Quiver Degrees", type: "number", description: "Degrees", default: 3, min: 1, max: 10 },
      cycleFrames: { name: "Cycle Frames", type: "number", description: "Frames", default: 8, min: 3, max: 20 },
    },
    apply: (ctx, params) => {
      const kfRot: { frame: number; value: number }[] = [];
      const cycle = Math.max(3, Math.floor(params.cycleFrames));
      let sign = 1;
      for (let f = ctx.startFrame; f <= ctx.endFrame; f += cycle) {
        kfRot.push({ frame: f, value: sign * params.quiverDegrees });
        sign = -sign;
      }
      return { tracks: [createTrack("rotation", kfRot)] };
    },
  },
  {
    id: "kinetic-levitate-cycle",
    name: "Levitation Cycle",
    category: "kinetic-typography",
    description: "Periodic upward floating cycle pausing gracefully at apex.",
    tags: ["levitate", "float", "graceful"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      lift: { name: "Lift Distance", type: "number", description: "Pixels", default: 16, min: 3, max: 50 },
      periodFrames: { name: "Period", type: "number", description: "Frames", default: 32, min: 10, max: 80 },
    },
    apply: (ctx, params) => {
      const { y } = getBaseCoords(ctx);
      const kfY: { frame: number; value: number; easing?: "easeInOut" }[] = [];
      const period = Math.max(10, Math.floor(params.periodFrames));
      for (let f = ctx.startFrame; f <= ctx.endFrame; f += period) {
        kfY.push({ frame: f, value: y, easing: "easeInOut" });
        kfY.push({ frame: Math.min(ctx.endFrame, f + Math.floor(period * 0.4)), value: y - params.lift, easing: "easeInOut" });
        kfY.push({ frame: Math.min(ctx.endFrame, f + Math.floor(period * 0.7)), value: y - params.lift, easing: "easeInOut" });
        kfY.push({ frame: Math.min(ctx.endFrame, f + period), value: y, easing: "easeInOut" });
      }
      return { tracks: [createTrack("y", kfY)] };
    },
  },
  {
    id: "kinetic-meter-pulse",
    name: "Meter Pulse Beat",
    category: "kinetic-typography",
    description: "Synchronized meter pulse lifting on the primary downbeat of each measure.",
    tags: ["meter", "pulse", "downbeat", "music"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      pulsePixels: { name: "Pulse Pixels", type: "number", description: "Pixels", default: 15, min: 3, max: 50 },
      barFrames: { name: "Bar Length", type: "number", description: "Frames per bar", default: 30, min: 10, max: 90 },
    },
    apply: (ctx, params) => {
      const { y } = getBaseCoords(ctx);
      const kfY: { frame: number; value: number; easing?: "easeOutBack" | "easeInOut" }[] = [];
      const bar = Math.max(10, Math.floor(params.barFrames));
      for (let f = ctx.startFrame; f <= ctx.endFrame; f += bar) {
        kfY.push({ frame: f, value: y, easing: "easeOutBack" });
        kfY.push({ frame: Math.min(ctx.endFrame, f + 3), value: y - params.pulsePixels, easing: "easeInOut" });
        kfY.push({ frame: Math.min(ctx.endFrame, f + 8), value: y, easing: "easeInOut" });
      }
      return { tracks: [createTrack("y", kfY)] };
    },
  },
  {
    id: "kinetic-pop-accent",
    name: "Midpoint Pop Accent",
    category: "kinetic-typography",
    description: "A single distinct energetic jump right at the center of the timeline.",
    tags: ["pop", "accent", "midpoint"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      height: { name: "Pop Height", type: "number", description: "Pixels", default: 32, min: 5, max: 120 },
      popDuration: { name: "Duration", type: "number", description: "Frames", default: 12, min: 4, max: 30 },
    },
    apply: (ctx, params) => {
      const { y } = getBaseCoords(ctx);
      const mid = ctx.startFrame + Math.floor(ctx.durationFrames * 0.5);
      const half = Math.floor(params.popDuration * 0.5);
      return {
        tracks: [
          createTrack("y", [
            { frame: ctx.startFrame, value: y },
            { frame: Math.max(ctx.startFrame, mid - half), value: y, easing: "easeOutBack" },
            { frame: mid, value: y - params.height, easing: "easeInOut" },
            { frame: Math.min(ctx.endFrame, mid + half), value: y, easing: "easeInOut" },
          ]),
        ],
      };
    },
  },
  {
    id: "kinetic-chatter",
    name: "Mechanical Chatter",
    category: "kinetic-typography",
    description: "Ultra-fast mechanical chatter vibration along both axes.",
    tags: ["chatter", "mechanical", "fast", "vibration"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      displacement: { name: "Displacement", type: "number", description: "Pixels", default: 3, min: 1, max: 10 },
    },
    apply: (ctx, params) => {
      const { x, y } = getBaseCoords(ctx);
      const kfX: { frame: number; value: number }[] = [];
      const kfY: { frame: number; value: number }[] = [];
      let sign = 1;
      for (let f = ctx.startFrame; f <= ctx.endFrame; f += 2) {
        kfX.push({ frame: f, value: x + sign * params.displacement });
        kfY.push({ frame: f, value: y - sign * params.displacement });
        sign = -sign;
      }
      return { tracks: [createTrack("x", kfX), createTrack("y", kfY)] };
    },
  },
];
