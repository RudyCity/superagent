import { createCanvas } from "@napi-rs/canvas";
import type { MotionProject, TextLayer } from "../schema/types.js";
import { evaluateFrame } from "../timeline/evaluateFrame.js";
import { validateMotionProject } from "../schema/validation.js";

export interface MotionQualityIssue {
  severity: "warning" | "error"; code: string; scene: number; message: string;
}
export interface MotionQualityReport {
  passed: boolean;
  samples: Array<{ frame: number; scene: number; visibleHeadlines: string[] }>;
  issues: MotionQualityIssue[];
}
const measuring = createCanvas(1, 1).getContext("2d");
function luminance(color: string): number {
  const numeric = parseInt(color.slice(1), 16);
  const values = [(numeric >> 16) & 255, (numeric >> 8) & 255, numeric & 255];
  return values.reduce((sum, channel, i) => {
    const x = channel / 255;
    const linear = x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    return sum + linear * [0.2126, 0.7152, 0.0722][i];
  }, 0);
}
function contrast(a: string, b: string): number {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
/** Deterministic structural/frame-sampled design QA. This is NOT an AI/vision review. */
export function inspectMotionQuality(project: MotionProject): MotionQualityReport {
  validateMotionProject(project);
  const issues: MotionQualityIssue[] = [];
  const samples: MotionQualityReport["samples"] = [];
  const headlines = project.composition.layers
    .filter((layer): layer is TextLayer => layer.kind === "text" && /^scene-\d+-title$/.test(layer.id))
    .sort((a, b) => Number(a.id.match(/\d+/)?.[0]) - Number(b.id.match(/\d+/)?.[0]));
  if (!headlines.length) {
    issues.push({ severity: "warning", code: "no-director-scenes", scene: -1,
      message: "Project has no Motion Director title scenes to review" });
  }
  headlines.forEach((layer, index) => {
    const scene = Number(layer.id.match(/\d+/)?.[0]);
    const count = headlines.length;
    const frameIndex = Math.min(project.composition.durationFrames - 1,
      Math.floor((index + 0.5) * project.composition.durationFrames / count));
    const frame = evaluateFrame(project, frameIndex);
    const rendered = frame.layers.find(item => item.layer.id === layer.id);
    const visibleHeadlines = frame.layers.filter(item =>
      item.layer.kind === "text" && /-title$/.test(item.layer.id) &&
      item.values.opacity >= 0.7).map(item => (item.layer as TextLayer).text);
    samples.push({ frame: frameIndex, scene, visibleHeadlines });
    if (!rendered || rendered.values.opacity < 0.7) {
      issues.push({ severity: "error", code: "title-not-visible", scene,
        message: "Scene title is not visible at its representative middle frame" });
    }
    measuring.font = layer.fontSize + 'px "' + layer.fontFamily + '"';
    const width = measuring.measureText(layer.text).width;
    const left = rendered?.values.x ?? layer.x;
    const baseline = (rendered?.values.y ?? layer.y) + layer.fontSize;
    if (width > layer.width || left < 32 || left + width > project.composition.width - 32 ||
        baseline > project.composition.height - 32 || baseline - layer.fontSize < 32) {
      issues.push({ severity: "warning", code: "text-overflow", scene,
        message: "Title may extend beyond its readable canvas bounds" });
    }
    if (contrast(layer.fill, project.composition.background) < 4.5) {
      issues.push({ severity: "warning", code: "low-contrast-title", scene,
        message: "Title contrast against the background is below 4.5:1" });
    }
    const subtitles = project.composition.layers.filter((item): item is TextLayer =>
      item.kind === "text" && item.id === "scene-" + scene + "-subtitle");
    for (const subtitle of subtitles) {
      if (contrast(subtitle.fill, project.composition.background) < 3) {
        issues.push({ severity: "warning", code: "low-contrast-subtitle", scene,
          message: "Subtitle accent may be difficult to read against the background" });
      }
      measuring.font = subtitle.fontSize + 'px "' + subtitle.fontFamily + '"';
      if (measuring.measureText(subtitle.text).width > subtitle.width) {
        issues.push({ severity: "warning", code: "subtitle-overflow", scene,
          message: "Subtitle exceeds the available text width" });
      }
    }
  });
  return { passed: !issues.some(item => item.severity === "error"), samples, issues };
}
