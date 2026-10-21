import type { EffectDefinition } from "../types.js";
import { createTrack } from "../registry.js";
import type { RectLayer } from "../../schema/types.js";

export const transitionEffects: EffectDefinition[] = [
  {
    id: "transition-crossfade",
    name: "Classic Crossfade",
    category: "transition",
    description: "Smooth continuous dissolve across scenes with overlapping opacity tracks.",
    tags: ["transition", "crossfade", "dissolve", "smooth"],
    targetKinds: ["text", "rect", "image", "scene"],
    parameters: {
      durationFrames: { name: "Fade Frames", type: "number", description: "Overlap duration", default: 12, min: 2, max: 60 },
    },
    apply: (ctx, params) => {
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      return {
        tracks: [
          createTrack("opacity", [
            { frame: ctx.startFrame, value: 0, easing: "easeInOut" },
            { frame: ctx.startFrame + dur, value: 1, easing: "linear" },
            { frame: Math.max(ctx.startFrame + dur, ctx.endFrame - dur), value: 1, easing: "easeInOut" },
            { frame: ctx.endFrame, value: 0, easing: "linear" },
          ]),
        ],
      };
    },
  },
  {
    id: "transition-cut",
    name: "Hard Cut",
    category: "transition",
    description: "Instantaneous sharp zero-frame transition without blending.",
    tags: ["transition", "cut", "hard", "sharp"],
    targetKinds: ["text", "rect", "image", "scene"],
    parameters: {},
    apply: (ctx) => {
      return {
        tracks: [
          createTrack("opacity", [
            { frame: ctx.startFrame, value: 0, easing: "step" },
            { frame: Math.min(ctx.endFrame, ctx.startFrame + 1), value: 1, easing: "step" },
            { frame: Math.max(ctx.startFrame + 1, ctx.endFrame - 1), value: 1, easing: "step" },
            { frame: ctx.endFrame, value: 0, easing: "step" },
          ]),
        ],
      };
    },
  },
  {
    id: "transition-flash-white",
    name: "White Impact Flash",
    category: "transition",
    description: "A brilliant white overlay flash surging at the cut point and fading.",
    tags: ["transition", "flash", "white", "impact"],
    targetKinds: ["scene"],
    parameters: {
      flashDuration: { name: "Flash Frames", type: "number", description: "Duration of flash", default: 8, min: 2, max: 24 },
      peakOpacity: { name: "Peak Opacity", type: "number", description: "Flash brightness", default: 0.95, min: 0.5, max: 1 },
    },
    apply: (ctx, params) => {
      const dur = Math.min(ctx.durationFrames, params.flashDuration);
      const mid = ctx.startFrame + Math.floor(ctx.durationFrames * 0.5);
      const overlay: RectLayer = {
        kind: "rect",
        id: "tr-flash-white",
        x: 0,
        y: 0,
        width: ctx.compositionWidth,
        height: ctx.compositionHeight,
        rotation: 0,
        opacity: 0,
        fill: "#FFFFFF",
        tracks: [
          createTrack("opacity", [
            { frame: Math.max(ctx.startFrame, mid - Math.floor(dur * 0.5)), value: 0, easing: "easeInOut" },
            { frame: mid, value: params.peakOpacity, easing: "easeInOut" },
            { frame: Math.min(ctx.endFrame, mid + Math.floor(dur * 0.5)), value: 0, easing: "linear" },
          ]),
        ],
      };
      return { newLayers: [overlay] };
    },
  },
  {
    id: "transition-flash-black",
    name: "Dip to Black",
    category: "transition",
    description: "Cinematic dip to pure black bridging two scenes.",
    tags: ["transition", "dip", "black", "cinematic"],
    targetKinds: ["scene"],
    parameters: {
      dipDuration: { name: "Dip Frames", type: "number", description: "Duration of dip", default: 12, min: 4, max: 30 },
    },
    apply: (ctx, params) => {
      const dur = Math.min(ctx.durationFrames, params.dipDuration);
      const mid = ctx.startFrame + Math.floor(ctx.durationFrames * 0.5);
      const overlay: RectLayer = {
        kind: "rect",
        id: "tr-dip-black",
        x: 0,
        y: 0,
        width: ctx.compositionWidth,
        height: ctx.compositionHeight,
        rotation: 0,
        opacity: 0,
        fill: "#000000",
        tracks: [
          createTrack("opacity", [
            { frame: Math.max(ctx.startFrame, mid - Math.floor(dur * 0.5)), value: 0, easing: "easeInOut" },
            { frame: mid, value: 1, easing: "easeInOut" },
            { frame: Math.min(ctx.endFrame, mid + Math.floor(dur * 0.5)), value: 0, easing: "linear" },
          ]),
        ],
      };
      return { newLayers: [overlay] };
    },
  },
  {
    id: "transition-dip-accent",
    name: "Dip to Brand Accent",
    category: "transition",
    description: "Full-bleed flash in the project's signature accent color.",
    tags: ["transition", "dip", "accent", "branding"],
    targetKinds: ["scene"],
    parameters: {
      accentColor: { name: "Accent Color", type: "color", description: "Color for flash", default: "#36F4D3" },
      dipDuration: { name: "Duration", type: "number", description: "Frames", default: 10, min: 3, max: 30 },
    },
    apply: (ctx, params) => {
      const dur = Math.min(ctx.durationFrames, params.dipDuration);
      const mid = ctx.startFrame + Math.floor(ctx.durationFrames * 0.5);
      const overlay: RectLayer = {
        kind: "rect",
        id: "tr-dip-accent",
        x: 0,
        y: 0,
        width: ctx.compositionWidth,
        height: ctx.compositionHeight,
        rotation: 0,
        opacity: 0,
        fill: params.accentColor,
        tracks: [
          createTrack("opacity", [
            { frame: Math.max(ctx.startFrame, mid - Math.floor(dur * 0.5)), value: 0, easing: "easeInOut" },
            { frame: mid, value: 0.95, easing: "easeInOut" },
            { frame: Math.min(ctx.endFrame, mid + Math.floor(dur * 0.5)), value: 0, easing: "linear" },
          ]),
        ],
      };
      return { newLayers: [overlay] };
    },
  },
  {
    id: "transition-push-left",
    name: "Push Left",
    category: "transition",
    description: "Horizontal push sliding from right to left.",
    tags: ["transition", "push", "slide", "left"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      durationFrames: { name: "Duration", type: "number", description: "Frames for push", default: 14, min: 4, max: 45 },
    },
    apply: (ctx, params) => {
      const x = ctx.targetLayer?.x ?? 0;
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      return {
        tracks: [
          createTrack("x", [
            { frame: ctx.startFrame, value: x + ctx.compositionWidth, easing: "easeInOut" },
            { frame: ctx.startFrame + dur, value: x, easing: "easeInOut" },
          ]),
        ],
      };
    },
  },
  {
    id: "transition-push-right",
    name: "Push Right",
    category: "transition",
    description: "Horizontal push sliding from left to right.",
    tags: ["transition", "push", "slide", "right"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      durationFrames: { name: "Duration", type: "number", description: "Frames for push", default: 14, min: 4, max: 45 },
    },
    apply: (ctx, params) => {
      const x = ctx.targetLayer?.x ?? 0;
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      return {
        tracks: [
          createTrack("x", [
            { frame: ctx.startFrame, value: x - ctx.compositionWidth, easing: "easeInOut" },
            { frame: ctx.startFrame + dur, value: x, easing: "easeInOut" },
          ]),
        ],
      };
    },
  },
  {
    id: "transition-push-up",
    name: "Push Upward",
    category: "transition",
    description: "Vertical push sliding from bottom upward.",
    tags: ["transition", "push", "slide", "vertical"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      durationFrames: { name: "Duration", type: "number", description: "Frames for push", default: 14, min: 4, max: 45 },
    },
    apply: (ctx, params) => {
      const y = ctx.targetLayer?.y ?? 0;
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      return {
        tracks: [
          createTrack("y", [
            { frame: ctx.startFrame, value: y + ctx.compositionHeight, easing: "easeInOut" },
            { frame: ctx.startFrame + dur, value: y, easing: "easeInOut" },
          ]),
        ],
      };
    },
  },
  {
    id: "transition-push-down",
    name: "Push Downward",
    category: "transition",
    description: "Vertical push sliding from top downward.",
    tags: ["transition", "push", "slide", "vertical"],
    targetKinds: ["text", "rect", "image"],
    parameters: {
      durationFrames: { name: "Duration", type: "number", description: "Frames for push", default: 14, min: 4, max: 45 },
    },
    apply: (ctx, params) => {
      const y = ctx.targetLayer?.y ?? 0;
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      return {
        tracks: [
          createTrack("y", [
            { frame: ctx.startFrame, value: y - ctx.compositionHeight, easing: "easeInOut" },
            { frame: ctx.startFrame + dur, value: y, easing: "easeInOut" },
          ]),
        ],
      };
    },
  },
  {
    id: "transition-horizontal-wipe-bar",
    name: "Horizontal Wipe Bar",
    category: "transition",
    description: "A sharp colored bar that wipes cleanly from left to right across the canvas.",
    tags: ["transition", "wipe", "bar", "graphic"],
    targetKinds: ["scene"],
    parameters: {
      barColor: { name: "Bar Color", type: "color", description: "Color of wipe bar", default: "#FFDF59" },
      barWidth: { name: "Bar Width", type: "number", description: "Width in pixels", default: 180, min: 20, max: 800 },
      durationFrames: { name: "Duration", type: "number", description: "Frames to cross screen", default: 16, min: 6, max: 45 },
    },
    apply: (ctx, params) => {
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      const mid = ctx.startFrame + Math.floor(ctx.durationFrames * 0.5);
      const fStart = Math.max(ctx.startFrame, mid - Math.floor(dur * 0.5));
      const fEnd = Math.min(ctx.endFrame, fStart + dur);
      const bar: RectLayer = {
        kind: "rect",
        id: "tr-wipe-bar-h",
        x: -params.barWidth,
        y: 0,
        width: params.barWidth,
        height: ctx.compositionHeight,
        rotation: 0,
        opacity: 1,
        fill: params.barColor,
        tracks: [
          createTrack("x", [
            { frame: fStart, value: -params.barWidth, easing: "easeInOut" },
            { frame: fEnd, value: ctx.compositionWidth, easing: "easeInOut" },
          ]),
          createTrack("opacity", [
            { frame: fStart, value: 1, easing: "step" },
            { frame: fEnd, value: 0, easing: "step" },
          ]),
        ],
      };
      return { newLayers: [bar] };
    },
  },
  {
    id: "transition-vertical-wipe-bar",
    name: "Vertical Wipe Bar",
    category: "transition",
    description: "A sharp colored bar that wipes cleanly from top to bottom across the canvas.",
    tags: ["transition", "wipe", "bar", "graphic"],
    targetKinds: ["scene"],
    parameters: {
      barColor: { name: "Bar Color", type: "color", description: "Color of wipe bar", default: "#36F4D3" },
      barHeight: { name: "Bar Height", type: "number", description: "Height in pixels", default: 160, min: 20, max: 800 },
      durationFrames: { name: "Duration", type: "number", description: "Frames to cross screen", default: 16, min: 6, max: 45 },
    },
    apply: (ctx, params) => {
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      const mid = ctx.startFrame + Math.floor(ctx.durationFrames * 0.5);
      const fStart = Math.max(ctx.startFrame, mid - Math.floor(dur * 0.5));
      const fEnd = Math.min(ctx.endFrame, fStart + dur);
      const bar: RectLayer = {
        kind: "rect",
        id: "tr-wipe-bar-v",
        x: 0,
        y: -params.barHeight,
        width: ctx.compositionWidth,
        height: params.barHeight,
        rotation: 0,
        opacity: 1,
        fill: params.barColor,
        tracks: [
          createTrack("y", [
            { frame: fStart, value: -params.barHeight, easing: "easeInOut" },
            { frame: fEnd, value: ctx.compositionHeight, easing: "easeInOut" },
          ]),
          createTrack("opacity", [
            { frame: fStart, value: 1, easing: "step" },
            { frame: fEnd, value: 0, easing: "step" },
          ]),
        ],
      };
      return { newLayers: [bar] };
    },
  },
  {
    id: "transition-curtain-split",
    name: "Curtain Split Open",
    category: "transition",
    description: "Two centered solid panels parting left and right to reveal the scene.",
    tags: ["curtain", "split", "theatrical", "reveal"],
    targetKinds: ["scene"],
    parameters: {
      curtainColor: { name: "Curtain Color", type: "color", description: "Panel color", default: "#101827" },
      durationFrames: { name: "Duration", type: "number", description: "Frames to open", default: 16, min: 4, max: 45 },
    },
    apply: (ctx, params) => {
      const halfW = Math.ceil(ctx.compositionWidth / 2);
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      const left: RectLayer = {
        kind: "rect",
        id: "tr-curtain-left",
        x: 0,
        y: 0,
        width: halfW,
        height: ctx.compositionHeight,
        rotation: 0,
        opacity: 1,
        fill: params.curtainColor,
        tracks: [
          createTrack("x", [
            { frame: ctx.startFrame, value: 0, easing: "easeInOut" },
            { frame: ctx.startFrame + dur, value: -halfW, easing: "easeInOut" },
          ]),
          createTrack("opacity", [
            { frame: ctx.startFrame, value: 1, easing: "step" },
            { frame: ctx.startFrame + dur, value: 0, easing: "step" },
          ]),
        ],
      };
      const right: RectLayer = {
        kind: "rect",
        id: "tr-curtain-right",
        x: halfW,
        y: 0,
        width: halfW,
        height: ctx.compositionHeight,
        rotation: 0,
        opacity: 1,
        fill: params.curtainColor,
        tracks: [
          createTrack("x", [
            { frame: ctx.startFrame, value: halfW, easing: "easeInOut" },
            { frame: ctx.startFrame + dur, value: ctx.compositionWidth, easing: "easeInOut" },
          ]),
          createTrack("opacity", [
            { frame: ctx.startFrame, value: 1, easing: "step" },
            { frame: ctx.startFrame + dur, value: 0, easing: "step" },
          ]),
        ],
      };
      return { newLayers: [left, right] };
    },
  },
  {
    id: "transition-curtain-close",
    name: "Curtain Split Close",
    category: "transition",
    description: "Two panels sliding from boundaries inward to close the scene.",
    tags: ["curtain", "close", "theatrical"],
    targetKinds: ["scene"],
    parameters: {
      curtainColor: { name: "Curtain Color", type: "color", description: "Panel color", default: "#101827" },
      durationFrames: { name: "Duration", type: "number", description: "Frames to close", default: 16, min: 4, max: 45 },
    },
    apply: (ctx, params) => {
      const halfW = Math.ceil(ctx.compositionWidth / 2);
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      const exitStart = Math.max(ctx.startFrame, ctx.endFrame - dur);
      const left: RectLayer = {
        kind: "rect",
        id: "tr-curtain-close-l",
        x: -halfW,
        y: 0,
        width: halfW,
        height: ctx.compositionHeight,
        rotation: 0,
        opacity: 0,
        fill: params.curtainColor,
        tracks: [
          createTrack("x", [
            { frame: ctx.startFrame, value: -halfW, easing: "step" },
            { frame: exitStart, value: -halfW, easing: "easeInOut" },
            { frame: ctx.endFrame, value: 0, easing: "easeInOut" },
          ]),
          createTrack("opacity", [
            { frame: ctx.startFrame, value: 0, easing: "step" },
            { frame: exitStart, value: 1, easing: "step" },
            { frame: ctx.endFrame, value: 1, easing: "step" },
          ]),
        ],
      };
      const right: RectLayer = {
        kind: "rect",
        id: "tr-curtain-close-r",
        x: ctx.compositionWidth,
        y: 0,
        width: halfW,
        height: ctx.compositionHeight,
        rotation: 0,
        opacity: 0,
        fill: params.curtainColor,
        tracks: [
          createTrack("x", [
            { frame: ctx.startFrame, value: ctx.compositionWidth, easing: "step" },
            { frame: exitStart, value: ctx.compositionWidth, easing: "easeInOut" },
            { frame: ctx.endFrame, value: halfW, easing: "easeInOut" },
          ]),
          createTrack("opacity", [
            { frame: ctx.startFrame, value: 0, easing: "step" },
            { frame: exitStart, value: 1, easing: "step" },
            { frame: ctx.endFrame, value: 1, easing: "step" },
          ]),
        ],
      };
      return { newLayers: [left, right] };
    },
  },
  {
    id: "transition-letterbox-squeeze",
    name: "Letterbox Squeeze",
    category: "transition",
    description: "Cinematic black bars sliding down from top and up from bottom, then retracting.",
    tags: ["letterbox", "cinematic", "bars", "transition"],
    targetKinds: ["scene"],
    parameters: {
      barHeight: { name: "Bar Thickness", type: "number", description: "Pixels", default: 90, min: 20, max: 300 },
      durationFrames: { name: "Duration", type: "number", description: "Frames", default: 20, min: 6, max: 60 },
    },
    apply: (ctx, params) => {
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      const mid = ctx.startFrame + Math.floor(ctx.durationFrames * 0.5);
      const f0 = Math.max(ctx.startFrame, mid - Math.floor(dur * 0.5));
      const fMid = mid;
      const f1 = Math.min(ctx.endFrame, mid + Math.floor(dur * 0.5));
      const top: RectLayer = {
        kind: "rect",
        id: "tr-letterbox-top",
        x: 0,
        y: -params.barHeight,
        width: ctx.compositionWidth,
        height: params.barHeight,
        rotation: 0,
        opacity: 1,
        fill: "#000000",
        tracks: [
          createTrack("y", [
            { frame: f0, value: -params.barHeight, easing: "easeInOut" },
            { frame: fMid, value: 0, easing: "easeInOut" },
            { frame: f1, value: -params.barHeight, easing: "easeInOut" },
          ]),
        ],
      };
      const bottom: RectLayer = {
        kind: "rect",
        id: "tr-letterbox-bottom",
        x: 0,
        y: ctx.compositionHeight,
        width: ctx.compositionWidth,
        height: params.barHeight,
        rotation: 0,
        opacity: 1,
        fill: "#000000",
        tracks: [
          createTrack("y", [
            { frame: f0, value: ctx.compositionHeight, easing: "easeInOut" },
            { frame: fMid, value: ctx.compositionHeight - params.barHeight, easing: "easeInOut" },
            { frame: f1, value: ctx.compositionHeight, easing: "easeInOut" },
          ]),
        ],
      };
      return { newLayers: [top, bottom] };
    },
  },
  {
    id: "transition-slide-over-left",
    name: "Solid Wipe Over Left",
    category: "transition",
    description: "Full-bleed solid curtain sweeps leftward across screen.",
    tags: ["wipe", "solid", "curtain", "transition"],
    targetKinds: ["scene"],
    parameters: {
      color: { name: "Curtain Color", type: "color", description: "Color", default: "#101827" },
      durationFrames: { name: "Duration", type: "number", description: "Frames", default: 16, min: 4, max: 45 },
    },
    apply: (ctx, params) => {
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      const curtain: RectLayer = {
        kind: "rect",
        id: "tr-solid-wipe-l",
        x: ctx.compositionWidth,
        y: 0,
        width: ctx.compositionWidth,
        height: ctx.compositionHeight,
        rotation: 0,
        opacity: 1,
        fill: params.color,
        tracks: [
          createTrack("x", [
            { frame: ctx.startFrame, value: ctx.compositionWidth, easing: "easeInOut" },
            { frame: ctx.startFrame + Math.floor(dur * 0.5), value: 0, easing: "easeInOut" },
            { frame: ctx.startFrame + dur, value: -ctx.compositionWidth, easing: "easeInOut" },
          ]),
        ],
      };
      return { newLayers: [curtain] };
    },
  },
  {
    id: "transition-slide-over-right",
    name: "Solid Wipe Over Right",
    category: "transition",
    description: "Full-bleed solid curtain sweeps rightward across screen.",
    tags: ["wipe", "solid", "curtain", "transition"],
    targetKinds: ["scene"],
    parameters: {
      color: { name: "Curtain Color", type: "color", description: "Color", default: "#101827" },
      durationFrames: { name: "Duration", type: "number", description: "Frames", default: 16, min: 4, max: 45 },
    },
    apply: (ctx, params) => {
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      const curtain: RectLayer = {
        kind: "rect",
        id: "tr-solid-wipe-r",
        x: -ctx.compositionWidth,
        y: 0,
        width: ctx.compositionWidth,
        height: ctx.compositionHeight,
        rotation: 0,
        opacity: 1,
        fill: params.color,
        tracks: [
          createTrack("x", [
            { frame: ctx.startFrame, value: -ctx.compositionWidth, easing: "easeInOut" },
            { frame: ctx.startFrame + Math.floor(dur * 0.5), value: 0, easing: "easeInOut" },
            { frame: ctx.startFrame + dur, value: ctx.compositionWidth, easing: "easeInOut" },
          ]),
        ],
      };
      return { newLayers: [curtain] };
    },
  },
  {
    id: "transition-slide-over-up",
    name: "Solid Wipe Over Upward",
    category: "transition",
    description: "Full-bleed solid curtain sweeps upward across screen.",
    tags: ["wipe", "solid", "curtain", "transition"],
    targetKinds: ["scene"],
    parameters: {
      color: { name: "Curtain Color", type: "color", description: "Color", default: "#101827" },
      durationFrames: { name: "Duration", type: "number", description: "Frames", default: 16, min: 4, max: 45 },
    },
    apply: (ctx, params) => {
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      const curtain: RectLayer = {
        kind: "rect",
        id: "tr-solid-wipe-u",
        x: 0,
        y: ctx.compositionHeight,
        width: ctx.compositionWidth,
        height: ctx.compositionHeight,
        rotation: 0,
        opacity: 1,
        fill: params.color,
        tracks: [
          createTrack("y", [
            { frame: ctx.startFrame, value: ctx.compositionHeight, easing: "easeInOut" },
            { frame: ctx.startFrame + Math.floor(dur * 0.5), value: 0, easing: "easeInOut" },
            { frame: ctx.startFrame + dur, value: -ctx.compositionHeight, easing: "easeInOut" },
          ]),
        ],
      };
      return { newLayers: [curtain] };
    },
  },
  {
    id: "transition-slide-over-down",
    name: "Solid Wipe Over Downward",
    category: "transition",
    description: "Full-bleed solid curtain sweeps downward across screen.",
    tags: ["wipe", "solid", "curtain", "transition"],
    targetKinds: ["scene"],
    parameters: {
      color: { name: "Curtain Color", type: "color", description: "Color", default: "#101827" },
      durationFrames: { name: "Duration", type: "number", description: "Frames", default: 16, min: 4, max: 45 },
    },
    apply: (ctx, params) => {
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      const curtain: RectLayer = {
        kind: "rect",
        id: "tr-solid-wipe-d",
        x: 0,
        y: -ctx.compositionHeight,
        width: ctx.compositionWidth,
        height: ctx.compositionHeight,
        rotation: 0,
        opacity: 1,
        fill: params.color,
        tracks: [
          createTrack("y", [
            { frame: ctx.startFrame, value: -ctx.compositionHeight, easing: "easeInOut" },
            { frame: ctx.startFrame + Math.floor(dur * 0.5), value: 0, easing: "easeInOut" },
            { frame: ctx.startFrame + dur, value: ctx.compositionHeight, easing: "easeInOut" },
          ]),
        ],
      };
      return { newLayers: [curtain] };
    },
  },
  {
    id: "transition-blind-bars-3",
    name: "Three Horizontal Blind Bars",
    category: "transition",
    description: "Three horizontal slats that slide across simultaneously.",
    tags: ["blinds", "slats", "bars", "transition"],
    targetKinds: ["scene"],
    parameters: {
      barColor: { name: "Bar Color", type: "color", description: "Color", default: "#FF6A8D" },
      durationFrames: { name: "Duration", type: "number", description: "Frames", default: 18, min: 6, max: 45 },
    },
    apply: (ctx, params) => {
      const barH = Math.ceil(ctx.compositionHeight / 3);
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      const mid = ctx.startFrame + Math.floor(ctx.durationFrames * 0.5);
      const f0 = Math.max(ctx.startFrame, mid - Math.floor(dur * 0.5));
      const f1 = Math.min(ctx.endFrame, f0 + dur);
      const bars: RectLayer[] = [];
      for (let i = 0; i < 3; i++) {
        const sign = i % 2 === 0 ? 1 : -1;
        const startX = sign * ctx.compositionWidth;
        const endX = -sign * ctx.compositionWidth;
        bars.push({
          kind: "rect",
          id: `tr-blind-bar-${i}`,
          x: startX,
          y: i * barH,
          width: ctx.compositionWidth,
          height: barH,
          rotation: 0,
          opacity: 1,
          fill: params.barColor,
          tracks: [
            createTrack("x", [
              { frame: f0, value: startX, easing: "easeInOut" },
              { frame: f0 + Math.floor(dur * 0.5), value: 0, easing: "easeInOut" },
              { frame: f1, value: endX, easing: "easeInOut" },
            ]),
          ],
        });
      }
      return { newLayers: bars };
    },
  },
  {
    id: "transition-glitch-flash",
    name: "Staccato Glitch Flash",
    category: "transition",
    description: "Rapid high-energy two-burst digital flash cut.",
    tags: ["glitch", "flash", "cyberpunk", "transition"],
    targetKinds: ["scene"],
    parameters: {
      color: { name: "Flash Color", type: "color", description: "Color", default: "#0ADEE8" },
    },
    apply: (ctx, params) => {
      const mid = ctx.startFrame + Math.floor(ctx.durationFrames * 0.5);
      const overlay: RectLayer = {
        kind: "rect",
        id: "tr-glitch-flash",
        x: 0,
        y: 0,
        width: ctx.compositionWidth,
        height: ctx.compositionHeight,
        rotation: 0,
        opacity: 0,
        fill: params.color,
        tracks: [
          createTrack("opacity", [
            { frame: Math.max(ctx.startFrame, mid - 4), value: 0 },
            { frame: Math.max(ctx.startFrame, mid - 3), value: 0.9 },
            { frame: Math.max(ctx.startFrame, mid - 2), value: 0 },
            { frame: mid, value: 0.95 },
            { frame: Math.min(ctx.endFrame, mid + 2), value: 0 },
          ]),
        ],
      };
      return { newLayers: [overlay] };
    },
  },
  {
    id: "transition-dissolve-fade",
    name: "Slow Atmospheric Dissolve",
    category: "transition",
    description: "Extended graceful dissolve bridging poetic scene transitions.",
    tags: ["dissolve", "slow", "ambient", "transition"],
    targetKinds: ["text", "rect", "image", "scene"],
    parameters: {
      durationFrames: { name: "Dissolve Frames", type: "number", description: "Fade frames", default: 24, min: 8, max: 90 },
    },
    apply: (ctx, params) => {
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      return {
        tracks: [
          createTrack("opacity", [
            { frame: ctx.startFrame, value: 0, easing: "easeInOut" },
            { frame: ctx.startFrame + dur, value: 1, easing: "linear" },
            { frame: Math.max(ctx.startFrame + dur, ctx.endFrame - dur), value: 1, easing: "easeInOut" },
            { frame: ctx.endFrame, value: 0, easing: "linear" },
          ]),
        ],
      };
    },
  },
  {
    id: "transition-iris-expand",
    name: "Iris Box Expand",
    category: "transition",
    description: "Centered rounded iris block expanding from center out to fill frame.",
    tags: ["iris", "expand", "retro", "transition"],
    targetKinds: ["scene"],
    parameters: {
      color: { name: "Iris Color", type: "color", description: "Color", default: "#101827" },
      durationFrames: { name: "Duration", type: "number", description: "Frames", default: 16, min: 4, max: 45 },
    },
    apply: (ctx, params) => {
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      const cx = Math.floor(ctx.compositionWidth / 2);
      const cy = Math.floor(ctx.compositionHeight / 2);
      const maxDim = Math.max(ctx.compositionWidth, ctx.compositionHeight);
      const iris: RectLayer = {
        kind: "rect",
        id: "tr-iris-expand",
        x: cx - 20,
        y: cy - 20,
        width: 40,
        height: 40,
        cornerRadius: 20,
        rotation: 0,
        opacity: 1,
        fill: params.color,
        tracks: [
          createTrack("x", [
            { frame: ctx.startFrame, value: cx - 20, easing: "easeInOut" },
            { frame: ctx.startFrame + dur, value: cx - maxDim, easing: "easeInOut" },
          ]),
          createTrack("y", [
            { frame: ctx.startFrame, value: cy - 20, easing: "easeInOut" },
            { frame: ctx.startFrame + dur, value: cy - maxDim, easing: "easeInOut" },
          ]),
        ],
      };
      return { newLayers: [iris] };
    },
  },
  {
    id: "transition-iris-contract",
    name: "Iris Box Contract",
    category: "transition",
    description: "Centered rounded iris block contracting down to focal point.",
    tags: ["iris", "contract", "retro", "transition"],
    targetKinds: ["scene"],
    parameters: {
      color: { name: "Iris Color", type: "color", description: "Color", default: "#101827" },
      durationFrames: { name: "Duration", type: "number", description: "Frames", default: 16, min: 4, max: 45 },
    },
    apply: (ctx, params) => {
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      const cx = Math.floor(ctx.compositionWidth / 2);
      const cy = Math.floor(ctx.compositionHeight / 2);
      const maxDim = Math.max(ctx.compositionWidth, ctx.compositionHeight);
      const iris: RectLayer = {
        kind: "rect",
        id: "tr-iris-contract",
        x: cx - maxDim,
        y: cy - maxDim,
        width: maxDim * 2,
        height: maxDim * 2,
        cornerRadius: 40,
        rotation: 0,
        opacity: 1,
        fill: params.color,
        tracks: [
          createTrack("x", [
            { frame: ctx.startFrame, value: cx - maxDim, easing: "easeInOut" },
            { frame: ctx.startFrame + dur, value: cx - 20, easing: "easeInOut" },
          ]),
          createTrack("y", [
            { frame: ctx.startFrame, value: cy - maxDim, easing: "easeInOut" },
            { frame: ctx.startFrame + dur, value: cy - 20, easing: "easeInOut" },
          ]),
        ],
      };
      return { newLayers: [iris] };
    },
  },
  {
    id: "transition-diagonal-wipe-slash",
    name: "Diagonal Wipe Slash",
    category: "transition",
    description: "Rotated 45-degree slash banner wiping across the screen.",
    tags: ["slash", "diagonal", "wipe", "transition"],
    targetKinds: ["scene"],
    parameters: {
      slashColor: { name: "Slash Color", type: "color", description: "Color", default: "#FFCA32" },
      durationFrames: { name: "Duration", type: "number", description: "Frames", default: 16, min: 6, max: 45 },
    },
    apply: (ctx, params) => {
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      const mid = ctx.startFrame + Math.floor(ctx.durationFrames * 0.5);
      const f0 = Math.max(ctx.startFrame, mid - Math.floor(dur * 0.5));
      const f1 = Math.min(ctx.endFrame, f0 + dur);
      const slash: RectLayer = {
        kind: "rect",
        id: "tr-diagonal-slash",
        x: -ctx.compositionWidth,
        y: 0,
        width: 300,
        height: ctx.compositionHeight * 2,
        rotation: 35,
        opacity: 1,
        fill: params.slashColor,
        tracks: [
          createTrack("x", [
            { frame: f0, value: -ctx.compositionWidth, easing: "easeInOut" },
            { frame: f1, value: ctx.compositionWidth * 1.5, easing: "easeInOut" },
          ]),
        ],
      };
      return { newLayers: [slash] };
    },
  },
  {
    id: "transition-blind-bars-5",
    name: "Five Vertical Blind Slats",
    category: "transition",
    description: "Five vertical striped slats that slide across simultaneously.",
    tags: ["blinds", "slats", "bars", "transition"],
    targetKinds: ["scene"],
    parameters: {
      barColor: { name: "Bar Color", type: "color", description: "Color", default: "#0ADEE8" },
      durationFrames: { name: "Duration", type: "number", description: "Frames", default: 18, min: 6, max: 45 },
    },
    apply: (ctx, params) => {
      const barW = Math.ceil(ctx.compositionWidth / 5);
      const dur = Math.min(ctx.durationFrames, params.durationFrames);
      const mid = ctx.startFrame + Math.floor(ctx.durationFrames * 0.5);
      const f0 = Math.max(ctx.startFrame, mid - Math.floor(dur * 0.5));
      const f1 = Math.min(ctx.endFrame, f0 + dur);
      const bars: RectLayer[] = [];
      for (let i = 0; i < 5; i++) {
        const sign = i % 2 === 0 ? 1 : -1;
        const startY = sign * ctx.compositionHeight;
        const endY = -sign * ctx.compositionHeight;
        bars.push({
          kind: "rect",
          id: `tr-blind-col-${i}`,
          x: i * barW,
          y: startY,
          width: barW,
          height: ctx.compositionHeight,
          rotation: 0,
          opacity: 1,
          fill: params.barColor,
          tracks: [
            createTrack("y", [
              { frame: f0, value: startY, easing: "easeInOut" },
              { frame: f0 + Math.floor(dur * 0.5), value: 0, easing: "easeInOut" },
              { frame: f1, value: endY, easing: "easeInOut" },
            ]),
          ],
        });
      }
      return { newLayers: bars };
    },
  },
  {
    id: "transition-shutter-snap",
    name: "Mechanical Shutter Snap",
    category: "transition",
    description: "Camera aperture shutter snap closing to darkness and reopening instantly.",
    tags: ["shutter", "aperture", "snap", "transition"],
    targetKinds: ["scene"],
    parameters: {
      shutterColor: { name: "Color", type: "color", description: "Color", default: "#000000" },
    },
    apply: (ctx, params) => {
      const mid = ctx.startFrame + Math.floor(ctx.durationFrames * 0.5);
      const overlay: RectLayer = {
        kind: "rect",
        id: "tr-shutter-snap",
        x: 0,
        y: 0,
        width: ctx.compositionWidth,
        height: ctx.compositionHeight,
        rotation: 0,
        opacity: 0,
        fill: params.shutterColor,
        tracks: [
          createTrack("opacity", [
            { frame: Math.max(ctx.startFrame, mid - 2), value: 0 },
            { frame: mid, value: 1 },
            { frame: Math.min(ctx.endFrame, mid + 2), value: 0 },
          ]),
        ],
      };
      return { newLayers: [overlay] };
    },
  },
];
