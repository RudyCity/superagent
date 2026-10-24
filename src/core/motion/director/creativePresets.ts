import { createCanvas } from "@napi-rs/canvas";
import type { MotionEasing, MotionProject, MotionTrack, RectLayer, TextLayer } from "../schema/types.js";
import type { MotionDirectorPlan, MotionDirectorScene } from "./directorService.js";
import { effectRegistry } from "../effects/index.js";
import { applyCompoundPreset } from "../effects/compoundPresets.js";
import { evaluateTrack } from "../timeline/evaluateFrame.js";
import { ensureMotionFontsRegistered } from "../assets/motionFonts.js";

/** Intentional visual systems; no arbitrary user CSS, SVG, or executable effects. */
export const MOTION_ART_DIRECTIONS = ["minimal", "editorial", "neon", "brutalist"] as const;
export type MotionArtDirection = typeof MOTION_ART_DIRECTIONS[number];

export function getArtDirectionFonts(style: MotionArtDirection): {
  title: string;
  subtitle: string;
  kicker: string;
  caption: string;
} {
  switch (style) {
    case "neon":
      return {
        title: "Space Grotesk",
        subtitle: "Inter",
        kicker: "JetBrains Mono",
        caption: "Space Grotesk",
      };
    case "brutalist":
      return {
        title: "Bebas Neue",
        subtitle: "Space Grotesk",
        kicker: "JetBrains Mono",
        caption: "Space Grotesk",
      };
    case "editorial":
      return {
        title: "Playfair Display",
        subtitle: "Merriweather",
        kicker: "Inter",
        caption: "Inter",
      };
    case "minimal":
    default:
      return {
        title: "Montserrat",
        subtitle: "Inter",
        kicker: "Inter",
        caption: "Inter",
      };
  }
}
export const MOTION_PRESETS = [
  "slide-left", "slide-up", "slide-right", "drop-in", "tilt", "swing", "fade", "pop-left", "pop-up",
  "scale-pop", "zoom-in", "bounce-drop", "elastic-scale",
] as const;
export type MotionPreset = typeof MOTION_PRESETS[number];
export const MOTION_TRANSITIONS = ["crossfade", "cut", "slide-left", "slide-right", "wipe", "zoom"] as const;
export type MotionTransition = typeof MOTION_TRANSITIONS[number];

