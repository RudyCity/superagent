import type { EffectDefinition } from "../types.js";
import { createTrack } from "../registry.js";
import type { RectLayer, TextLayer } from "../../schema/types.js";

function getLayerBounds(ctx: any): { x: number; y: number; width: number; height: number } {
  return {
    x: ctx.targetLayer?.x ?? Math.round(ctx.compositionWidth * 0.1),
    y: ctx.targetLayer?.y ?? Math.round(ctx.compositionHeight * 0.4),
    width: ctx.targetLayer?.width ?? 320,
    height: ctx.targetLayer?.height ?? 80,
  };
}

export const graphicAccentEffects: EffectDefinition[] = [
  {
    id: "accent-kinetic-underline",
    name: "Growing Kinetic Underline",
    category: "graphic-accent",
    description: "An animated underline bar that draws itself dynamically beneath the target text.",
    tags: ["underline", "kinetic", "highlight", "draw"],
    targetKinds: ["text", "rect"],
    parameters: {
      color: { name: "Line Color", type: "color", description: "Color of underline", default: "#36F4D3" },
      thickness: { name: "Thickness", type: "number", description: "Line height in pixels", default: 6, min: 2, max: 24 },
      growFrames: { name: "Draw Frames", type: "number", description: "Frames to expand", default: 14, min: 4, max: 60 },
    },
    apply: (ctx, params) => {
      const b = getLayerBounds(ctx);
      const lineY = b.y + b.height + 8;
      const dur = Math.min(ctx.durationFrames, params.growFrames);
      const line: RectLayer = {
        kind: "rect",
        id: "accent-grow-underline",
        x: b.x,
        y: lineY,
        width: b.width,
        height: params.thickness,
        rotation: 0,
        opacity: 1,
        fill: params.color,
        tracks: [
          createTrack("x", [
            { frame: ctx.startFrame, value: b.x - Math.floor(b.width * 0.4), easing: "easeInOut" },
            { frame: ctx.startFrame + dur, value: b.x, easing: "easeInOut" },
          ]),
          createTrack("opacity", [
            { frame: ctx.startFrame, value: 0, easing: "easeInOut" },
            { frame: ctx.startFrame + Math.min(dur, 6), value: 1, easing: "linear" },
          ]),
        ],
      };
      return { newLayers: [line] };
    },
  },
  {
    id: "accent-highlight-box",
    name: "Marker Highlight Underlay",
    category: "graphic-accent",
    description: "A soft highlighter box drawn behind the target text emphasizing keywords.",
    tags: ["highlight", "box", "marker", "underlay"],
    targetKinds: ["text", "rect"],
    parameters: {
      color: { name: "Highlight Color", type: "color", description: "Color", default: "#FFDF59" },
      opacity: { name: "Highlight Opacity", type: "number", description: "Opacity", default: 0.35, min: 0.1, max: 0.9 },
      padding: { name: "Padding", type: "number", description: "Padding around text", default: 8, min: 2, max: 30 },
    },
    apply: (ctx, params) => {
      const b = getLayerBounds(ctx);
      const p = params.padding;
      const box: RectLayer = {
        kind: "rect",
        id: "accent-highlight-box",
        x: b.x - p,
        y: b.y - p,
        width: b.width + 2 * p,
        height: b.height + 2 * p,
        cornerRadius: 4,
        rotation: 0,
        opacity: params.opacity,
        fill: params.color,
        tracks: [
          createTrack("opacity", [
            { frame: ctx.startFrame, value: 0, easing: "easeInOut" },
            { frame: ctx.startFrame + 8, value: params.opacity, easing: "linear" },
          ]),
        ],
      };
      return { newLayers: [box] };
    },
  },
  {
    id: "accent-kicker-tag",
    name: "Editorial Kicker Tag",
    category: "graphic-accent",
    description: "Uppercase category or chapter kicker label situated directly above headline.",
    tags: ["kicker", "tag", "editorial", "label"],
    targetKinds: ["text", "rect", "scene"],
    parameters: {
      text: { name: "Kicker Text", type: "string", description: "Short text", default: "CHAPTER 01" },
      color: { name: "Tag Color", type: "color", description: "Color", default: "#36F4D3" },
      fontSize: { name: "Font Size", type: "number", description: "Pixels", default: 22, min: 12, max: 48 },
    },
    apply: (ctx, params) => {
      const b = getLayerBounds(ctx);
      const label: TextLayer = {
        kind: "text",
        id: "accent-kicker-text",
        text: params.text,
        fontSize: params.fontSize,
        fontFamily: "Arial",
        x: b.x,
        y: Math.max(20, b.y - params.fontSize - 14),
        width: 240,
        height: params.fontSize + 8,
        rotation: 0,
        opacity: 1,
        fill: params.color,
        tracks: [
          createTrack("opacity", [
            { frame: ctx.startFrame, value: 0, easing: "easeInOut" },
            { frame: ctx.startFrame + 8, value: 1, easing: "linear" },
          ]),
        ],
      };
      return { newLayers: [label] };
    },
  },
  {
    id: "accent-bracket-focus",
    name: "Enclosing Bracket Rules",
    category: "graphic-accent",
    description: "Vertical left and right framing ticks focusing attention onto the element.",
    tags: ["bracket", "focus", "framing", "accent"],
    targetKinds: ["text", "rect"],
    parameters: {
      color: { name: "Bracket Color", type: "color", description: "Color", default: "#FF6A8D" },
      gap: { name: "Side Gap", type: "number", description: "Pixels away from layer", default: 16, min: 4, max: 60 },
    },
    apply: (ctx, params) => {
      const b = getLayerBounds(ctx);
      const g = params.gap;
      const left: RectLayer = {
        kind: "rect",
        id: "accent-bracket-l",
        x: b.x - g - 4,
        y: b.y,
        width: 4,
        height: b.height,
        rotation: 0,
        opacity: 0.9,
        fill: params.color,
        tracks: [],
      };
      const right: RectLayer = {
        kind: "rect",
        id: "accent-bracket-r",
        x: b.x + b.width + g,
        y: b.y,
        width: 4,
        height: b.height,
        rotation: 0,
        opacity: 0.9,
        fill: params.color,
        tracks: [],
      };
      return { newLayers: [left, right] };
    },
  },
  {
    id: "accent-quote-notch",
    name: "Thick Quotation Notch",
    category: "graphic-accent",
    description: "Authoritative thick vertical quotation rule situated on the left flank.",
    tags: ["quote", "notch", "vertical", "accent"],
    targetKinds: ["text", "rect"],
    parameters: {
      color: { name: "Notch Color", type: "color", description: "Color", default: "#3B82F6" },
      thickness: { name: "Thickness", type: "number", description: "Pixels", default: 8, min: 2, max: 24 },
    },
    apply: (ctx, params) => {
      const b = getLayerBounds(ctx);
      const notch: RectLayer = {
        kind: "rect",
        id: "accent-quote-notch",
        x: Math.max(10, b.x - params.thickness - 16),
        y: b.y,
        width: params.thickness,
        height: b.height,
        cornerRadius: 2,
        rotation: 0,
        opacity: 0.95,
        fill: params.color,
        tracks: [
          createTrack("opacity", [
            { frame: ctx.startFrame, value: 0, easing: "easeInOut" },
            { frame: ctx.startFrame + 6, value: 0.95, easing: "linear" },
          ]),
        ],
      };
      return { newLayers: [notch] };
    },
  },
  {
    id: "accent-progress-bar",
    name: "Linear Progress Meter",
    category: "graphic-accent",
    description: "Smoothly filling horizontal progress bar communicating timeline advance.",
    tags: ["progress", "meter", "timeline", "accent"],
    targetKinds: ["scene"],
    parameters: {
      barColor: { name: "Fill Color", type: "color", description: "Color", default: "#10B981" },
      trackColor: { name: "Track Color", type: "color", description: "Background line color", default: "#374151" },
      height: { name: "Height", type: "number", description: "Pixels", default: 6, min: 2, max: 20 },
    },
    apply: (ctx, params) => {
      const margin = 48;
      const w = ctx.compositionWidth - 2 * margin;
      const y = ctx.compositionHeight - 32;
      const track: RectLayer = {
        kind: "rect",
        id: "accent-prog-track",
        x: margin,
        y,
        width: w,
        height: params.height,
        cornerRadius: Math.round(params.height / 2),
        rotation: 0,
        opacity: 0.4,
        fill: params.trackColor,
        tracks: [],
      };
      const fill: RectLayer = {
        kind: "rect",
        id: "accent-prog-fill",
        x: margin,
        y,
        width: w,
        height: params.height,
        cornerRadius: Math.round(params.height / 2),
        rotation: 0,
        opacity: 0.95,
        fill: params.barColor,
        tracks: [
          createTrack("x", [
            { frame: ctx.startFrame, value: margin - w, easing: "linear" },
            { frame: ctx.endFrame, value: margin, easing: "linear" },
          ]),
        ],
      };
      return { newLayers: [track, fill] };
    },
  },
  {
    id: "accent-pulse-dot",
    name: "Pulsing Status Beacon Dot",
    category: "graphic-accent",
    description: "Flashing circular status beacon dot communicating live presence.",
    tags: ["dot", "status", "beacon", "pulse"],
    targetKinds: ["text", "rect", "scene"],
    parameters: {
      dotColor: { name: "Dot Color", type: "color", description: "Color", default: "#EF4444" },
      size: { name: "Dot Diameter", type: "number", description: "Pixels", default: 14, min: 6, max: 36 },
      periodFrames: { name: "Blink Period", type: "number", description: "Frames per pulse", default: 20, min: 6, max: 60 },
    },
    apply: (ctx, params) => {
      const b = getLayerBounds(ctx);
      const dot: RectLayer = {
        kind: "rect",
        id: "accent-pulse-beacon",
        x: b.x - params.size - 12,
        y: b.y + 6,
        width: params.size,
        height: params.size,
        cornerRadius: Math.round(params.size / 2),
        rotation: 0,
        opacity: 1,
        fill: params.dotColor,
        tracks: [],
      };
      const kfOp: { frame: number; value: number; easing?: "easeInOut" }[] = [];
      const period = Math.max(6, Math.floor(params.periodFrames));
      for (let f = ctx.startFrame; f <= ctx.endFrame; f += period) {
        kfOp.push({ frame: f, value: 1, easing: "easeInOut" });
        kfOp.push({ frame: Math.min(ctx.endFrame, f + Math.floor(period * 0.5)), value: 0.25, easing: "easeInOut" });
      }
      kfOp.push({ frame: ctx.endFrame, value: 1, easing: "easeInOut" });
      dot.tracks = [createTrack("opacity", kfOp)];
      return { newLayers: [dot] };
    },
  },
  {
    id: "accent-badge-backdrop",
    name: "Rounded Category Pill Badge",
    category: "graphic-accent",
    description: "Solid rounded pill backdrop container for short tag text.",
    tags: ["badge", "pill", "container", "accent"],
    targetKinds: ["text"],
    parameters: {
      color: { name: "Badge Color", type: "color", description: "Color", default: "#1E293B" },
      cornerRadius: { name: "Radius", type: "number", description: "Pixels", default: 16, min: 4, max: 40 },
    },
    apply: (ctx, params) => {
      const b = getLayerBounds(ctx);
      const pad = 12;
      const badge: RectLayer = {
        kind: "rect",
        id: "accent-badge-pill",
        x: b.x - pad,
        y: b.y - pad / 2,
        width: b.width + 2 * pad,
        height: b.height + pad,
        cornerRadius: params.cornerRadius,
        rotation: 0,
        opacity: 0.9,
        fill: params.color,
        tracks: [],
      };
      return { newLayers: [badge] };
    },
  },
  {
    id: "accent-side-pillar",
    name: "Architectural Side Pillar Rule",
    category: "graphic-accent",
    description: "Vertical editorial rule flanking the content block.",
    tags: ["pillar", "rule", "editorial", "accent"],
    targetKinds: ["text", "rect"],
    parameters: {
      color: { name: "Color", type: "color", description: "Color", default: "#6366F1" },
      thickness: { name: "Width", type: "number", description: "Pixels", default: 5, min: 1, max: 20 },
    },
    apply: (ctx, params) => {
      const b = getLayerBounds(ctx);
      const pillar: RectLayer = {
        kind: "rect",
        id: "accent-side-rule",
        x: Math.max(10, b.x - params.thickness - 20),
        y: b.y - 10,
        width: params.thickness,
        height: b.height + 20,
        rotation: 0,
        opacity: 0.8,
        fill: params.color,
        tracks: [],
      };
      return { newLayers: [pillar] };
    },
  },
  {
    id: "accent-bottom-rule-thick",
    name: "Brutalist Heavy Bottom Slab",
    category: "graphic-accent",
    description: "Heavy 12px horizontal brutalist bottom slab grounding the hero element.",
    tags: ["bottom", "slab", "brutalist", "heavy"],
    targetKinds: ["text", "rect"],
    parameters: {
      color: { name: "Color", type: "color", description: "Color", default: "#F59E0B" },
      thickness: { name: "Thickness", type: "number", description: "Pixels", default: 12, min: 4, max: 32 },
    },
    apply: (ctx, params) => {
      const b = getLayerBounds(ctx);
      const slab: RectLayer = {
        kind: "rect",
        id: "accent-bottom-heavy-slab",
        x: b.x,
        y: b.y + b.height + 12,
        width: Math.min(b.width, 240),
        height: params.thickness,
        rotation: 0,
        opacity: 1,
        fill: params.color,
        tracks: [],
      };
      return { newLayers: [slab] };
    },
  },
  {
    id: "accent-corner-pip",
    name: "Corner Registration Pip",
    category: "graphic-accent",
    description: "Compact precision square pip stationed at element vertex.",
    tags: ["pip", "registration", "corner", "tech"],
    targetKinds: ["text", "rect"],
    parameters: {
      color: { name: "Color", type: "color", description: "Color", default: "#0ADEE8" },
      size: { name: "Pip Size", type: "number", description: "Pixels", default: 8, min: 3, max: 20 },
    },
    apply: (ctx, params) => {
      const b = getLayerBounds(ctx);
      const pip: RectLayer = {
        kind: "rect",
        id: "accent-corner-pip",
        x: b.x - params.size - 8,
        y: b.y,
        width: params.size,
        height: params.size,
        rotation: 0,
        opacity: 0.9,
        fill: params.color,
        tracks: [],
      };
      return { newLayers: [pip] };
    },
  },
  {
    id: "accent-double-underline",
    name: "Refined Double Underline",
    category: "graphic-accent",
    description: "Two parallel delicate underline rules providing classic literary authority.",
    tags: ["underline", "double", "literary", "editorial"],
    targetKinds: ["text"],
    parameters: {
      color: { name: "Color", type: "color", description: "Color", default: "#D97706" },
      spacing: { name: "Gap", type: "number", description: "Pixels between lines", default: 5, min: 2, max: 15 },
    },
    apply: (ctx, params) => {
      const b = getLayerBounds(ctx);
      const y1 = b.y + b.height + 8;
      const y2 = y1 + params.spacing + 2;
      const l1: RectLayer = {
        kind: "rect",
        id: "accent-dbl-under-1",
        x: b.x,
        y: y1,
        width: b.width,
        height: 2,
        rotation: 0,
        opacity: 0.8,
        fill: params.color,
        tracks: [],
      };
      const l2: RectLayer = {
        kind: "rect",
        id: "accent-dbl-under-2",
        x: b.x,
        y: y2,
        width: b.width,
        height: 2,
        rotation: 0,
        opacity: 0.5,
        fill: params.color,
        tracks: [],
      };
      return { newLayers: [l1, l2] };
    },
  },
  {
    id: "accent-overbar",
    name: "Minimalist Overbar",
    category: "graphic-accent",
    description: "Slender horizontal rule positioned cleanly above headline.",
    tags: ["overbar", "rule", "minimalist", "accent"],
    targetKinds: ["text", "rect"],
    parameters: {
      color: { name: "Color", type: "color", description: "Color", default: "#A855F7" },
      width: { name: "Bar Width", type: "number", description: "Pixels", default: 120, min: 20, max: 400 },
    },
    apply: (ctx, params) => {
      const b = getLayerBounds(ctx);
      const overbar: RectLayer = {
        kind: "rect",
        id: "accent-overbar-line",
        x: b.x,
        y: Math.max(10, b.y - 18),
        width: params.width,
        height: 3,
        rotation: 0,
        opacity: 0.85,
        fill: params.color,
        tracks: [],
      };
      return { newLayers: [overbar] };
    },
  },
  {
    id: "accent-bullet-diamond",
    name: "Rotated Diamond Bullet",
    category: "graphic-accent",
    description: "Rotated 45-degree diamond glyph preceding key points.",
    tags: ["bullet", "diamond", "accent"],
    targetKinds: ["text"],
    parameters: {
      color: { name: "Color", type: "color", description: "Color", default: "#EC4899" },
      size: { name: "Size", type: "number", description: "Pixels", default: 10, min: 4, max: 24 },
    },
    apply: (ctx, params) => {
      const b = getLayerBounds(ctx);
      const diamond: RectLayer = {
        kind: "rect",
        id: "accent-bullet-diamond",
        x: b.x - params.size - 16,
        y: b.y + Math.floor(b.height * 0.35),
        width: params.size,
        height: params.size,
        rotation: 45,
        opacity: 0.9,
        fill: params.color,
        tracks: [],
      };
      return { newLayers: [diamond] };
    },
  },
  {
    id: "accent-bracket-top-bottom",
    name: "Framing Top-Bottom Rules",
    category: "graphic-accent",
    description: "Delicate horizontal rules bounding element from above and below.",
    tags: ["framing", "rules", "editorial", "accent"],
    targetKinds: ["text", "rect"],
    parameters: {
      color: { name: "Color", type: "color", description: "Color", default: "#64748B" },
    },
    apply: (ctx, params) => {
      const b = getLayerBounds(ctx);
      const top: RectLayer = {
        kind: "rect",
        id: "accent-frame-rule-t",
        x: b.x,
        y: b.y - 12,
        width: b.width,
        height: 1,
        rotation: 0,
        opacity: 0.6,
        fill: params.color,
        tracks: [],
      };
      const bot: RectLayer = {
        kind: "rect",
        id: "accent-frame-rule-b",
        x: b.x,
        y: b.y + b.height + 12,
        width: b.width,
        height: 1,
        rotation: 0,
        opacity: 0.6,
        fill: params.color,
        tracks: [],
      };
      return { newLayers: [top, bot] };
    },
  },
  {
    id: "accent-step-counter",
    name: "Numbered Step Block",
    category: "graphic-accent",
    description: "Prominent numerical index callout block emphasizing order.",
    tags: ["step", "counter", "number", "accent"],
    targetKinds: ["text", "rect", "scene"],
    parameters: {
      stepNumber: { name: "Step Number", type: "string", description: "Index text", default: "01" },
      color: { name: "Color", type: "color", description: "Color", default: "#FFDF59" },
    },
    apply: (ctx, params) => {
      const b = getLayerBounds(ctx);
      const text: TextLayer = {
        kind: "text",
        id: "accent-step-idx",
        text: params.stepNumber,
        fontSize: 32,
        fontFamily: "Arial",
        x: b.x - 55,
        y: b.y,
        width: 48,
        height: 40,
        rotation: 0,
        opacity: 0.85,
        fill: params.color,
        tracks: [],
      };
      return { newLayers: [text] };
    },
  },
  {
    id: "accent-slash-decor",
    name: "Triple Diagonal Slash Decor",
    category: "graphic-accent",
    description: "Cyberpunk triple angled slashes /// preceding headline copy.",
    tags: ["slashes", "cyberpunk", "tech", "accent"],
    targetKinds: ["text", "rect"],
    parameters: {
      color: { name: "Color", type: "color", description: "Color", default: "#36F4D3" },
    },
    apply: (ctx, params) => {
      const b = getLayerBounds(ctx);
      const slashes: RectLayer[] = [];
      for (let i = 0; i < 3; i++) {
        slashes.push({
          kind: "rect",
          id: `accent-slash-${i}`,
          x: b.x - 42 + i * 10,
          y: b.y + 4,
          width: 3,
          height: 18,
          rotation: -25,
          opacity: 0.85,
          fill: params.color,
          tracks: [],
        });
      }
      return { newLayers: slashes };
    },
  },
  {
    id: "accent-warning-stripe",
    name: "Warning Caution Tick",
    category: "graphic-accent",
    description: "Vibrant yellow vertical caution indicator bar on flank.",
    tags: ["warning", "caution", "indicator", "accent"],
    targetKinds: ["text", "rect"],
    parameters: {
      color: { name: "Color", type: "color", description: "Color", default: "#EAB308" },
    },
    apply: (ctx, params) => {
      const b = getLayerBounds(ctx);
      const tick: RectLayer = {
        kind: "rect",
        id: "accent-caution-tick",
        x: b.x - 14,
        y: b.y + 2,
        width: 5,
        height: 22,
        rotation: 0,
        opacity: 1,
        fill: params.color,
        tracks: [],
      };
      return { newLayers: [tick] };
    },
  },
  {
    id: "accent-arrow-indicator",
    name: "Directional Callout Arrow",
    category: "graphic-accent",
    description: "Graphic horizontal pointer indicator accent directing gaze to target.",
    tags: ["arrow", "pointer", "direction", "accent"],
    targetKinds: ["text", "rect"],
    parameters: {
      color: { name: "Color", type: "color", description: "Color", default: "#10B981" },
    },
    apply: (ctx, params) => {
      const b = getLayerBounds(ctx);
      const shaft: RectLayer = {
        kind: "rect",
        id: "accent-arrow-shaft",
        x: b.x + b.width + 12,
        y: b.y + Math.floor(b.height * 0.5) - 1,
        width: 24,
        height: 2,
        rotation: 0,
        opacity: 0.9,
        fill: params.color,
        tracks: [],
      };
      const tip1: RectLayer = {
        kind: "rect",
        id: "accent-arrow-tip1",
        x: b.x + b.width + 28,
        y: b.y + Math.floor(b.height * 0.5) - 4,
        width: 8,
        height: 2,
        rotation: 45,
        opacity: 0.9,
        fill: params.color,
        tracks: [],
      };
      const tip2: RectLayer = {
        kind: "rect",
        id: "accent-arrow-tip2",
        x: b.x + b.width + 28,
        y: b.y + Math.floor(b.height * 0.5) + 2,
        width: 8,
        height: 2,
        rotation: -45,
        opacity: 0.9,
        fill: params.color,
        tracks: [],
      };
      return { newLayers: [shaft, tip1, tip2] };
    },
  },
  {
    id: "accent-chevron-sweep",
    name: "Double Chevron Arrow",
    category: "graphic-accent",
    description: "Sleek tech forward chevron >> indicating advancement.",
    tags: ["chevron", "arrow", "tech", "accent"],
    targetKinds: ["text", "rect"],
    parameters: {
      color: { name: "Color", type: "color", description: "Color", default: "#38BDF8" },
    },
    apply: (ctx, params) => {
      const b = getLayerBounds(ctx);
      const text: TextLayer = {
        kind: "text",
        id: "accent-chevron-txt",
        text: ">>",
        fontSize: 20,
        fontFamily: "Arial",
        x: b.x + b.width + 12,
        y: b.y + 2,
        width: 32,
        height: 24,
        rotation: 0,
        opacity: 0.85,
        fill: params.color,
        tracks: [],
      };
      return { newLayers: [text] };
    },
  },
  {
    id: "accent-split-rule",
    name: "Centering Split Rule",
    category: "graphic-accent",
    description: "Two balanced horizontal rules parting around a central diamond icon.",
    tags: ["split", "rule", "center", "accent"],
    targetKinds: ["text", "rect"],
    parameters: {
      color: { name: "Color", type: "color", description: "Color", default: "#94A3B8" },
    },
    apply: (ctx, params) => {
      const b = getLayerBounds(ctx);
      const halfW = Math.round((b.width - 24) / 2);
      const y = b.y + b.height + 10;
      const r1: RectLayer = {
        kind: "rect",
        id: "accent-split-l",
        x: b.x,
        y,
        width: halfW,
        height: 1,
        rotation: 0,
        opacity: 0.6,
        fill: params.color,
        tracks: [],
      };
      const dia: RectLayer = {
        kind: "rect",
        id: "accent-split-dia",
        x: b.x + halfW + 8,
        y: y - 3,
        width: 6,
        height: 6,
        rotation: 45,
        opacity: 0.8,
        fill: params.color,
        tracks: [],
      };
      const r2: RectLayer = {
        kind: "rect",
        id: "accent-split-r",
        x: b.x + halfW + 24,
        y,
        width: halfW,
        height: 1,
        rotation: 0,
        opacity: 0.6,
        fill: params.color,
        tracks: [],
      };
      return { newLayers: [r1, dia, r2] };
    },
  },
  {
    id: "accent-tech-callout",
    name: "HUD Leader Line Callout",
    category: "graphic-accent",
    description: "Angled technical callout pointer terminating in precision dot.",
    tags: ["callout", "leader", "hud", "technical"],
    targetKinds: ["text", "rect"],
    parameters: {
      color: { name: "Color", type: "color", description: "Color", default: "#36F4D3" },
    },
    apply: (ctx, params) => {
      const b = getLayerBounds(ctx);
      const l1: RectLayer = {
        kind: "rect",
        id: "accent-callout-stem",
        x: b.x - 30,
        y: b.y + 10,
        width: 25,
        height: 2,
        rotation: 0,
        opacity: 0.8,
        fill: params.color,
        tracks: [],
      };
      const dot: RectLayer = {
        kind: "rect",
        id: "accent-callout-pt",
        x: b.x - 35,
        y: b.y + 8,
        width: 6,
        height: 6,
        cornerRadius: 3,
        rotation: 0,
        opacity: 0.9,
        fill: params.color,
        tracks: [],
      };
      return { newLayers: [l1, dot] };
    },
  },
  {
    id: "accent-marker-scribble",
    name: "Highlighter Marker Underline",
    category: "graphic-accent",
    description: "Thick playful highlighter stroke underpinning words.",
    tags: ["marker", "highlight", "scribble", "accent"],
    targetKinds: ["text"],
    parameters: {
      color: { name: "Color", type: "color", description: "Color", default: "#FDE047" },
    },
    apply: (ctx, params) => {
      const b = getLayerBounds(ctx);
      const stroke: RectLayer = {
        kind: "rect",
        id: "accent-marker-stroke",
        x: b.x - 4,
        y: b.y + b.height - 4,
        width: b.width + 8,
        height: 10,
        cornerRadius: 4,
        rotation: -1,
        opacity: 0.45,
        fill: params.color,
        tracks: [],
      };
      return { newLayers: [stroke] };
    },
  },
  {
    id: "accent-bullet-square",
    name: "Square Graphic Bullet",
    category: "graphic-accent",
    description: "Technical solid square bullet marker in margin.",
    tags: ["bullet", "square", "tech", "accent"],
    targetKinds: ["text"],
    parameters: {
      color: { name: "Color", type: "color", description: "Color", default: "#3B82F6" },
      size: { name: "Size", type: "number", description: "Pixels", default: 8, min: 3, max: 20 },
    },
    apply: (ctx, params) => {
      const b = getLayerBounds(ctx);
      const sq: RectLayer = {
        kind: "rect",
        id: "accent-bullet-sq",
        x: b.x - params.size - 14,
        y: b.y + Math.floor(b.height * 0.4),
        width: params.size,
        height: params.size,
        rotation: 0,
        opacity: 0.9,
        fill: params.color,
        tracks: [],
      };
      return { newLayers: [sq] };
    },
  },
  {
    id: "accent-speech-tail",
    name: "Speech Bubble Pointer Tail",
    category: "graphic-accent",
    description: "Angled downward pointer converting container into conversational balloon.",
    tags: ["speech", "bubble", "tail", "chat"],
    targetKinds: ["rect"],
    parameters: {
      color: { name: "Color", type: "color", description: "Color", default: "#1E293B" },
    },
    apply: (ctx, params) => {
      const b = getLayerBounds(ctx);
      const tail: RectLayer = {
        kind: "rect",
        id: "accent-speech-tail",
        x: b.x + 36,
        y: b.y + b.height - 2,
        width: 14,
        height: 14,
        rotation: 45,
        opacity: 1,
        fill: params.color,
        tracks: [],
      };
      return { newLayers: [tail] };
    },
  },
  {
    id: "accent-status-capsule",
    name: "Capsule Status Pill Label",
    category: "graphic-accent",
    description: "Miniature pill label reading 'PRO' or 'LIVE'.",
    tags: ["capsule", "status", "pill", "label"],
    targetKinds: ["text", "rect"],
    parameters: {
      label: { name: "Text", type: "string", description: "Label text", default: "NEW" },
      color: { name: "Color", type: "color", description: "Color", default: "#10B981" },
    },
    apply: (ctx, params) => {
      const b = getLayerBounds(ctx);
      const text: TextLayer = {
        kind: "text",
        id: "accent-capsule-lbl",
        text: params.label,
        fontSize: 14,
        fontFamily: "Arial",
        x: b.x + b.width + 12,
        y: b.y + 4,
        width: 48,
        height: 18,
        rotation: 0,
        opacity: 1,
        fill: params.color,
        tracks: [],
      };
      return { newLayers: [text] };
    },
  },
  {
    id: "accent-dashed-rule",
    name: "Broken Dashed Underline",
    category: "graphic-accent",
    description: "Series of four technical dash strokes forming a dashed underline.",
    tags: ["dashed", "rule", "underline", "tech"],
    targetKinds: ["text"],
    parameters: {
      color: { name: "Color", type: "color", description: "Color", default: "#94A3B8" },
    },
    apply: (ctx, params) => {
      const b = getLayerBounds(ctx);
      const dashes: RectLayer[] = [];
      const dashW = Math.round(b.width / 6);
      const y = b.y + b.height + 8;
      for (let i = 0; i < 4; i++) {
        dashes.push({
          kind: "rect",
          id: `accent-dash-${i}`,
          x: b.x + i * Math.round(b.width / 4),
          y,
          width: dashW,
          height: 2,
          rotation: 0,
          opacity: 0.7,
          fill: params.color,
          tracks: [],
        });
      }
      return { newLayers: dashes };
    },
  },
  {
    id: "accent-hash-prefix",
    name: "Tag Hash Prefix",
    category: "graphic-accent",
    description: "Two crisp hash bars preceding topic heading copy.",
    tags: ["hash", "tag", "social", "accent"],
    targetKinds: ["text"],
    parameters: {
      color: { name: "Color", type: "color", description: "Color", default: "#6366F1" },
    },
    apply: (ctx, params) => {
      const b = getLayerBounds(ctx);
      const h1: RectLayer = {
        kind: "rect",
        id: "accent-hash-1",
        x: b.x - 24,
        y: b.y + 2,
        width: 3,
        height: 20,
        rotation: 15,
        opacity: 0.85,
        fill: params.color,
        tracks: [],
      };
      const h2: RectLayer = {
        kind: "rect",
        id: "accent-hash-2",
        x: b.x - 16,
        y: b.y + 2,
        width: 3,
        height: 20,
        rotation: 15,
        opacity: 0.85,
        fill: params.color,
        tracks: [],
      };
      return { newLayers: [h1, h2] };
    },
  },
  {
    id: "accent-target-circle",
    name: "Target Reticle Ring",
    category: "graphic-accent",
    description: "Circular reticle target framing an icon or focal point.",
    tags: ["target", "reticle", "circle", "tech"],
    targetKinds: ["text", "rect"],
    parameters: {
      color: { name: "Color", type: "color", description: "Color", default: "#38BDF8" },
      size: { name: "Diameter", type: "number", description: "Pixels", default: 28, min: 10, max: 80 },
    },
    apply: (ctx, params) => {
      const b = getLayerBounds(ctx);
      const ring: RectLayer = {
        kind: "rect",
        id: "accent-target-ring",
        x: b.x - params.size - 18,
        y: b.y + Math.floor(b.height * 0.3),
        width: params.size,
        height: params.size,
        cornerRadius: Math.round(params.size / 2),
        rotation: 0,
        opacity: 0.85,
        fill: params.color,
        tracks: [],
      };
      return { newLayers: [ring] };
    },
  },
  {
    id: "accent-notch-tab",
    name: "File Folder Index Tab",
    category: "graphic-accent",
    description: "Protruding index folder tab atop the container.",
    tags: ["tab", "folder", "index", "accent"],
    targetKinds: ["rect"],
    parameters: {
      color: { name: "Color", type: "color", description: "Color", default: "#0284C7" },
    },
    apply: (ctx, params) => {
      const b = getLayerBounds(ctx);
      const tab: RectLayer = {
        kind: "rect",
        id: "accent-notch-tab",
        x: b.x + 20,
        y: b.y - 10,
        width: 60,
        height: 10,
        cornerRadius: 3,
        rotation: 0,
        opacity: 0.95,
        fill: params.color,
        tracks: [],
      };
      return { newLayers: [tab] };
    },
  },
  {
    id: "accent-countdown-pip",
    name: "Countdown Step Pip",
    category: "graphic-accent",
    description: "Compact circular step pip for timeline sequences.",
    tags: ["pip", "countdown", "step", "accent"],
    targetKinds: ["text", "rect"],
    parameters: {
      color: { name: "Color", type: "color", description: "Color", default: "#F43F5E" },
    },
    apply: (ctx, params) => {
      const b = getLayerBounds(ctx);
      const pip: RectLayer = {
        kind: "rect",
        id: "accent-cd-pip",
        x: b.x - 22,
        y: b.y + 6,
        width: 10,
        height: 10,
        cornerRadius: 5,
        rotation: 0,
        opacity: 0.9,
        fill: params.color,
        tracks: [],
      };
      return { newLayers: [pip] };
    },
  },
  {
    id: "accent-spark-cross",
    name: "Spark Four-Point Cross",
    category: "graphic-accent",
    description: "Delicate sparkle four-point star accent.",
    tags: ["spark", "star", "shine", "accent"],
    targetKinds: ["text", "rect"],
    parameters: {
      color: { name: "Color", type: "color", description: "Color", default: "#FBBF24" },
    },
    apply: (ctx, params) => {
      const b = getLayerBounds(ctx);
      const s1: RectLayer = {
        kind: "rect",
        id: "accent-spark-h",
        x: b.x + b.width + 12,
        y: b.y + 4,
        width: 14,
        height: 2,
        rotation: 0,
        opacity: 0.85,
        fill: params.color,
        tracks: [],
      };
      const s2: RectLayer = {
        kind: "rect",
        id: "accent-spark-v",
        x: b.x + b.width + 18,
        y: b.y - 2,
        width: 2,
        height: 14,
        rotation: 0,
        opacity: 0.85,
        fill: params.color,
        tracks: [],
      };
      return { newLayers: [s1, s2] };
    },
  },
  {
    id: "accent-level-meter",
    name: "Tiered 3-Bar Level Meter",
    category: "graphic-accent",
    description: "Three rising stair-step energy bars.",
    tags: ["meter", "signal", "level", "accent"],
    targetKinds: ["text", "rect"],
    parameters: {
      color: { name: "Color", type: "color", description: "Color", default: "#10B981" },
    },
    apply: (ctx, params) => {
      const b = getLayerBounds(ctx);
      const bars: RectLayer[] = [];
      const baseY = b.y + b.height - 4;
      for (let i = 0; i < 3; i++) {
        const h = 6 + i * 5;
        bars.push({
          kind: "rect",
          id: `accent-lvl-${i}`,
          x: b.x - 22 + i * 6,
          y: baseY - h,
          width: 3,
          height: h,
          rotation: 0,
          opacity: 0.8,
          fill: params.color,
          tracks: [],
        });
      }
      return { newLayers: bars };
    },
  },
  {
    id: "accent-ribbon-flag",
    name: "Folded Ribbon Flag",
    category: "graphic-accent",
    description: "Vertical bookmark-style ribbon hanging from element roof.",
    tags: ["ribbon", "flag", "bookmark", "accent"],
    targetKinds: ["rect"],
    parameters: {
      color: { name: "Color", type: "color", description: "Color", default: "#8B5CF6" },
    },
    apply: (ctx, params) => {
      const b = getLayerBounds(ctx);
      const ribbon: RectLayer = {
        kind: "rect",
        id: "accent-ribbon-flag",
        x: b.x + b.width - 28,
        y: b.y - 6,
        width: 14,
        height: 28,
        rotation: 0,
        opacity: 0.95,
        fill: params.color,
        tracks: [],
      };
      return { newLayers: [ribbon] };
    },
  },
  {
    id: "accent-focus-crosshair",
    name: "Focus Header Crosshair",
    category: "graphic-accent",
    description: "Centering crosshair positioned immediately above the hero title.",
    tags: ["crosshair", "focus", "reticle", "tech"],
    targetKinds: ["text"],
    parameters: {
      color: { name: "Color", type: "color", description: "Color", default: "#0ADEE8" },
    },
    apply: (ctx, params) => {
      const b = getLayerBounds(ctx);
      const ch1: RectLayer = {
        kind: "rect",
        id: "accent-fch-h",
        x: b.x + Math.floor(b.width * 0.5) - 8,
        y: b.y - 16,
        width: 16,
        height: 2,
        rotation: 0,
        opacity: 0.8,
        fill: params.color,
        tracks: [],
      };
      const ch2: RectLayer = {
        kind: "rect",
        id: "accent-fch-v",
        x: b.x + Math.floor(b.width * 0.5) - 1,
        y: b.y - 23,
        width: 2,
        height: 16,
        rotation: 0,
        opacity: 0.8,
        fill: params.color,
        tracks: [],
      };
      return { newLayers: [ch1, ch2] };
    },
  },
];
