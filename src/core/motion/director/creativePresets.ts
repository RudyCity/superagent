import { createCanvas } from "@napi-rs/canvas";
import type { MotionProject, MotionTrack, RectLayer, TextLayer } from "../schema/types.js";
import type { MotionDirectorPlan, MotionDirectorScene } from "./directorService.js";
import { effectRegistry } from "../effects/index.js";
import { evaluateTrack } from "../timeline/evaluateFrame.js";

/** Intentional visual systems; no arbitrary user CSS, SVG, or executable effects. */
export const MOTION_ART_DIRECTIONS = ["minimal", "editorial", "neon", "brutalist"] as const;
export type MotionArtDirection = typeof MOTION_ART_DIRECTIONS[number];
export const MOTION_PRESETS = [
  "slide-left", "slide-up", "slide-right", "drop-in", "tilt", "swing", "fade", "pop-left", "pop-up",
] as const;
export type MotionPreset = typeof MOTION_PRESETS[number];
export type MotionTransition = "crossfade" | "cut";

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
function fade(start: number, end: number, total: number, transition: MotionTransition): MotionTrack {
  if (transition === "cut") {
    return { property: "opacity", keyframes: [
      ...(start > 0 ? [{ frame: start - 1, value: 0 }] : []),
      { frame: start, value: 1 }, { frame: end, value: 1 },
      ...(end < total - 1 ? [{ frame: end + 1, value: 0 }] : []),
    ] };
  }
  const duration = end - start + 1;
  const ease = "easeInOut" as const;
  const fadeInEnd = Math.min(end, start + Math.max(3, Math.min(9, Math.floor(duration / 4))));
  const fadeOutStart = Math.max(fadeInEnd + 1, end - Math.max(3, Math.min(9, Math.floor(duration / 4))));
  const unique = new Map([
    [start, { frame: start, value: 0, easing: ease }],
    [fadeInEnd, { frame: fadeInEnd, value: 1, easing: ease }],
    [fadeOutStart, { frame: fadeOutStart, value: 1, easing: ease }],
    [end, { frame: end, value: 0, easing: ease }],
  ]);
  return { property: "opacity", keyframes: [...unique.values()].sort((a, b) => a.frame - b.frame) };
}
function entry(preset: MotionPreset, start: number, end: number, x: number, y: number): MotionTrack[] {
  const arrival = Math.min(end, start + 13);
  if (preset === "slide-left" || preset === "pop-left" || preset === "slide-right") {
    const offset = preset === "slide-right" ? -110 : preset === "pop-left" ? 150 : 105;
    const easing = preset === "pop-left" ? "easeOutBack" : "easeInOut";
    return [{ property: "x", keyframes: [
      { frame: start, value: x + offset, easing }, { frame: arrival, value: x, easing: "easeInOut" },
    ] }];
  }
  if (preset === "slide-up" || preset === "pop-up" || preset === "drop-in") {
    const offset = preset === "drop-in" ? -115 : preset === "pop-up" ? 150 : 90;
    const easing = preset === "pop-up" ? "easeOutBack" : "easeInOut";
    return [{ property: "y", keyframes: [
      { frame: start, value: y + offset, easing }, { frame: arrival, value: y, easing: "easeInOut" },
    ] }];
  }
  if (preset === "tilt" || preset === "swing") {
    return [{ property: "rotation", keyframes: [
      { frame: start, value: preset === "swing" ? 16 : -11,
        easing: preset === "swing" ? "easeOutBack" : "easeInOut" },
      { frame: arrival, value: 0, easing: "easeInOut" },
    ] }];
  }
  return [];
}
function measure(text: string, size: number): number {
  ctx.font = size + "px Arial";
  return ctx.measureText(text).width;
}
function fitFont(text: string, maxWidth: number, base: number): number {
  let size = base;
  while (size > 30 && measure(text, size) > maxWidth) size -= 2;
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
  const portrait = height > width, square = height === width;
  const margin = portrait ? 90 : square ? 100 : 148;
  const maxWidth = width - 2 * margin;
  const base = style === "brutalist" ? 94 : style === "editorial" ? 86 : style === "neon" ? 82 : 76;
  const titleSize = fitFont(scene.headline, maxWidth - 12, portrait ? base - 6 : base);
  const subtitleSize = scene.subtitle ? fitFont(scene.subtitle, maxWidth - 20, portrait ? 37 : 39) : 39;
  const contentWidth = Math.min(maxWidth,
    Math.max(portrait ? 480 : 420, measure(scene.headline, titleSize) + 28,
      scene.subtitle ? measure(scene.subtitle, subtitleSize) + 28 : 0));
  const layout: Layout = scene.layout ?? (style === "editorial" && index % 2 ? "right" : "left");
  const x = layout === "left" ? margin :
    layout === "right" ? width - margin - contentWidth : Math.round((width - contentWidth) / 2);
  const baseY = portrait ? 1080 : square ? 540 : 444;
  const y = Math.round(baseY + (style === "editorial" && index % 2 ? (portrait ? 70 : 54) : 0));
  const subtitle = contrast(scene.accent, foreground === "#FFFFFF" ? "#000000" : "#FFFFFF") >= 3
    ? scene.accent : foreground;
  return { x: Math.round(x), y, width: Math.round(contentWidth), titleSize, subtitleSize,
    subtitle, layout, margin };
}
function addDecoration(
  layers: Composition["layers"], scene: MotionDirectorScene,
  style: MotionArtDirection, index: number, count: number, dimensions: { width: number; height: number },
  anchor: { x: number; y: number; margin: number; width: number }, visible: MotionTrack,
): void {
  const { width, height } = dimensions;
  const lineY = height - (height > width ? 110 : 70);
  const rect = (suffix: string, x: number, y: number, w: number, h: number, strength = 1): void => {
    const layer: RectLayer = { kind: "rect", id: "scene-" + index + "-" + suffix,
      x: Math.round(x), y: Math.round(y), width: Math.max(1, Math.round(w)), height: Math.max(1, Math.round(h)),
      rotation: 0, opacity: 1, fill: scene.accent, tracks: [opacityAt(visible, strength)] };
    layers.push(layer);
  };
  const label = (suffix: string, text: string, x: number, y: number, size: number): void => {
    const layer: TextLayer = { kind: "text", id: "scene-" + index + "-" + suffix, text,
      x: Math.round(x), y: Math.round(y), width: 210, height: size + 8, rotation: 0, opacity: 1,
      fill: scene.accent, fontSize: size, fontFamily: "Arial", tracks: [visible] };
    layers.push(layer);
  };
  if (style === "minimal") {
    rect("hairline", anchor.margin, lineY, width - 2 * anchor.margin, 3, .55);
    rect("progress", anchor.margin, lineY, (width - 2 * anchor.margin) * (index + 1) / count, 6);
    label("kicker", String(index + 1).padStart(2, "0") + " / " + String(count).padStart(2, "0"),
      anchor.margin, Math.round(height * .12), 27);
  } else if (style === "editorial") {
    rect("side-rule", width - anchor.margin / 2, height * .14, 8, height * .69, .75);
    rect("top-accent", anchor.margin, height * .13, Math.min(250, width * .22), 5);
    rect("shape", width * .66, height * .12, width * .20, height * .22, .11);
    label("kicker", "CHAPTER " + String(index + 1).padStart(2, "0"),
      anchor.margin, height * .15, 24);
  } else if (style === "neon") {
    rect("beam-top", anchor.margin, height * .17, width * .30, 5, .9);
    rect("beam-bottom", width * .56, lineY, width * .30, 5, .9);
    rect("beam-vertical", width - anchor.margin, height * .24, 6, height * .41, .7);
    rect("atmosphere", width * .76, height * .36, width * .12, height * .12, .12);
    label("kicker", "/// " + String(index + 1).padStart(2, "0"),
      anchor.margin, height * .115, 25);
  } else {
    rect("corner-block", width * .72, height * .05, width * .22, height * .26, .20);
    rect("title-underlay", anchor.x - 10, anchor.y - 32, Math.min(anchor.width + 20, 330), 18, .9);
    rect("edge-block", 0, lineY, width * .36, 25);
    label("kicker", "NO. " + String(index + 1).padStart(2, "0"), anchor.margin, height * .13, 31);
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
  plan.scenes.forEach((scene, index) => {
    const startBase = Math.floor(index * count / plan.scenes.length);
    const endBase = Math.floor((index + 1) * count / plan.scenes.length) - 1;
    const overlap = transition === "crossfade" && plan.scenes.length > 1 ? 6 : 0;
    const start = Math.max(0, startBase - (index ? overlap : 0));
    const end = Math.min(count - 1, endBase + (index < plan.scenes.length - 1 ? overlap : 0));
    const motion = scene.motion ?? plan.motion ?? "slide-left";
    const visible = fade(start, end, count, transition);
    const anchor = sceneLayout(scene, style, index, dimensions.width, dimensions.height, foreground);
    if (plan.artDirection) addDecoration(layers, scene, style, index, plan.scenes.length, dimensions, anchor, visible);
    layers.push({ id: "scene-" + index + "-accent", kind: "rect", x: anchor.x, y: anchor.y - 37,
      width: 164, height: 9, rotation: 0, opacity: 1, fill: scene.accent, tracks: [visible] });

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
        fontFamily: "Arial",
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
      rotation: 0, opacity: 1, fill: foreground, fontSize: anchor.titleSize, fontFamily: "Arial",
      tracks: [titleOpacity, ...titleTracks] });
    if (scene.subtitle) {
      layers.push({ id: "scene-" + index + "-subtitle", kind: "text", text: scene.subtitle,
        x: anchor.x + 4, y: anchor.y + (dimensions.height > dimensions.width ? 144 : 161),
        width: anchor.width - 8, height: anchor.subtitleSize + 22,
        rotation: 0, opacity: 1, fill: anchor.subtitle, fontSize: anchor.subtitleSize,
        fontFamily: "Arial", tracks: [visible, ...entry(motion, start, end, anchor.x + 4,
          anchor.y + (dimensions.height > dimensions.width ? 144 : 161))] });
    }
  });
  return { width: dimensions.width, height: dimensions.height, fps: { numerator: 30, denominator: 1 },
    durationFrames: count, background: plan.background, layers };
}