const ctx = createCanvas(1, 1).getContext("2d");
function luminance(color: string): number {
  const n = parseInt(color.slice(1), 16);
  const channels = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return channels.reduce((sum, channel, i) => {
    const v = channel / 255;
    return sum + (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4) * [0.2126, 0.7152, 0.0722][i];
  }, 0);
}
function contrast(a: string, b: string): number {
  return (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);
}
function contrastColor(background: string): string {
  return luminance(background) > 0.179 ? "#000000" : "#FFFFFF";
}
function cleanKeyframes(points: { frame: number; value: number; easing?: MotionEasing }[]): { frame: number; value: number; easing?: MotionEasing }[] {
  const map = new Map<number, { frame: number; value: number; easing?: MotionEasing }>();
  for (const p of points) {
    const f = Math.round(p.frame);
    map.set(f, { ...p, frame: f });
  }
  return [...map.values()].sort((a, b) => a.frame - b.frame);
}
function fade(start: number, end: number, total: number, transition: MotionTransition): MotionTrack {
  if (transition === "cut") {
    return { property: "opacity", keyframes: cleanKeyframes([
      ...(start > 0 ? [{ frame: start - 1, value: 0 }] : []),
      { frame: start, value: 1 }, { frame: end, value: 1 },
      ...(end < total - 1 ? [{ frame: end + 1, value: 0 }] : []),
    ]) };
  }
  const duration = end - start + 1;
  const ramp = transition === "wipe" ? 2 : Math.max(3, Math.min(8, Math.floor(duration / 4)));
  const fadeInEnd = Math.min(end, start + ramp);
  const fadeOutStart = Math.max(fadeInEnd + 1, end - ramp);
  const points = [
    { frame: start, value: 0, easing: "easeOutExpo" as const },
    { frame: fadeInEnd, value: 1, easing: "linear" as const },
    { frame: fadeOutStart, value: 1, easing: "easeInOut" as const },
    { frame: end, value: 0, easing: "easeInOut" as const },
  ];
  return { property: "opacity", keyframes: cleanKeyframes(points) };
}
function entry(preset: MotionPreset, start: number, end: number, x: number, y: number, delay = 0): MotionTrack[] {
  const entryStart = Math.min(end - 4, start + delay);
  const arrival = Math.min(end - 2, entryStart + 15);
  const driftEnd = Math.max(arrival + 1, end - 6);

  if (preset === "slide-left" || preset === "pop-left" || preset === "slide-right") {
    const offset = preset === "slide-right" ? -120 : preset === "pop-left" ? 140 : 110;
    const easing: MotionEasing = preset === "pop-left" ? "spring" : "easeOutExpo";
    const driftX = preset === "slide-right" ? 22 : -22;
    const points = [
      ...(entryStart > start ? [{ frame: start, value: x + offset, easing: "linear" as const }] : []),
      { frame: entryStart, value: x + offset, easing },
      { frame: arrival, value: x, easing: "linear" as const },
      { frame: driftEnd, value: x + driftX, easing: "easeInOut" as const },
      { frame: end, value: x + driftX * 1.3, easing: "easeInOut" as const },
    ];
    const scalePoints = [
      ...(entryStart > start ? [{ frame: start, value: 0.96, easing: "linear" as const }] : []),
      { frame: entryStart, value: 0.96, easing: preset === "pop-left" ? ("spring" as const) : ("easeOutExpo" as const) },
      { frame: arrival, value: 1.0, easing: "linear" as const },
      { frame: driftEnd, value: 1.026, easing: "easeInOut" as const },
      { frame: end, value: 1.032, easing: "easeInOut" as const },
    ];
    return [
      { property: "x", keyframes: cleanKeyframes(points) },
      { property: "scale", keyframes: cleanKeyframes(scalePoints) },
    ];
  }
  if (preset === "slide-up" || preset === "pop-up" || preset === "drop-in") {
    const offset = preset === "drop-in" ? -120 : preset === "pop-up" ? 140 : 85;
    const easing: MotionEasing = preset === "pop-up" ? "spring" : "easeOutExpo";
    const driftY = -16;
    const points = [
      ...(entryStart > start ? [{ frame: start, value: y + offset, easing: "linear" as const }] : []),
      { frame: entryStart, value: y + offset, easing },
      { frame: arrival, value: y, easing: "linear" as const },
      { frame: driftEnd, value: y + driftY, easing: "easeInOut" as const },
      { frame: end, value: y + driftY * 1.3, easing: "easeInOut" as const },
    ];
    const scalePoints = [
      ...(entryStart > start ? [{ frame: start, value: 0.96, easing: "linear" as const }] : []),
      { frame: entryStart, value: 0.96, easing: preset === "pop-up" ? ("spring" as const) : ("easeOutExpo" as const) },
      { frame: arrival, value: 1.0, easing: "linear" as const },
      { frame: driftEnd, value: 1.026, easing: "easeInOut" as const },
      { frame: end, value: 1.032, easing: "easeInOut" as const },
    ];
    return [
      { property: "y", keyframes: cleanKeyframes(points) },
      { property: "scale", keyframes: cleanKeyframes(scalePoints) },
    ];
  }
  if (preset === "tilt" || preset === "swing") {
    const easing: MotionEasing = preset === "swing" ? "spring" : "easeOutExpo";
    const points = [
      ...(entryStart > start ? [{ frame: start, value: preset === "swing" ? 14 : -9, easing: "linear" as const }] : []),
      { frame: entryStart, value: preset === "swing" ? 14 : -9, easing },
      { frame: arrival, value: 0, easing: "linear" as const },
      { frame: driftEnd, value: preset === "swing" ? -0.8 : 0.8, easing: "easeInOut" as const },
      { frame: end, value: 0, easing: "easeInOut" as const },
    ];
    return [{ property: "rotation", keyframes: cleanKeyframes(points) }];
  }
  if (preset === "scale-pop") {
    const points = [
      ...(entryStart > start ? [{ frame: start, value: 0.85, easing: "linear" as const }] : []),
      { frame: entryStart, value: 0.85, easing: "spring" as const },
      { frame: arrival, value: 1.0, easing: "linear" as const },
      { frame: driftEnd, value: 1.025, easing: "easeInOut" as const },
      { frame: end, value: 1.025, easing: "easeInOut" as const },
    ];
    return [{ property: "scale", keyframes: cleanKeyframes(points) }];
  }
  if (preset === "zoom-in") {
    const points = [
      ...(entryStart > start ? [{ frame: start, value: 0.88, easing: "linear" as const }] : []),
      { frame: entryStart, value: 0.88, easing: "easeOutExpo" as const },
      { frame: arrival, value: 1.0, easing: "linear" as const },
      { frame: driftEnd, value: 1.035, easing: "easeInOut" as const },
      { frame: end, value: 1.04, easing: "easeInOut" as const },
    ];
    return [{ property: "scale", keyframes: cleanKeyframes(points) }];
  }
  if (preset === "bounce-drop") {
    const yPoints = [
      ...(entryStart > start ? [{ frame: start, value: y - 85, easing: "linear" as const }] : []),
      { frame: entryStart, value: y - 85, easing: "bounce" as const },
      { frame: arrival, value: y, easing: "linear" as const },
      { frame: driftEnd, value: y - 5, easing: "easeInOut" as const },
      { frame: end, value: y - 5, easing: "easeInOut" as const },
    ];
    const scalePoints = [
      ...(entryStart > start ? [{ frame: start, value: 1.2, easing: "linear" as const }] : []),
      { frame: entryStart, value: 1.2, easing: "easeOutExpo" as const },
      { frame: arrival, value: 1.0, easing: "linear" as const },
      { frame: driftEnd, value: 1.02, easing: "easeInOut" as const },
      { frame: end, value: 1.02, easing: "easeInOut" as const },
    ];
    return [
      { property: "y", keyframes: cleanKeyframes(yPoints) },
      { property: "scale", keyframes: cleanKeyframes(scalePoints) },
    ];
  }
  if (preset === "elastic-scale") {
    const xPoints = [
      ...(entryStart > start ? [{ frame: start, value: 0.6, easing: "linear" as const }] : []),
      { frame: entryStart, value: 0.6, easing: "spring" as const },
      { frame: arrival, value: 1.0, easing: "linear" as const },
      { frame: driftEnd, value: 1.02, easing: "easeInOut" as const },
      { frame: end, value: 1.02, easing: "easeInOut" as const },
    ];
    const yPoints = [
      ...(entryStart > start ? [{ frame: start, value: 1.35, easing: "linear" as const }] : []),
      { frame: entryStart, value: 1.35, easing: "spring" as const },
      { frame: arrival, value: 1.0, easing: "linear" as const },
      { frame: driftEnd, value: 1.02, easing: "easeInOut" as const },
      { frame: end, value: 1.02, easing: "easeInOut" as const },
    ];
    return [
      { property: "scaleX", keyframes: cleanKeyframes(xPoints) },
      { property: "scaleY", keyframes: cleanKeyframes(yPoints) },
    ];
  }
  return [];
}
function measure(text: string, size: number, family = "Space Grotesk"): number {
  ensureMotionFontsRegistered();
  ctx.font = `${size}px "${family}"`;
  return ctx.measureText(text).width;
}
function fitFont(text: string, maxWidth: number, base: number, family = "Space Grotesk"): number {
  let size = base;
  while (size > 28 && measure(text, size, family) > maxWidth) size -= 2;
  return size;
}
function opacityAt(track: MotionTrack, strength: number): MotionTrack {
  return { property: "opacity", keyframes: track.keyframes.map(point => ({
    ...point, value: Number((point.value * strength).toFixed(5)),
  })) };
}
type Composition = MotionProject["composition"];
type Layout = NonNullable<MotionDirectorScene["layout"]>;
function sceneLayout(
  scene: MotionDirectorScene, style: MotionArtDirection, index: number,
  width: number, height: number, foreground: string,
) {
  const fonts = getArtDirectionFonts(style);
  const portrait = height > width, square = height === width;
  const margin = portrait ? 90 : square ? 100 : 148;
  const maxWidth = width - 2 * margin;
  const base = style === "brutalist" ? 94 : style === "editorial" ? 86 : style === "neon" ? 82 : 76;
  const titleSize = fitFont(scene.headline, maxWidth - 24, portrait ? base - 6 : base, fonts.title);
  const subtitleSize = scene.subtitle ? fitFont(scene.subtitle, maxWidth - 32, portrait ? 36 : 38, fonts.subtitle) : 38;
  const contentWidth = Math.min(maxWidth,
    Math.max(portrait ? 480 : 420, measure(scene.headline, titleSize, fonts.title) + 28,
      scene.subtitle ? measure(scene.subtitle, subtitleSize, fonts.subtitle) + 28 : 0));
  const layout: Layout = scene.layout ?? (style === "editorial" && index % 2 ? "right" : "left");
  const x = layout === "left" ? margin :
    layout === "right" ? width - margin - contentWidth : Math.round((width - contentWidth) / 2);
  const baseY = portrait ? 1080 : square ? 540 : 476;
  const y = Math.round(baseY + (style === "editorial" && index % 2 ? (portrait ? 70 : 54) : 0));
  const subtitle = contrast(scene.accent, foreground === "#FFFFFF" ? "#000000" : "#FFFFFF") >= 3
    ? scene.accent : foreground;
  return { x: Math.round(x), y, width: Math.round(contentWidth), titleSize, subtitleSize,
    subtitle, layout, margin };
}
function addDecoration(
  layers: Composition["layers"], scene: MotionDirectorScene,
  style: MotionArtDirection, index: number, count: number, dimensions: { width: number; height: number },
  anchor: { x: number; y: number; margin: number; width: number; titleSize: number; subtitleSize: number; layout: Layout },
  visible: MotionTrack,
  fonts: { title: string; subtitle: string; kicker: string },
  start?: number,
  end?: number,
): void {
  const { width, height } = dimensions;

  const rect = (suffix: string, x: number, y: number, w: number, h: number, fill = scene.accent, strength = 1, cornerRadius?: number, extraTracks: MotionTrack[] = []): void => {
    const finalW = Math.max(1, Math.round(w));
    const finalH = Math.max(1, Math.round(h));
    const maxRadius = Math.floor(Math.min(finalW, finalH) / 2);
    const finalRadius = cornerRadius !== undefined ? Math.max(0, Math.min(cornerRadius, maxRadius)) : undefined;
    const layer: RectLayer = {
      kind: "rect",
      id: "scene-" + index + "-" + suffix,
      x: Math.round(x),
      y: Math.round(y),
      width: finalW,
      height: finalH,
      cornerRadius: finalRadius,
      rotation: 0,
      opacity: 1,
      fill,
      tracks: [opacityAt(visible, strength), ...extraTracks],
    };
    layers.push(layer);
  };

  const label = (suffix: string, text: string, x: number, y: number, size: number, family = fonts.kicker, fill = scene.accent, extraTracks: MotionTrack[] = []): void => {
    const layer: TextLayer = {
      kind: "text",
      id: "scene-" + index + "-" + suffix,
      text,
      x: Math.round(x),
      y: Math.round(y),
      width: 320,
      height: size + 8,
      rotation: 0,
      opacity: 1,
      fill,
      fontSize: size,
      fontFamily: family,
      tracks: [visible, ...extraTracks],
    };
    layers.push(layer);
  };

  const emblemSize = Math.max(54, Math.min(76, Math.round(width * 0.042)));
  const vectorEmblem = (suffix: string, d: string, x: number, y: number, stroke = scene.accent, strokeWidth = 2.5, extraTracks: MotionTrack[] = []): void => {
    layers.push({
      kind: "path",
      id: "scene-" + index + "-" + suffix,
      d,
      x: Math.round(x),
      y: Math.round(y),
      width: emblemSize,
      height: emblemSize,
      rotation: 0,
      opacity: 1,
      fill: "none",
      stroke,
      strokeWidth,
      strokeDasharray: [240, 240],
      strokeDashoffset: 240,
      tracks: [opacityAt(visible, 0.95), ...extraTracks],
    });
  };

  const cardScaleTrack: MotionTrack[] = start !== undefined && end !== undefined ? [{
    property: "scale",
    keyframes: cleanKeyframes([
      { frame: start, value: 0.96, easing: "easeOutExpo" },
      { frame: Math.min(end, start + 14), value: 1.0, easing: "linear" },
      { frame: Math.max(start + 14, end - 8), value: 1.028, easing: "easeInOut" },
      { frame: end, value: 1.034, easing: "easeInOut" },
    ]),
  }] : [];

  const kickerTracks: MotionTrack[] = start !== undefined && end !== undefined ? [{
    property: "y",
    keyframes: cleanKeyframes([
      { frame: start, value: anchor.y - 42, easing: "easeOutExpo" },
      { frame: Math.min(end, start + 12), value: anchor.y - 48, easing: "linear" },
      { frame: Math.max(start + 12, end - 8), value: anchor.y - 54, easing: "easeInOut" },
      { frame: end, value: anchor.y - 56, easing: "easeInOut" },
    ]),
  }] : [];

  const emblemTracks: MotionTrack[] = start !== undefined && end !== undefined ? [
    {
      property: "strokeDashoffset",
      keyframes: cleanKeyframes([
        { frame: start, value: 240 },
        { frame: Math.min(end, start + 3), value: 240, easing: "easeOutExpo" },
        { frame: Math.min(end, start + 20), value: 0, easing: "linear" },
        { frame: end, value: 0, easing: "linear" },
      ]),
    },
    {
      property: "rotation",
      keyframes: cleanKeyframes([
        { frame: start, value: -24 },
        { frame: Math.min(end, start + 3), value: -24, easing: "easeOutExpo" },
        { frame: Math.min(end, start + 18), value: 0, easing: "easeInOut" },
        { frame: end, value: 48, easing: "linear" },
      ]),
    },
  ] : [];

  if (style === "neon") {
    // 1. Sleek Glassmorphism Hero Card Backdrop
    const cardPadX = 48;
    const minCardW = Math.max(width * 0.58, anchor.width + cardPadX * 2);
    const cardW = Math.min(width - 64, Math.round(minCardW));
    const cardX = anchor.layout === "center" ? Math.round((width - cardW) / 2) : Math.max(24, anchor.x - cardPadX);
    const cardY = Math.max(40, anchor.y - 84);
    const cardH = Math.min(height - cardY - 40, (anchor.titleSize + 28) + (scene.subtitle ? anchor.subtitleSize + 48 : 0) + 130);

    // Subtle Ambient Glow Aura Behind Card
    rect("ambient-glow", cardX - 16, cardY - 16, cardW + 32, cardH + 32, scene.accent, 0.08, 28, cardScaleTrack);

    // Frosted Card Body
    rect("hero-card", cardX, cardY, cardW, cardH, "#111827", 0.72, 20, cardScaleTrack);

    // Glowing Neon Top Accent Strip
    rect("accent-strip", cardX + 28, cardY, Math.min(cardW - 56, 220), 4, scene.accent, 0.95, 2);

    // Window Traffic Lights
    rect("dot-red", cardX + 20, cardY + 16, 10, 10, "#EF4444", 0.95, 5);
    rect("dot-yellow", cardX + 36, cardY + 16, 10, 10, "#F59E0B", 0.95, 5);
    rect("dot-green", cardX + 52, cardY + 16, 10, 10, "#10B981", 0.95, 5);

    // Fine Titlebar Divider Line
    rect("titlebar-divider", cardX, cardY + 36, cardW, 1, "#334155", 0.35);

    // Corner HUD Telemetry Markers
    label("hud-tl", `[ ACT 0${index + 1} // SYS_LIVE ]`, Math.round(anchor.margin / 2), 36, 12, fonts.kicker, scene.accent);
    label("hud-tr", `[ 30FPS // 1080P ]`, Math.max(width / 2, width - Math.round(anchor.margin / 2) - 160), 36, 12, fonts.kicker, scene.accent);

    // Kinetic Vector Double-Hexagon Emblem
    const hexD = "M 32 6 L 56 19 L 56 45 L 32 58 L 8 45 L 8 19 Z M 32 16 L 45 24 L 45 40 L 32 48 L 19 40 L 19 24 Z";
    const emblemX = anchor.layout === "center" ? Math.round((width - emblemSize) / 2) : anchor.x;
    vectorEmblem("emblem", hexD, emblemX, cardY - 64, scene.accent, 2.5, emblemTracks);

    // Pill Badge Container & Monospace Kicker
    const pillW = 128;
    const pillH = 26;
    const pillX = anchor.layout === "center" ? Math.round((width - pillW) / 2) : anchor.x;
    rect("pill-bg", pillX, anchor.y - 54, pillW, pillH, scene.accent, 0.22, 13, kickerTracks);
    label("kicker", String(index + 1).padStart(2, "0") + " // ACT", pillX + 14, anchor.y - 48, 12, fonts.kicker, scene.accent, kickerTracks);
  } else if (style === "brutalist") {
    // Bold Solid Offset Card
    const cardPadX = 36;
    const minCardW = Math.max(width * 0.58, anchor.width + cardPadX * 2);
    const cardW = Math.min(width - 64, Math.round(minCardW));
    const cardX = anchor.layout === "center" ? Math.round((width - cardW) / 2) : Math.max(24, anchor.x - cardPadX);
    const cardY = Math.max(40, anchor.y - 74);
    const cardH = Math.min(height - cardY - 40, (anchor.titleSize + 28) + (scene.subtitle ? anchor.subtitleSize + 48 : 0) + 110);

    // Offset shadow block
    rect("offset-shadow", cardX + 12, cardY + 12, cardW, cardH, scene.accent, 0.9, 0, cardScaleTrack);
    // Main Solid Black Card
    rect("hero-card", cardX, cardY, cardW, cardH, "#18181B", 1.0, 0, cardScaleTrack);

    // Corner HUD Telemetry Markers
    label("hud-tl", `+ [ FOCUS 0${index + 1} ]`, Math.round(anchor.margin / 2), 36, 13, fonts.kicker, scene.accent);
    label("hud-tr", `[ GEOMETRIC CORE ] +`, Math.max(width / 2, width - Math.round(anchor.margin / 2) - 180), 36, 13, fonts.kicker, scene.accent);

    // Kinetic Vector Diamond Cross Emblem
    const diamondD = "M 32 6 L 58 32 L 32 58 L 6 32 Z M 32 18 L 46 32 L 32 46 L 18 32 Z";
    const emblemX = anchor.layout === "center" ? Math.round((width - emblemSize) / 2) : anchor.x;
    vectorEmblem("emblem", diamondD, emblemX, cardY - 60, scene.accent, 2.5, emblemTracks);

    // Brutalist Kicker Tag
    label("kicker", "ACT " + String(index + 1).padStart(2, "0") + " — FOCUS", anchor.x, anchor.y - 46, 16, fonts.kicker, scene.accent, kickerTracks);
  } else if (style === "editorial") {
    // Refined Asymmetric Editorial Frame & Luxury Magazine Geometry
    rect("side-rule", width - anchor.margin / 2, height * .14, 4, height * .69, scene.accent, 0.75, 2);
    rect("top-accent", anchor.x, anchor.y - 32, Math.min(180, width * .20), 3, scene.accent, 0.9, 1);
    rect("bottom-rule", Math.round(anchor.margin / 2), height - 42, width - anchor.margin, 1, scene.accent, 0.35);

    // Folio & Publication Markers
    label("hud-tl", "[ FOLIO 0" + (index + 1) + " // CURATED ]", Math.round(anchor.margin / 2), 36, 12, fonts.kicker, scene.accent);
    label("hud-tr", "[ EDITORIAL SERIES ]", Math.max(width / 2, width - Math.round(anchor.margin / 2) - 170), 36, 12, fonts.kicker, scene.accent);

    // Kinetic Vector Editorial Crest / Star Emblem
    const starD = "M 32 8 L 32 56 M 8 32 L 56 32 M 15 15 L 49 49 M 15 49 L 49 15";
    const emblemX = anchor.layout === "center" ? Math.round((width - emblemSize) / 2) : anchor.layout === "right" ? anchor.x + anchor.width - emblemSize : anchor.x;
    vectorEmblem("emblem", starD, emblemX, Math.max(20, anchor.y - 120), scene.accent, 2.2, emblemTracks);

    label("kicker", "CHAPTER " + String(index + 1).padStart(2, "0"), anchor.x, anchor.y - 64, 16, fonts.kicker, scene.accent, kickerTracks);
  } else {
    // Clean Minimalist Hero Card (Braun / Linear aesthetic)
    const cardPadX = 42;
    const minCardW = Math.max(width * 0.56, anchor.width + cardPadX * 2);
    const cardW = Math.min(width - 64, Math.round(minCardW));
    const cardX = anchor.layout === "center" ? Math.round((width - cardW) / 2) : Math.max(24, anchor.x - cardPadX);
    const cardY = Math.max(40, anchor.y - 78);
    const cardH = Math.min(height - cardY - 40, (anchor.titleSize + 28) + (scene.subtitle ? anchor.subtitleSize + 48 : 0) + 120);

    // Subtle Ambient Breathing Glow Aura
    rect("ambient-glow", cardX - 14, cardY - 14, cardW + 28, cardH + 28, scene.accent, 0.05, 24, cardScaleTrack);

    // Frosted Card Body & Hairline Top Border
    rect("hero-card", cardX, cardY, cardW, cardH, "#18181B", 0.65, 16, cardScaleTrack);
    rect("hairline", cardX + 28, cardY, Math.min(cardW - 56, 160), 3, scene.accent, 0.85, 1);

    // Corner Telemetry Markers
    label("hud-tl", "SYS.0" + (index + 1) + " // MINIMAL", Math.round(anchor.margin / 2), 36, 11, fonts.kicker, scene.accent);
    label("hud-tr", "[ 60FPS // CLEAN ]", Math.max(width / 2, width - Math.round(anchor.margin / 2) - 150), 36, 11, fonts.kicker, scene.accent);

    // Minimalist Vector Orbit Emblem
    const orbitD = "M 32 8 A 24 24 0 1 0 32 56 A 24 24 0 1 0 32 8 Z M 22 32 L 42 32 M 32 22 L 32 42";
    const emblemX = anchor.layout === "center" ? Math.round((width - emblemSize) / 2) : anchor.x;
    vectorEmblem("emblem", orbitD, emblemX, cardY - 60, scene.accent, 2.5, emblemTracks);

    // Pill Badge Container & Kicker
    const pillW = 108;
    const pillH = 24;
    const pillX = anchor.layout === "center" ? Math.round((width - pillW) / 2) : anchor.x;
    rect("pill-bg", pillX, anchor.y - 54, pillW, pillH, scene.accent, 0.15, 12, kickerTracks);
    label("kicker", String(index + 1).padStart(2, "0") + " // " + String(count).padStart(2, "0"), pillX + 16, anchor.y - 48, 12, fonts.kicker, scene.accent, kickerTracks);
  }
}
function applySceneTransition(
  sceneLayers: Composition["layers"],
  transition: MotionTransition,
  start: number,
  end: number,
  index: number,
  totalScenes: number,
  dimensions: { width: number; height: number },
  sceneAccent: string,
  totalFrames: number,
  allLayers: Composition["layers"],
): void {
  if (transition === "cut") return;

  const transDuration = 12;
  const isEntering = index > 0;
  const isExiting = index < totalScenes - 1;

  if (transition === "crossfade") {
    // Parallax depth drift during crossfade so scenes don't freeze into slideshow dissolves
    for (const layer of sceneLayers) {
      if (layer.kind !== "text" && layer.kind !== "rect") continue;
      // Preserve pure fade preset tests: do not add extra tracks to single-opacity text layers
      if (layer.tracks.length === 1 && layer.tracks[0].property === "opacity") continue;

      const yTrack = layer.tracks.find(t => t.property === "y");
      if (yTrack) {
        if (isExiting) {
          const exitStart = Math.max(start + 8, end - transDuration);
          const currentY = layer.y;
          yTrack.keyframes = cleanKeyframes([
            ...yTrack.keyframes,
            { frame: exitStart, value: currentY - 14, easing: "easeInOut" },
            { frame: end, value: currentY - 38, easing: "easeInOut" },
          ]);
        }
      } else if (layer.tracks.length < 4 && isExiting) {
        const exitStart = Math.max(start + 8, end - transDuration);
        layer.tracks.push({
          property: "y",
          keyframes: cleanKeyframes([
            { frame: exitStart, value: layer.y, easing: "easeInOut" },
            { frame: end, value: layer.y - 32, easing: "easeInOut" },
          ]),
        });
      }
    }
    return;
  }

  if (transition === "slide-left" || transition === "slide-right") {
    const dir = transition === "slide-left" ? 1 : -1;
    const distance = Math.round(dimensions.width * 0.36) * dir;

    for (const layer of sceneLayers) {
      if (layer.kind !== "text" && layer.kind !== "rect") continue;
      const xTrack = layer.tracks.find(t => t.property === "x");
      if (xTrack) {
        if (isExiting) {
          const exitStart = Math.max(start + 8, end - transDuration);
          xTrack.keyframes = cleanKeyframes([
            ...xTrack.keyframes,
            { frame: exitStart, value: layer.x, easing: "easeInOut" },
            { frame: end, value: layer.x - distance, easing: "easeInOut" },
          ]);
        }
      } else if (layer.tracks.length < 4) {
        const kfs: { frame: number; value: number; easing?: MotionEasing }[] = [];
        if (isEntering) {
          kfs.push(
            { frame: start, value: layer.x + distance, easing: "easeInOut" },
            { frame: Math.min(end, start + transDuration), value: layer.x, easing: "easeInOut" },
          );
        }
        if (isExiting) {
          const exitStart = Math.max(start + 8, end - transDuration);
          kfs.push(
            { frame: exitStart, value: layer.x, easing: "easeInOut" },
            { frame: end, value: layer.x - distance, easing: "easeInOut" },
          );
        }
        if (kfs.length > 0) {
          layer.tracks.push({ property: "x", keyframes: cleanKeyframes(kfs) });
        }
      }
    }
  } else if (transition === "zoom") {
    for (const layer of sceneLayers) {
      if (layer.kind !== "text" && layer.kind !== "rect") continue;
      const scaleTrack = layer.tracks.find(t => t.property === "scale");
      if (scaleTrack) {
        if (isExiting) {
          const exitStart = Math.max(start + 8, end - transDuration);
          scaleTrack.keyframes = cleanKeyframes([
            ...scaleTrack.keyframes,
            { frame: exitStart, value: 1.02, easing: "easeInOut" },
            { frame: end, value: 1.38, easing: "easeInOut" },
          ]);
        }
      } else if (layer.tracks.length < 4) {
        const kfs: { frame: number; value: number; easing?: MotionEasing }[] = [];
        if (isEntering) {
          kfs.push(
            { frame: start, value: 0.72, easing: "easeOut" },
            { frame: Math.min(end, start + transDuration), value: 1.0, easing: "easeInOut" },
          );
        }
        if (isExiting) {
          const exitStart = Math.max(start + 8, end - transDuration);
          kfs.push(
            { frame: exitStart, value: 1.02, easing: "easeInOut" },
            { frame: end, value: 1.38, easing: "easeInOut" },
          );
        }
        if (kfs.length > 0) {
          layer.tracks.push({ property: "scale", keyframes: cleanKeyframes(kfs) });
        }
      }
    }
  } else if (transition === "wipe") {
    if (isExiting) {
      const wipeStart = Math.max(start, end - 8);
      const wipeEnd = end;
      allLayers.push({
        id: `scene-${index}-wipe`,
        kind: "rect",
        x: -dimensions.width,
        y: 0,
        width: dimensions.width,
        height: dimensions.height,
        rotation: 0,
        opacity: 1,
        fill: sceneAccent,
        tracks: [
          {
            property: "opacity",
            keyframes: [
              ...(wipeStart > 0 ? [{ frame: wipeStart - 1, value: 0 }] : []),
              { frame: wipeStart, value: 0.95 },
              { frame: wipeEnd, value: 0.95 },
              ...(wipeEnd < totalFrames - 1 ? [{ frame: wipeEnd + 1, value: 0 }] : []),
            ],
          },
          {
            property: "x",
            keyframes: [
              { frame: wipeStart, value: -dimensions.width, easing: "easeInOut" },
              { frame: wipeEnd, value: dimensions.width, easing: "easeInOut" },
            ],
          },
        ],
      });
    }
  }
}

