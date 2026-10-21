import type { EffectDefinition } from "../types.js";
import { createTrack } from "../registry.js";
import type { RectLayer } from "../../schema/types.js";

export const backgroundEffects: EffectDefinition[] = [
  {
    id: "bg-ambient-pulse",
    name: "Ambient Backdrop Pulse",
    category: "background",
    description: "Soft breathing tinted backdrop panel undulating in opacity behind scene content.",
    tags: ["background", "ambient", "pulse", "glow"],
    targetKinds: ["scene"],
    parameters: {
      tintColor: { name: "Tint Color", type: "color", description: "Backdrop tint", default: "#1E293B" },
      minOpacity: { name: "Min Opacity", type: "number", description: "Low opacity", default: 0.35, min: 0.1, max: 0.9 },
      maxOpacity: { name: "Max Opacity", type: "number", description: "High opacity", default: 0.75, min: 0.2, max: 1 },
      cycleFrames: { name: "Cycle Length", type: "number", description: "Frames per pulse", default: 45, min: 15, max: 120 },
    },
    apply: (ctx, params) => {
      const panel: RectLayer = {
        kind: "rect",
        id: "bg-ambient-panel",
        x: 0,
        y: 0,
        width: ctx.compositionWidth,
        height: ctx.compositionHeight,
        rotation: 0,
        opacity: params.minOpacity,
        fill: params.tintColor,
        tracks: [],
      };
      const kfOp: { frame: number; value: number; easing?: "easeInOut" }[] = [];
      const period = Math.max(15, Math.floor(params.cycleFrames));
      for (let f = ctx.startFrame; f <= ctx.endFrame; f += period) {
        kfOp.push({ frame: f, value: params.minOpacity, easing: "easeInOut" });
        kfOp.push({ frame: Math.min(ctx.endFrame, f + Math.floor(period * 0.5)), value: params.maxOpacity, easing: "easeInOut" });
      }
      kfOp.push({ frame: ctx.endFrame, value: params.minOpacity, easing: "easeInOut" });
      panel.tracks = [createTrack("opacity", kfOp)];
      return { newLayers: [panel] };
    },
  },
  {
    id: "bg-cyber-scanlines",
    name: "Cyber Scanning Laser",
    category: "background",
    description: "Kinetic horizontal scanning beam traversing the viewport vertically.",
    tags: ["background", "scanline", "cyberpunk", "laser"],
    targetKinds: ["scene"],
    parameters: {
      beamColor: { name: "Laser Color", type: "color", description: "Color", default: "#36F4D3" },
      beamThickness: { name: "Thickness", type: "number", description: "Beam height in pixels", default: 4, min: 1, max: 20 },
      cycleFrames: { name: "Scan Period", type: "number", description: "Frames per sweep", default: 40, min: 10, max: 120 },
    },
    apply: (ctx, params) => {
      const beam: RectLayer = {
        kind: "rect",
        id: "bg-scanline-beam",
        x: 0,
        y: -10,
        width: ctx.compositionWidth,
        height: params.beamThickness,
        rotation: 0,
        opacity: 0.8,
        fill: params.beamColor,
        tracks: [],
      };
      const kfY: { frame: number; value: number; easing?: "linear" }[] = [];
      const period = Math.max(10, Math.floor(params.cycleFrames));
      for (let f = ctx.startFrame; f <= ctx.endFrame; f += period) {
        kfY.push({ frame: f, value: 0, easing: "linear" });
        kfY.push({ frame: Math.min(ctx.endFrame, f + period), value: ctx.compositionHeight, easing: "linear" });
      }
      beam.tracks = [createTrack("y", kfY)];
      return { newLayers: [beam] };
    },
  },
  {
    id: "bg-retro-horizon-grid",
    name: "Horizon Division Line",
    category: "background",
    description: "Subtle horizon line with an expanding neon accent pulse across the lower third.",
    tags: ["background", "horizon", "retro", "synthwave"],
    targetKinds: ["scene"],
    parameters: {
      lineColor: { name: "Horizon Color", type: "color", description: "Color", default: "#FFDF59" },
      elevationPercent: { name: "Height %", type: "number", description: "Position from top", default: 68, min: 20, max: 90 },
    },
    apply: (ctx, params) => {
      const y = Math.round((ctx.compositionHeight * params.elevationPercent) / 100);
      const line: RectLayer = {
        kind: "rect",
        id: "bg-horizon-line",
        x: 0,
        y,
        width: ctx.compositionWidth,
        height: 3,
        rotation: 0,
        opacity: 0.7,
        fill: params.lineColor,
        tracks: [
          createTrack("opacity", [
            { frame: ctx.startFrame, value: 0.3, easing: "easeInOut" },
            { frame: ctx.startFrame + Math.floor(ctx.durationFrames * 0.5), value: 0.9, easing: "easeInOut" },
            { frame: ctx.endFrame, value: 0.3, easing: "easeInOut" },
          ]),
        ],
      };
      return { newLayers: [line] };
    },
  },
  {
    id: "bg-geometric-frame-lines",
    name: "Architectural Viewport Framing",
    category: "background",
    description: "Refined outer margin framing lines enclosing the composition.",
    tags: ["background", "frame", "minimal", "editorial"],
    targetKinds: ["scene"],
    parameters: {
      frameColor: { name: "Frame Color", type: "color", description: "Color", default: "#4B5563" },
      margin: { name: "Margin", type: "number", description: "Inset pixels", default: 48, min: 16, max: 120 },
      thickness: { name: "Line Thickness", type: "number", description: "Pixels", default: 2, min: 1, max: 8 },
    },
    apply: (ctx, params) => {
      const m = params.margin;
      const t = params.thickness;
      const w = ctx.compositionWidth;
      const h = ctx.compositionHeight;
      const top: RectLayer = {
        kind: "rect",
        id: "bg-frame-top",
        x: m,
        y: m,
        width: w - 2 * m,
        height: t,
        rotation: 0,
        opacity: 0.6,
        fill: params.frameColor,
        tracks: [],
      };
      const bottom: RectLayer = {
        kind: "rect",
        id: "bg-frame-bottom",
        x: m,
        y: h - m - t,
        width: w - 2 * m,
        height: t,
        rotation: 0,
        opacity: 0.6,
        fill: params.frameColor,
        tracks: [],
      };
      const left: RectLayer = {
        kind: "rect",
        id: "bg-frame-left",
        x: m,
        y: m,
        width: t,
        height: h - 2 * m,
        rotation: 0,
        opacity: 0.6,
        fill: params.frameColor,
        tracks: [],
      };
      const right: RectLayer = {
        kind: "rect",
        id: "bg-frame-right",
        x: w - m - t,
        y: m,
        width: t,
        height: h - 2 * m,
        rotation: 0,
        opacity: 0.6,
        fill: params.frameColor,
        tracks: [],
      };
      return { newLayers: [top, bottom, left, right] };
    },
  },
  {
    id: "bg-split-dual-tone",
    name: "Dual-Tone Vertical Split",
    category: "background",
    description: "Bold two-tone architectural backdrop dividing screen into equal vertical zones.",
    tags: ["background", "split", "duotone", "brutalist"],
    targetKinds: ["scene"],
    parameters: {
      splitColor: { name: "Split Color", type: "color", description: "Second tone", default: "#1E293B" },
      splitPercent: { name: "Split Point %", type: "number", description: "Width percentage", default: 50, min: 20, max: 80 },
    },
    apply: (ctx, params) => {
      const splitW = Math.round((ctx.compositionWidth * params.splitPercent) / 100);
      const slab: RectLayer = {
        kind: "rect",
        id: "bg-duotone-slab",
        x: splitW,
        y: 0,
        width: ctx.compositionWidth - splitW,
        height: ctx.compositionHeight,
        rotation: 0,
        opacity: 1,
        fill: params.splitColor,
        tracks: [],
      };
      return { newLayers: [slab] };
    },
  },
  {
    id: "bg-split-horizontal",
    name: "Dual-Tone Horizontal Split",
    category: "background",
    description: "Architectural two-tone backdrop dividing screen into distinct upper and lower realms.",
    tags: ["background", "split", "duotone", "editorial"],
    targetKinds: ["scene"],
    parameters: {
      splitColor: { name: "Split Color", type: "color", description: "Second tone", default: "#1E293B" },
      splitPercent: { name: "Split Point %", type: "number", description: "Height percentage", default: 50, min: 20, max: 80 },
    },
    apply: (ctx, params) => {
      const splitH = Math.round((ctx.compositionHeight * params.splitPercent) / 100);
      const slab: RectLayer = {
        kind: "rect",
        id: "bg-duotone-horiz-slab",
        x: 0,
        y: splitH,
        width: ctx.compositionWidth,
        height: ctx.compositionHeight - splitH,
        rotation: 0,
        opacity: 1,
        fill: params.splitColor,
        tracks: [],
      };
      return { newLayers: [slab] };
    },
  },
  {
    id: "bg-brutalist-block-cluster",
    name: "Brutalist Geometric Accent Blocks",
    category: "background",
    description: "Solid asymmetric color blocks anchoring corners with bold presence.",
    tags: ["background", "brutalist", "blocks", "geometry"],
    targetKinds: ["scene"],
    parameters: {
      blockColor: { name: "Block Color", type: "color", description: "Color", default: "#FF6A8D" },
      opacity: { name: "Block Opacity", type: "number", description: "Opacity", default: 0.18, min: 0.05, max: 0.8 },
    },
    apply: (ctx, params) => {
      const w = ctx.compositionWidth;
      const h = ctx.compositionHeight;
      const block1: RectLayer = {
        kind: "rect",
        id: "bg-brutalist-top-r",
        x: Math.round(w * 0.72),
        y: Math.round(h * 0.06),
        width: Math.round(w * 0.22),
        height: Math.round(h * 0.26),
        rotation: 0,
        opacity: params.opacity,
        fill: params.blockColor,
        tracks: [],
      };
      const block2: RectLayer = {
        kind: "rect",
        id: "bg-brutalist-bot-l",
        x: Math.round(w * 0.05),
        y: Math.round(h * 0.75),
        width: Math.round(w * 0.32),
        height: Math.round(h * 0.18),
        rotation: 0,
        opacity: params.opacity,
        fill: params.blockColor,
        tracks: [],
      };
      return { newLayers: [block1, block2] };
    },
  },
  {
    id: "bg-neon-pillars",
    name: "Flanking Neon Light Pillars",
    category: "background",
    description: "Sleek vertical neon energy bars standing sentinel at left and right boundaries.",
    tags: ["background", "neon", "cyberpunk", "pillars"],
    targetKinds: ["scene"],
    parameters: {
      pillarColor: { name: "Pillar Color", type: "color", description: "Color", default: "#0ADEE8" },
      pillarWidth: { name: "Pillar Width", type: "number", description: "Width in pixels", default: 6, min: 2, max: 30 },
      margin: { name: "Inset Margin", type: "number", description: "Distance from border", default: 36, min: 10, max: 100 },
    },
    apply: (ctx, params) => {
      const h = ctx.compositionHeight;
      const left: RectLayer = {
        kind: "rect",
        id: "bg-neon-pillar-l",
        x: params.margin,
        y: Math.round(h * 0.2),
        width: params.pillarWidth,
        height: Math.round(h * 0.6),
        rotation: 0,
        opacity: 0.75,
        fill: params.pillarColor,
        tracks: [
          createTrack("opacity", [
            { frame: ctx.startFrame, value: 0.4, easing: "easeInOut" },
            { frame: ctx.startFrame + Math.floor(ctx.durationFrames * 0.5), value: 0.9, easing: "easeInOut" },
            { frame: ctx.endFrame, value: 0.4, easing: "easeInOut" },
          ]),
        ],
      };
      const right: RectLayer = {
        kind: "rect",
        id: "bg-neon-pillar-r",
        x: ctx.compositionWidth - params.margin - params.pillarWidth,
        y: Math.round(h * 0.2),
        width: params.pillarWidth,
        height: Math.round(h * 0.6),
        rotation: 0,
        opacity: 0.75,
        fill: params.pillarColor,
        tracks: [
          createTrack("opacity", [
            { frame: ctx.startFrame, value: 0.4, easing: "easeInOut" },
            { frame: ctx.startFrame + Math.floor(ctx.durationFrames * 0.5), value: 0.9, easing: "easeInOut" },
            { frame: ctx.endFrame, value: 0.4, easing: "easeInOut" },
          ]),
        ],
      };
      return { newLayers: [left, right] };
    },
  },
  {
    id: "bg-tech-crosshairs",
    name: "HUD Technical Crosshairs",
    category: "background",
    description: "Four precision registration marks positioned near composition margins.",
    tags: ["background", "hud", "technical", "target"],
    targetKinds: ["scene"],
    parameters: {
      color: { name: "Crosshair Color", type: "color", description: "Color", default: "#9CA3AF" },
      size: { name: "Crosshair Size", type: "number", description: "Length of arms", default: 20, min: 8, max: 60 },
      margin: { name: "Corner Margin", type: "number", description: "Pixels from corner", default: 48, min: 20, max: 120 },
    },
    apply: (ctx, params) => {
      const s = params.size;
      const m = params.margin;
      const w = ctx.compositionWidth;
      const h = ctx.compositionHeight;
      const corners = [
        { x: m, y: m },
        { x: w - m - s, y: m },
        { x: m, y: h - m - s },
        { x: w - m - s, y: h - m - s },
      ];
      const marks: RectLayer[] = [];
      corners.forEach((c, idx) => {
        marks.push({
          kind: "rect",
          id: `bg-cross-h-${idx}`,
          x: c.x,
          y: c.y + Math.floor(s / 2) - 1,
          width: s,
          height: 2,
          rotation: 0,
          opacity: 0.55,
          fill: params.color,
          tracks: [],
        });
        marks.push({
          kind: "rect",
          id: `bg-cross-v-${idx}`,
          x: c.x + Math.floor(s / 2) - 1,
          y: c.y,
          width: 2,
          height: s,
          rotation: 0,
          opacity: 0.55,
          fill: params.color,
          tracks: [],
        });
      });
      return { newLayers: marks };
    },
  },
  {
    id: "bg-radar-sweep-beam",
    name: "Radar Vertical Sweep Beam",
    category: "background",
    description: "Moving vertical scan beam sweeping across the horizontal field of view.",
    tags: ["background", "radar", "sweep", "tech"],
    targetKinds: ["scene"],
    parameters: {
      beamColor: { name: "Beam Color", type: "color", description: "Color", default: "#36F4D3" },
      beamWidth: { name: "Beam Width", type: "number", description: "Pixels", default: 4, min: 1, max: 20 },
      cycleFrames: { name: "Sweep Period", type: "number", description: "Frames per sweep", default: 45, min: 12, max: 120 },
    },
    apply: (ctx, params) => {
      const beam: RectLayer = {
        kind: "rect",
        id: "bg-radar-beam",
        x: -params.beamWidth,
        y: 0,
        width: params.beamWidth,
        height: ctx.compositionHeight,
        rotation: 0,
        opacity: 0.7,
        fill: params.beamColor,
        tracks: [],
      };
      const kfX: { frame: number; value: number; easing?: "linear" }[] = [];
      const period = Math.max(12, Math.floor(params.cycleFrames));
      for (let f = ctx.startFrame; f <= ctx.endFrame; f += period) {
        kfX.push({ frame: f, value: 0, easing: "linear" });
        kfX.push({ frame: Math.min(ctx.endFrame, f + period), value: ctx.compositionWidth, easing: "linear" });
      }
      beam.tracks = [createTrack("x", kfX)];
      return { newLayers: [beam] };
    },
  },
  {
    id: "bg-kinetic-stripes",
    name: "Kinetic Diagonal Stripes",
    category: "background",
    description: "Three parallel angled racing stripes providing dynamic directional flow.",
    tags: ["background", "stripes", "racing", "diagonal"],
    targetKinds: ["scene"],
    parameters: {
      stripeColor: { name: "Stripe Color", type: "color", description: "Color", default: "#3B82F6" },
      opacity: { name: "Opacity", type: "number", description: "Subtle opacity", default: 0.12, min: 0.04, max: 0.6 },
    },
    apply: (ctx, params) => {
      const stripes: RectLayer[] = [];
      const baseY = Math.round(ctx.compositionHeight * 0.35);
      for (let i = 0; i < 3; i++) {
        stripes.push({
          kind: "rect",
          id: `bg-diag-stripe-${i}`,
          x: Math.round(ctx.compositionWidth * 0.45) + i * 40,
          y: baseY + i * 25,
          width: Math.round(ctx.compositionWidth * 0.6),
          height: 12,
          rotation: -25,
          opacity: params.opacity,
          fill: params.stripeColor,
          tracks: [],
        });
      }
      return { newLayers: stripes };
    },
  },
  {
    id: "bg-minimalist-rule",
    name: "Editorial Baseline Rule",
    category: "background",
    description: "Restrained horizontal hairline rule anchoring typography and content.",
    tags: ["background", "rule", "hairline", "minimalist"],
    targetKinds: ["scene"],
    parameters: {
      ruleColor: { name: "Line Color", type: "color", description: "Color", default: "#6B7280" },
      yPercent: { name: "Vertical Position %", type: "number", description: "Height percent", default: 85, min: 30, max: 95 },
      opacity: { name: "Opacity", type: "number", description: "Opacity", default: 0.5, min: 0.1, max: 1 },
    },
    apply: (ctx, params) => {
      const y = Math.round((ctx.compositionHeight * params.yPercent) / 100);
      const rule: RectLayer = {
        kind: "rect",
        id: "bg-baseline-rule",
        x: Math.round(ctx.compositionWidth * 0.08),
        y,
        width: Math.round(ctx.compositionWidth * 0.84),
        height: 2,
        rotation: 0,
        opacity: params.opacity,
        fill: params.ruleColor,
        tracks: [],
      };
      return { newLayers: [rule] };
    },
  },
  {
    id: "bg-center-glow-disc",
    name: "Centered Backdrop Pill",
    category: "background",
    description: "Rounded generous backdrop pill grouping and contrasting the focal title.",
    tags: ["background", "pill", "card", "contrast"],
    targetKinds: ["scene"],
    parameters: {
      cardColor: { name: "Card Color", type: "color", description: "Color", default: "#1E293B" },
      cornerRadius: { name: "Corner Radius", type: "number", description: "Pixels", default: 24, min: 0, max: 80 },
      opacity: { name: "Card Opacity", type: "number", description: "Opacity", default: 0.85, min: 0.2, max: 1 },
    },
    apply: (ctx, params) => {
      const w = Math.round(ctx.compositionWidth * 0.7);
      const h = Math.round(ctx.compositionHeight * 0.45);
      const card: RectLayer = {
        kind: "rect",
        id: "bg-center-card-pill",
        x: Math.round((ctx.compositionWidth - w) / 2),
        y: Math.round((ctx.compositionHeight - h) / 2),
        width: w,
        height: h,
        cornerRadius: params.cornerRadius,
        rotation: 0,
        opacity: params.opacity,
        fill: params.cardColor,
        tracks: [],
      };
      return { newLayers: [card] };
    },
  },
  {
    id: "bg-vertical-lane-dividers",
    name: "Editorial Three-Column Dividers",
    category: "background",
    description: "Two vertical grid column rules establishing magazine layout structure.",
    tags: ["background", "columns", "editorial", "grid"],
    targetKinds: ["scene"],
    parameters: {
      lineColor: { name: "Line Color", type: "color", description: "Color", default: "#374151" },
      opacity: { name: "Opacity", type: "number", description: "Opacity", default: 0.45, min: 0.1, max: 1 },
    },
    apply: (ctx, params) => {
      const colW = Math.round(ctx.compositionWidth / 3);
      const line1: RectLayer = {
        kind: "rect",
        id: "bg-col-div-1",
        x: colW,
        y: 0,
        width: 1,
        height: ctx.compositionHeight,
        rotation: 0,
        opacity: params.opacity,
        fill: params.lineColor,
        tracks: [],
      };
      const line2: RectLayer = {
        kind: "rect",
        id: "bg-col-div-2",
        x: colW * 2,
        y: 0,
        width: 1,
        height: ctx.compositionHeight,
        rotation: 0,
        opacity: params.opacity,
        fill: params.lineColor,
        tracks: [],
      };
      return { newLayers: [line1, line2] };
    },
  },
  {
    id: "bg-corner-target-brackets",
    name: "Corner HUD Target Brackets",
    category: "background",
    description: "Four sci-fi L-shaped corner target framing brackets.",
    tags: ["background", "hud", "brackets", "cyberpunk"],
    targetKinds: ["scene"],
    parameters: {
      bracketColor: { name: "Bracket Color", type: "color", description: "Color", default: "#36F4D3" },
      armLength: { name: "Arm Length", type: "number", description: "Pixels", default: 28, min: 10, max: 80 },
      margin: { name: "Margin", type: "number", description: "Inset pixels", default: 36, min: 12, max: 100 },
    },
    apply: (ctx, params) => {
      const a = params.armLength;
      const m = params.margin;
      const w = ctx.compositionWidth;
      const h = ctx.compositionHeight;
      const brackets: RectLayer[] = [
        // Top Left
        { kind: "rect", id: "bg-tl-h", x: m, y: m, width: a, height: 3, rotation: 0, opacity: 0.8, fill: params.bracketColor, tracks: [] },
        { kind: "rect", id: "bg-tl-v", x: m, y: m, width: 3, height: a, rotation: 0, opacity: 0.8, fill: params.bracketColor, tracks: [] },
        // Top Right
        { kind: "rect", id: "bg-tr-h", x: w - m - a, y: m, width: a, height: 3, rotation: 0, opacity: 0.8, fill: params.bracketColor, tracks: [] },
        { kind: "rect", id: "bg-tr-v", x: w - m - 3, y: m, width: 3, height: a, rotation: 0, opacity: 0.8, fill: params.bracketColor, tracks: [] },
        // Bottom Left
        { kind: "rect", id: "bg-bl-h", x: m, y: h - m - 3, width: a, height: 3, rotation: 0, opacity: 0.8, fill: params.bracketColor, tracks: [] },
        { kind: "rect", id: "bg-bl-v", x: m, y: h - m - a, width: 3, height: a, rotation: 0, opacity: 0.8, fill: params.bracketColor, tracks: [] },
        // Bottom Right
        { kind: "rect", id: "bg-br-h", x: w - m - a, y: h - m - 3, width: a, height: 3, rotation: 0, opacity: 0.8, fill: params.bracketColor, tracks: [] },
        { kind: "rect", id: "bg-br-v", x: w - m - 3, y: h - m - a, width: 3, height: a, rotation: 0, opacity: 0.8, fill: params.bracketColor, tracks: [] },
      ];
      return { newLayers: brackets };
    },
  },
  {
    id: "bg-status-ticker-line",
    name: "Running Ticker Rule",
    category: "background",
    description: "Slender horizontal ticker rule gliding across the bottom edge.",
    tags: ["background", "ticker", "news", "broadcast"],
    targetKinds: ["scene"],
    parameters: {
      tickerColor: { name: "Ticker Color", type: "color", description: "Color", default: "#EF4444" },
    },
    apply: (ctx, params) => {
      const bar: RectLayer = {
        kind: "rect",
        id: "bg-ticker-bar",
        x: 0,
        y: ctx.compositionHeight - 12,
        width: 140,
        height: 4,
        rotation: 0,
        opacity: 0.85,
        fill: params.tickerColor,
        tracks: [
          createTrack("x", [
            { frame: ctx.startFrame, value: -140, easing: "linear" },
            { frame: ctx.endFrame, value: ctx.compositionWidth, easing: "linear" },
          ]),
        ],
      };
      return { newLayers: [bar] };
    },
  },
  {
    id: "bg-laser-beams-dual",
    name: "Dual Intersecting Laser Beams",
    category: "background",
    description: "Two thin perpendicular laser beams crossing the screen.",
    tags: ["laser", "beams", "cyberpunk", "background"],
    targetKinds: ["scene"],
    parameters: {
      beamColor: { name: "Beam Color", type: "color", description: "Color", default: "#0ADEE8" },
    },
    apply: (ctx, params) => {
      const hBeam: RectLayer = {
        kind: "rect",
        id: "bg-laser-h",
        x: 0,
        y: Math.round(ctx.compositionHeight * 0.4),
        width: ctx.compositionWidth,
        height: 2,
        rotation: 0,
        opacity: 0.7,
        fill: params.beamColor,
        tracks: [],
      };
      const vBeam: RectLayer = {
        kind: "rect",
        id: "bg-laser-v",
        x: Math.round(ctx.compositionWidth * 0.7),
        y: 0,
        width: 2,
        height: ctx.compositionHeight,
        rotation: 0,
        opacity: 0.7,
        fill: params.beamColor,
        tracks: [],
      };
      return { newLayers: [hBeam, vBeam] };
    },
  },
  {
    id: "bg-blueprint-grid-accent",
    name: "Blueprint Dimension Rules",
    category: "background",
    description: "Architectural dimension marks and coordinate ticks.",
    tags: ["blueprint", "technical", "ruler", "background"],
    targetKinds: ["scene"],
    parameters: {
      lineColor: { name: "Line Color", type: "color", description: "Color", default: "#4B5563" },
    },
    apply: (ctx, params) => {
      const rules: RectLayer[] = [];
      const baseY = Math.round(ctx.compositionHeight * 0.9);
      rules.push({
        kind: "rect",
        id: "bg-bp-main-rule",
        x: 40,
        y: baseY,
        width: ctx.compositionWidth - 80,
        height: 1,
        rotation: 0,
        opacity: 0.5,
        fill: params.lineColor,
        tracks: [],
      });
      for (let i = 0; i < 5; i++) {
        rules.push({
          kind: "rect",
          id: `bg-bp-tick-${i}`,
          x: 40 + i * Math.round((ctx.compositionWidth - 80) / 4),
          y: baseY - 6,
          width: 1,
          height: 12,
          rotation: 0,
          opacity: 0.6,
          fill: params.lineColor,
          tracks: [],
        });
      }
      return { newLayers: rules };
    },
  },
  {
    id: "bg-floating-particle-dots",
    name: "Drifting Particle Dots",
    category: "background",
    description: "Subtle floating atmospheric square particles drifting upward.",
    tags: ["particles", "drift", "ambient", "background"],
    targetKinds: ["scene"],
    parameters: {
      dotColor: { name: "Dot Color", type: "color", description: "Color", default: "#94A3B8" },
      opacity: { name: "Opacity", type: "number", description: "Dot opacity", default: 0.4, min: 0.1, max: 0.9 },
    },
    apply: (ctx, params) => {
      const dots: RectLayer[] = [];
      const positions = [
        { x: 0.15, y: 0.25, size: 4 },
        { x: 0.82, y: 0.35, size: 6 },
        { x: 0.35, y: 0.78, size: 5 },
        { x: 0.72, y: 0.82, size: 4 },
      ];
      positions.forEach((pos, idx) => {
        const startY = Math.round(ctx.compositionHeight * pos.y);
        dots.push({
          kind: "rect",
          id: `bg-pdot-${idx}`,
          x: Math.round(ctx.compositionWidth * pos.x),
          y: startY,
          width: pos.size,
          height: pos.size,
          rotation: 0,
          opacity: params.opacity,
          fill: params.dotColor,
          tracks: [
            createTrack("y", [
              { frame: ctx.startFrame, value: startY, easing: "linear" },
              { frame: ctx.endFrame, value: startY - 30, easing: "linear" },
            ]),
          ],
        });
      });
      return { newLayers: dots };
    },
  },
  {
    id: "bg-vignette-pillars",
    name: "Vignette Framing Pillars",
    category: "background",
    description: "Deep dark framing pillars on left and right borders focusing eye to center.",
    tags: ["vignette", "pillars", "framing", "background"],
    targetKinds: ["scene"],
    parameters: {
      color: { name: "Color", type: "color", description: "Color", default: "#000000" },
      widthPercent: { name: "Pillar %", type: "number", description: "Width percentage", default: 8, min: 2, max: 20 },
    },
    apply: (ctx, params) => {
      const pw = Math.round((ctx.compositionWidth * params.widthPercent) / 100);
      const left: RectLayer = {
        kind: "rect",
        id: "bg-vig-l",
        x: 0,
        y: 0,
        width: pw,
        height: ctx.compositionHeight,
        rotation: 0,
        opacity: 0.4,
        fill: params.color,
        tracks: [],
      };
      const right: RectLayer = {
        kind: "rect",
        id: "bg-vig-r",
        x: ctx.compositionWidth - pw,
        y: 0,
        width: pw,
        height: ctx.compositionHeight,
        rotation: 0,
        opacity: 0.4,
        fill: params.color,
        tracks: [],
      };
      return { newLayers: [left, right] };
    },
  },
  {
    id: "bg-corner-accent-dots",
    name: "Corner Technical Dots",
    category: "background",
    description: "Four circular precision dots in the outer quadrants.",
    tags: ["dots", "technical", "minimal", "background"],
    targetKinds: ["scene"],
    parameters: {
      dotColor: { name: "Color", type: "color", description: "Color", default: "#9CA3AF" },
      margin: { name: "Margin", type: "number", description: "Pixels", default: 40, min: 10, max: 120 },
    },
    apply: (ctx, params) => {
      const m = params.margin;
      const w = ctx.compositionWidth;
      const h = ctx.compositionHeight;
      const dots: RectLayer[] = [
        { kind: "rect", id: "bg-dot-tl", x: m, y: m, width: 6, height: 6, cornerRadius: 3, rotation: 0, opacity: 0.6, fill: params.dotColor, tracks: [] },
        { kind: "rect", id: "bg-dot-tr", x: w - m - 6, y: m, width: 6, height: 6, cornerRadius: 3, rotation: 0, opacity: 0.6, fill: params.dotColor, tracks: [] },
        { kind: "rect", id: "bg-dot-bl", x: m, y: h - m - 6, width: 6, height: 6, cornerRadius: 3, rotation: 0, opacity: 0.6, fill: params.dotColor, tracks: [] },
        { kind: "rect", id: "bg-dot-br", x: w - m - 6, y: h - m - 6, width: 6, height: 6, cornerRadius: 3, rotation: 0, opacity: 0.6, fill: params.dotColor, tracks: [] },
      ];
      return { newLayers: dots };
    },
  },
  {
    id: "bg-subtle-checker-accents",
    name: "Brutalist Checker Accents",
    category: "background",
    description: "Alternating block checkerboard accent band in corner.",
    tags: ["checker", "brutalist", "pattern", "background"],
    targetKinds: ["scene"],
    parameters: {
      color: { name: "Color", type: "color", description: "Color", default: "#F59E0B" },
    },
    apply: (ctx, params) => {
      const blocks: RectLayer[] = [];
      const size = 16;
      for (let r = 0; r < 2; r++) {
        for (let c = 0; c < 4; c++) {
          if ((r + c) % 2 === 0) {
            blocks.push({
              kind: "rect",
              id: `bg-chk-${r}-${c}`,
              x: 40 + c * size,
              y: 40 + r * size,
              width: size,
              height: size,
              rotation: 0,
              opacity: 0.7,
              fill: params.color,
              tracks: [],
            });
          }
        }
      }
      return { newLayers: blocks };
    },
  },
  {
    id: "bg-kinetic-wave-bar",
    name: "Kinetic Wave Bar",
    category: "background",
    description: "Broad undulating horizontal accent bar slowly sweeping in vertical position.",
    tags: ["wave", "bar", "undulate", "background"],
    targetKinds: ["scene"],
    parameters: {
      barColor: { name: "Color", type: "color", description: "Color", default: "#3B82F6" },
      height: { name: "Bar Height", type: "number", description: "Pixels", default: 60, min: 10, max: 200 },
    },
    apply: (ctx, params) => {
      const baseY = Math.round(ctx.compositionHeight * 0.5);
      const bar: RectLayer = {
        kind: "rect",
        id: "bg-wave-bar",
        x: 0,
        y: baseY,
        width: ctx.compositionWidth,
        height: params.height,
        rotation: 0,
        opacity: 0.12,
        fill: params.barColor,
        tracks: [
          createTrack("y", [
            { frame: ctx.startFrame, value: baseY - 20, easing: "easeInOut" },
            { frame: ctx.startFrame + Math.floor(ctx.durationFrames * 0.5), value: baseY + 20, easing: "easeInOut" },
            { frame: ctx.endFrame, value: baseY - 20, easing: "easeInOut" },
          ]),
        ],
      };
      return { newLayers: [bar] };
    },
  },
  {
    id: "bg-audio-wave-bars-sim",
    name: "Simulated Graphic Equalizer Bars",
    category: "background",
    description: "Four vertical graphic equalizer bars bouncing rhythmically in the background.",
    tags: ["equalizer", "audio", "music", "bars"],
    targetKinds: ["scene"],
    parameters: {
      barColor: { name: "Color", type: "color", description: "Color", default: "#10B981" },
    },
    apply: (ctx, params) => {
      const bars: RectLayer[] = [];
      const baseY = Math.round(ctx.compositionHeight * 0.85);
      for (let i = 0; i < 4; i++) {
        const h = 25 + i * 15;
        bars.push({
          kind: "rect",
          id: `bg-eq-bar-${i}`,
          x: ctx.compositionWidth - 140 + i * 18,
          y: baseY - h,
          width: 8,
          height: h,
          rotation: 0,
          opacity: 0.45,
          fill: params.barColor,
          tracks: [
            createTrack("y", [
              { frame: ctx.startFrame, value: baseY - h, easing: "easeInOut" },
              { frame: ctx.startFrame + 10 + i * 2, value: baseY - h - 20, easing: "easeInOut" },
              { frame: ctx.startFrame + 20 + i * 2, value: baseY - h, easing: "easeInOut" },
            ]),
          ],
        });
      }
      return { newLayers: bars };
    },
  },
  {
    id: "bg-offset-slab-backdrop",
    name: "Offset Editorial Slab",
    category: "background",
    description: "Asymmetric solid slab underlay creating depth beneath the primary content area.",
    tags: ["slab", "editorial", "asymmetric", "background"],
    targetKinds: ["scene"],
    parameters: {
      slabColor: { name: "Color", type: "color", description: "Color", default: "#1E293B" },
      cornerRadius: { name: "Radius", type: "number", description: "Pixels", default: 12, min: 0, max: 40 },
    },
    apply: (ctx, params) => {
      const slab: RectLayer = {
        kind: "rect",
        id: "bg-offset-slab",
        x: Math.round(ctx.compositionWidth * 0.1),
        y: Math.round(ctx.compositionHeight * 0.2),
        width: Math.round(ctx.compositionWidth * 0.55),
        height: Math.round(ctx.compositionHeight * 0.55),
        cornerRadius: params.cornerRadius,
        rotation: 0,
        opacity: 0.6,
        fill: params.slabColor,
        tracks: [],
      };
      return { newLayers: [slab] };
    },
  },
  {
    id: "bg-gradient-bar-stack",
    name: "Tiered Gradient Bar Stack",
    category: "background",
    description: "Three stacked bars with stepped opacity creating a simulated gradient horizon.",
    tags: ["gradient", "stack", "bars", "background"],
    targetKinds: ["scene"],
    parameters: {
      color: { name: "Color", type: "color", description: "Color", default: "#6366F1" },
    },
    apply: (ctx, params) => {
      const bars: RectLayer[] = [];
      const baseY = Math.round(ctx.compositionHeight * 0.7);
      const opacities = [0.1, 0.2, 0.35];
      for (let i = 0; i < 3; i++) {
        bars.push({
          kind: "rect",
          id: `bg-grad-bar-${i}`,
          x: 0,
          y: baseY + i * 24,
          width: ctx.compositionWidth,
          height: 24,
          rotation: 0,
          opacity: opacities[i],
          fill: params.color,
          tracks: [],
        });
      }
      return { newLayers: bars };
    },
  },
  {
    id: "bg-diagonal-hazard-stripes",
    name: "Industrial Hazard Stripes",
    category: "background",
    description: "High-contrast angled industrial caution stripes across lower band.",
    tags: ["hazard", "industrial", "stripes", "caution"],
    targetKinds: ["scene"],
    parameters: {
      color: { name: "Stripe Color", type: "color", description: "Color", default: "#FACC15" },
    },
    apply: (ctx, params) => {
      const stripes: RectLayer[] = [];
      const baseY = ctx.compositionHeight - 20;
      for (let i = 0; i < 6; i++) {
        stripes.push({
          kind: "rect",
          id: `bg-hazard-${i}`,
          x: 50 + i * 35,
          y: baseY,
          width: 14,
          height: 14,
          rotation: 45,
          opacity: 0.85,
          fill: params.color,
          tracks: [],
        });
      }
      return { newLayers: stripes };
    },
  },
  {
    id: "bg-focus-ring-bracket",
    name: "Central Focus Ring",
    category: "background",
    description: "Subtle large circular backdrop ring highlighting the focal hero zone.",
    tags: ["focus", "ring", "circle", "background"],
    targetKinds: ["scene"],
    parameters: {
      ringColor: { name: "Color", type: "color", description: "Color", default: "#38BDF8" },
      diameter: { name: "Diameter", type: "number", description: "Pixels", default: 420, min: 100, max: 900 },
    },
    apply: (ctx, params) => {
      const d = params.diameter;
      const ring: RectLayer = {
        kind: "rect",
        id: "bg-focus-ring",
        x: Math.round((ctx.compositionWidth - d) / 2),
        y: Math.round((ctx.compositionHeight - d) / 2),
        width: d,
        height: d,
        cornerRadius: Math.round(d / 2),
        rotation: 0,
        opacity: 0.08,
        fill: params.ringColor,
        tracks: [],
      };
      return { newLayers: [ring] };
    },
  },
  {
    id: "bg-ambient-corner-glow",
    name: "Ambient Corner Glow Patch",
    category: "background",
    description: "A soft rounded ambient glow patch radiating from the top-right corner.",
    tags: ["glow", "ambient", "corner", "background"],
    targetKinds: ["scene"],
    parameters: {
      glowColor: { name: "Color", type: "color", description: "Color", default: "#A855F7" },
      size: { name: "Size", type: "number", description: "Pixels", default: 350, min: 100, max: 800 },
    },
    apply: (ctx, params) => {
      const s = params.size;
      const patch: RectLayer = {
        kind: "rect",
        id: "bg-corner-glow",
        x: ctx.compositionWidth - Math.round(s * 0.7),
        y: -Math.round(s * 0.3),
        width: s,
        height: s,
        cornerRadius: Math.round(s / 2),
        rotation: 0,
        opacity: 0.14,
        fill: params.glowColor,
        tracks: [],
      };
      return { newLayers: [patch] };
    },
  },
  {
    id: "bg-horizontal-strata",
    name: "Horizontal Strata Layers",
    category: "background",
    description: "Three calm horizontal strata bands dividing background depth.",
    tags: ["strata", "calm", "editorial", "background"],
    targetKinds: ["scene"],
    parameters: {
      bandColor: { name: "Band Color", type: "color", description: "Color", default: "#1F2937" },
    },
    apply: (ctx, params) => {
      const strata: RectLayer[] = [];
      const h3 = Math.round(ctx.compositionHeight / 3);
      for (let i = 0; i < 3; i++) {
        if (i % 2 === 1) {
          strata.push({
            kind: "rect",
            id: `bg-strata-${i}`,
            x: 0,
            y: i * h3,
            width: ctx.compositionWidth,
            height: h3,
            rotation: 0,
            opacity: 0.35,
            fill: params.bandColor,
            tracks: [],
          });
        }
      }
      return { newLayers: strata };
    },
  },
  {
    id: "bg-matrix-dots-array",
    name: "Matrix Dot Grid Array",
    category: "background",
    description: "A 3x3 array of alignment micro-dots in the upper quadrant.",
    tags: ["matrix", "dots", "grid", "technical"],
    targetKinds: ["scene"],
    parameters: {
      color: { name: "Color", type: "color", description: "Color", default: "#6B7280" },
    },
    apply: (ctx, params) => {
      const dots: RectLayer[] = [];
      const startX = 60;
      const startY = 60;
      const spacing = 18;
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) {
          dots.push({
            kind: "rect",
            id: `bg-mdot-${r}-${c}`,
            x: startX + c * spacing,
            y: startY + r * spacing,
            width: 3,
            height: 3,
            rotation: 0,
            opacity: 0.45,
            fill: params.color,
            tracks: [],
          });
        }
      }
      return { newLayers: dots };
    },
  },
  {
    id: "bg-kinetic-cross-array",
    name: "Medical Plus Crosshairs",
    category: "background",
    description: "Subtle Swiss design technical plus symbols on margins.",
    tags: ["cross", "swiss", "technical", "background"],
    targetKinds: ["scene"],
    parameters: {
      color: { name: "Color", type: "color", description: "Color", default: "#9CA3AF" },
    },
    apply: (ctx, params) => {
      const crosses: RectLayer[] = [];
      const s = 12;
      const x = ctx.compositionWidth - 70;
      const y = 80;
      crosses.push({
        kind: "rect",
        id: "bg-cross-h",
        x: x - Math.floor(s / 2),
        y,
        width: s,
        height: 2,
        rotation: 0,
        opacity: 0.5,
        fill: params.color,
        tracks: [],
      });
      crosses.push({
        kind: "rect",
        id: "bg-cross-v",
        x,
        y: y - Math.floor(s / 2),
        width: 2,
        height: s,
        rotation: 0,
        opacity: 0.5,
        fill: params.color,
        tracks: [],
      });
      return { newLayers: crosses };
    },
  },
];
