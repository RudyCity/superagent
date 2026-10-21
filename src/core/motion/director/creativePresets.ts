import { createCanvas } from "@napi-rs/canvas";
import type { MotionProject, MotionTrack } from "../schema/types.js";
import type { MotionDirectorPlan, MotionDirectorScene } from "./directorService.js";

export const MOTION_PRESETS = ["slide-left", "slide-up", "tilt", "fade"] as const;
export type MotionPreset = typeof MOTION_PRESETS[number];
export type MotionTransition = "crossfade" | "cut";

const ctx = createCanvas(1, 1).getContext("2d");
function contrastColor(background: string): string {
  const n = parseInt(background.slice(1), 16);
  const channels = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(c => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  const lum = channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  return lum > 0.179 ? "#000000" : "#FFFFFF";
}
function fade(start: number, end: number, total: number, transition: MotionTransition): MotionTrack {
  if (transition === "cut") {
    const frames = [
      ...(start > 0 ? [{ frame: start - 1, value: 0 }] : []),
      { frame: start, value: 1 }, { frame: end, value: 1 },
      ...(end < total - 1 ? [{ frame: end + 1, value: 0 }] : []),
    ];
    return { property: "opacity", keyframes: frames };
  }
  const duration = end - start + 1;
  const fadeInEnd = Math.min(end, start + Math.max(3, Math.min(9, Math.floor(duration / 4))));
  const fadeOutStart = Math.max(fadeInEnd + 1, end - Math.max(3, Math.min(9, Math.floor(duration / 4))));
  const unique = new Map([
    [start, { frame: start, value: 0, easing: "easeInOut" as const }],
    [fadeInEnd, { frame: fadeInEnd, value: 1, easing: "easeInOut" as const }],
    [fadeOutStart, { frame: fadeOutStart, value: 1, easing: "easeInOut" as const }],
    [end, { frame: end, value: 0, easing: "easeInOut" as const }],
  ]);
  return { property: "opacity", keyframes: [...unique.values()].sort((a,b)=>a.frame-b.frame) };
}
function entry(preset: MotionPreset, start: number, end: number, x: number, y: number): MotionTrack[] {
  const arrival = Math.min(end, start + 13);
  if (preset === "slide-left") return [{ property: "x", keyframes: [
    { frame: start, value: x + 105, easing: "easeInOut" },
    { frame: arrival, value: x, easing: "easeInOut" },
  ] }];
  if (preset === "slide-up") return [{ property: "y", keyframes: [
    { frame: start, value: y + 90, easing: "easeInOut" },
    { frame: arrival, value: y, easing: "easeInOut" },
  ] }];
  if (preset === "tilt") return [{ property: "rotation", keyframes: [
    { frame: start, value: -11, easing: "easeInOut" },
    { frame: arrival, value: 0, easing: "easeInOut" },
  ] }];
  return [];
}
function fitFont(text: string, maxWidth: number, base: number): number {
  let size = base;
  while (size > 30) {
    ctx.font = size + "px Arial";
    if (ctx.measureText(text).width <= maxWidth) break;
    size -= 2;
  }
  return size;
}
/** Compiles modern, safe Motion v1 tracks: no new layer kinds, script execution, or remote media. */
export function compilePresetComposition(plan: MotionDirectorPlan): MotionProject["composition"] {
  const count = plan.durationSeconds * 30;
  const transition = plan.transition ?? "crossfade";
  const layers: MotionProject["composition"]["layers"] = [];
  const foreground = contrastColor(plan.background);
  plan.scenes.forEach((scene: MotionDirectorScene, index) => {
    const startBase = Math.floor(index * count / plan.scenes.length);
    const endBase = Math.floor((index + 1) * count / plan.scenes.length) - 1;
    const overlap = transition === "crossfade" && plan.scenes.length > 1 ? 6 : 0;
    const start = Math.max(0, startBase - (index ? overlap : 0));
    const end = Math.min(count - 1, endBase + (index < plan.scenes.length - 1 ? overlap : 0));
    const motion = scene.motion ?? plan.motion ?? "slide-left";
    const visible = fade(start, end, count, transition);
    const copyX = 148;
    const copyY = 444;
    layers.push({ id: "scene-" + index + "-accent", kind: "rect", x: 148, y: 407,
      width: 164, height: 9, rotation: 0, opacity: 1, fill: scene.accent, tracks: [visible] });
    layers.push({ id: "scene-" + index + "-title", kind: "text", text: scene.headline,
      x: copyX, y: copyY, width: 1600, height: 118, rotation: 0, opacity: 1,
      fill: foreground, fontSize: fitFont(scene.headline, 1590, 78), fontFamily: "Arial",
      tracks: [visible, ...entry(motion, start, end, copyX, copyY)] });
    if (scene.subtitle) {
      layers.push({ id: "scene-" + index + "-subtitle", kind: "text", text: scene.subtitle,
        x: copyX + 4, y: 605, width: 1590, height: 76, rotation: 0, opacity: 1,
        fill: scene.accent, fontSize: fitFont(scene.subtitle, 1580, 39), fontFamily: "Arial",
        tracks: [visible, ...entry(motion, start, end, copyX + 4, 605)] });
    }
  });
  return { width: 1920, height: 1080, fps: { numerator: 30, denominator: 1 },
    durationFrames: count, background: plan.background, layers };
}