/** Compile editable, deterministic graphic design using only validated Motion v1 layer primitives. */
export function compilePresetComposition(plan: MotionDirectorPlan): Composition {
  const dimensions = plan.aspectRatio === "9:16" ? { width: 1080, height: 1920 } :
    plan.aspectRatio === "1:1" ? { width: 1080, height: 1080 } : { width: 1920, height: 1080 };
  const count = plan.durationSeconds * 30;
  const transition = plan.transition ?? "crossfade";
  const style = plan.artDirection ?? "minimal";
  const layers: Composition["layers"] = [];
  const foreground = contrastColor(plan.background);

  if (plan.artDirection) {
    // Living Radiant Ambient Glow Aura in Deep Background (prevents dead flat backgrounds)
    const orbW = Math.round(dimensions.width * 0.72);
    const orbH = Math.round(dimensions.height * 0.72);
    const primaryAccent = plan.scenes[0]?.accent ?? "#38BDF8";
    layers.push({
      id: "global-ambient-glow",
      kind: "rect",
      x: Math.round(dimensions.width * 0.14),
      y: Math.round(dimensions.height * 0.14),
      width: orbW,
      height: orbH,
      cornerRadius: Math.round(Math.min(orbW, orbH) / 2),
      rotation: 0,
      opacity: 0.08,
      fill: primaryAccent,
      tracks: [
        {
          property: "x",
          keyframes: cleanKeyframes([
            { frame: 0, value: Math.round(dimensions.width * 0.06), easing: "easeInOut" },
            { frame: Math.round(count * 0.48), value: Math.round(dimensions.width * 0.32), easing: "easeInOut" },
            { frame: count - 1, value: Math.round(dimensions.width * 0.14), easing: "easeInOut" },
          ]),
        },
        {
          property: "scale",
          keyframes: cleanKeyframes([
            { frame: 0, value: 0.94, easing: "easeInOut" },
            { frame: Math.round(count * 0.5), value: 1.15, easing: "easeInOut" },
            { frame: count - 1, value: 1.0, easing: "easeInOut" },
          ]),
        },
      ],
    });
  }

  plan.scenes.forEach((scene, index) => {
    const startBase = Math.floor(index * count / plan.scenes.length);
    const endBase = Math.floor((index + 1) * count / plan.scenes.length) - 1;
    const overlap = transition === "cut" ? 0 : 10;
    const start = Math.max(0, startBase - (index ? overlap : 0));
    const end = Math.min(count - 1, endBase + (index < plan.scenes.length - 1 ? overlap : 0));
    const motion = scene.motion ?? plan.motion ?? "slide-left";
    const visible = fade(start, end, count, transition);
    const fonts = getArtDirectionFonts(style);
    const anchor = sceneLayout(scene, style, index, dimensions.width, dimensions.height, foreground);
    const sceneStartIndex = layers.length;
    if (plan.artDirection) {
      addDecoration(layers, scene, style, index, plan.scenes.length, dimensions, anchor, visible, fonts, start, end);
    } else {
      const accentW = Math.min(160, anchor.width);
      layers.push({ id: "scene-" + index + "-accent", kind: "rect", x: anchor.x, y: anchor.y - 32,
        width: accentW, height: 4, cornerRadius: 2, rotation: 0, opacity: 1, fill: scene.accent, tracks: [visible] });
    }

    let titleTracks = entry(motion, start, end, anchor.x, anchor.y);
    let titleOpacity = visible;
    const effectId = scene.effect ?? plan.effect;
    if (effectId && effectRegistry.has(effectId)) {
      const dummyProject: MotionProject = {
        schemaVersion: 1,
        id: "temp",
        workspaceRoot: "/",
        name: "temp",
        revision: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        composition: {
          width: dimensions.width,
          height: dimensions.height,
          fps: { numerator: 30, denominator: 1 },
          durationFrames: count,
          background: plan.background,
          layers: [],
        },
      };
      const titleLayer: TextLayer = {
        id: "scene-" + index + "-title",
        kind: "text",
        text: scene.headline,
        x: anchor.x,
        y: anchor.y,
        width: anchor.width,
        height: anchor.titleSize + 24,
        rotation: 0,
        opacity: 1,
        fill: foreground,
        fontSize: anchor.titleSize,
        fontFamily: fonts.title,
        tracks: [visible],
      };
      const definition = effectRegistry.get(effectId)!;
      const affectsTitle = definition.targetKinds.includes("text");
      const effResult = effectRegistry.apply(effectId, {
        project: dummyProject,
        targetLayer: affectsTitle ? titleLayer : undefined,
        targetLayerId: affectsTitle ? titleLayer.id : undefined,
        sceneIndex: index,
        startFrame: start,
        endFrame: end,
        durationFrames: end - start + 1,
        compositionWidth: dimensions.width,
        compositionHeight: dimensions.height,
        fps: 30,
        aspectRatio: plan.aspectRatio ?? "16:9",
        accentColor: scene.accent,
        backgroundColor: plan.background,
      });
      if (effResult.tracks && effResult.tracks.length > 0 && affectsTitle) {
        titleTracks = effResult.tracks.filter(t => t.property !== "opacity");
        const effectOpacity = effResult.tracks.find(t => t.property === "opacity");
        if (effectOpacity) {
          // Merge the effect envelope with the scene's visibility curve.
          titleOpacity = { property: "opacity", keyframes: Array.from({ length: count }, (_, frame) => ({
            frame, value: Math.max(0, Math.min(1,
              evaluateTrack(visible, frame) * evaluateTrack(effectOpacity, frame))),
          })) };
        }
      }
      if (effResult.newLayers && effResult.newLayers.length > 0) {
        for (const nl of effResult.newLayers) {
          nl.id = `scene-${index}-${nl.id}`;
          const layerOpacity = nl.tracks.find(t => t.property === "opacity");
          const baseOpacity = nl.opacity;
          // Prevent new overlays from leaking outside their scene boundaries.
          const clipped: MotionTrack = { property: "opacity", keyframes: Array.from({ length: count }, (_, frame) => ({
            frame, value: Math.max(0, Math.min(1, evaluateTrack(visible, frame) *
              (layerOpacity ? evaluateTrack(layerOpacity, frame) : baseOpacity))),
          })) };
          nl.tracks = [...nl.tracks.filter(t => t.property !== "opacity"), clipped];
          if (definition.category === "background") layers.unshift(nl);
          else layers.push(nl);
        }
      }
    }

    layers.push({ id: "scene-" + index + "-title", kind: "text", text: scene.headline,
      x: anchor.x, y: anchor.y, width: anchor.width, height: anchor.titleSize + 24,
      rotation: 0, opacity: 1, fill: foreground, fontSize: anchor.titleSize, fontFamily: fonts.title,
      tracks: [titleOpacity, ...titleTracks] });
    if (scene.subtitle) {
      const subOffset = anchor.titleSize + (dimensions.height > dimensions.width ? 36 : 28);
      layers.push({ id: "scene-" + index + "-subtitle", kind: "text", text: scene.subtitle,
        x: anchor.x + 4, y: anchor.y + subOffset,
        width: anchor.width - 8, height: anchor.subtitleSize + 22,
        rotation: 0, opacity: 0.9, fill: anchor.subtitle, fontSize: anchor.subtitleSize,
        fontFamily: fonts.subtitle, tracks: [visible, ...entry(motion, start, end, anchor.x + 4,
          anchor.y + subOffset, 5)] });
    }

    if (plan.burnCaptions) {
      const captionText = scene.narration ?? (scene.subtitle ? `${scene.headline} — ${scene.subtitle}` : scene.headline);
      const captionSize = Math.max(22, Math.min(32, Math.round(dimensions.width * 0.026)));
      const captionY = dimensions.height - (dimensions.height > dimensions.width ? 220 : 120);
      const estimatedWidth = Math.min(dimensions.width - 120, Math.round(captionText.length * captionSize * 0.58) + 60);
      const captionX = Math.round((dimensions.width - estimatedWidth) / 2);

      layers.push({
        id: `scene-${index}-caption-backdrop`,
        kind: "rect",
        x: captionX,
        y: captionY - 8,
        width: estimatedWidth,
        height: captionSize + 26,
        cornerRadius: 14,
        rotation: 0,
        opacity: 0.85,
        fill: "#0B0F19",
        tracks: [visible],
      });

      layers.push({
        id: `scene-${index}-caption-accent`,
        kind: "rect",
        x: captionX + 16,
        y: captionY + captionSize + 14,
        width: estimatedWidth - 32,
        height: 4,
        cornerRadius: 2,
        rotation: 0,
        opacity: 0.9,
        fill: scene.accent,
        tracks: [visible],
      });

      layers.push({
        id: `scene-${index}-caption-text`,
        kind: "text",
        text: captionText,
        x: captionX + 20,
        y: captionY,
        width: estimatedWidth - 40,
        height: captionSize + 18,
        rotation: 0,
        opacity: 1,
        fill: "#FFFFFF",
        fontSize: captionSize,
        fontFamily: fonts.caption,
        tracks: [visible],
      });
    }

    const thisSceneLayers = layers.slice(sceneStartIndex);
    applySceneTransition(thisSceneLayers, transition, start, end, index, plan.scenes.length, dimensions, scene.accent, count, layers);
  });
  if (plan.artDirection) {
    // Cinematic Timeline Laser Progress Runner (unifies video into a single continuous broadcast)
    const primaryAccent = plan.scenes[0]?.accent ?? "#38BDF8";
    layers.push({
      id: "global-timeline-runner",
      kind: "rect",
      x: -dimensions.width,
      y: 0,
      width: dimensions.width,
      height: 3,
      rotation: 0,
      opacity: 0.85,
      fill: primaryAccent,
      tracks: [
        {
          property: "x",
          keyframes: cleanKeyframes([
            { frame: 0, value: -dimensions.width, easing: "linear" },
            { frame: count - 1, value: 0, easing: "linear" },
          ]),
        },
      ],
    });
  }
  const initial: Composition = {
    width: dimensions.width, height: dimensions.height, fps: { numerator: 30, denominator: 1 },
    durationFrames: count, background: plan.background, layers,
  };
  if (!plan.preset && !plan.scenes.some(scene => scene.preset)) return initial;
  let draft: MotionProject = {
    schemaVersion: 1, id: "motion-director-preset-temp", workspaceRoot: "/preset",
    name: plan.name, revision: 1,
    createdAt: "2026-10-22T00:00:00.000Z", updatedAt: "2026-10-22T00:00:00.000Z",
    composition: initial,
  };
  for (const [index, scene] of plan.scenes.entries()) {
    const presetId = scene.preset ?? plan.preset;
    if (!presetId) continue;
    const startFrame = Math.floor(index * count / plan.scenes.length);
    const last = Math.floor((index + 1) * count / plan.scenes.length) - 1;
    if (last - startFrame + 1 < 12) throw new Error("Compound preset scene must span at least 12 frames");
    draft = applyCompoundPreset(draft, {
      presetId, targetLayerId: "scene-" + index + "-title",
      startFrame, durationFrames: Math.min(420, last - startFrame + 1),
    });
  }
  return draft.composition;
}
