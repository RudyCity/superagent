import type { MotionProject, TextLayer } from "../schema/types.js";
import { evaluateTrack } from "../timeline/evaluateFrame.js";
import { validateMotionProject } from "../schema/validation.js";

type CaptionSegment = { start: number; end: number; text: string };
function milliseconds(frame: number, fps: number): string {
  const total = Math.max(0, Math.round(frame * 1000 / fps));
  const hours = Math.floor(total / 3600000);
  const minutes = Math.floor(total / 60000) % 60;
  const seconds = Math.floor(total / 1000) % 60;
  const milli = total % 1000;
  return [hours, minutes, seconds].map(value => String(value).padStart(2, "0")).join(":") +
    "," + String(milli).padStart(3, "0");
}
function safeCopy(text: string): string {
  // Subtitle is a plain-text representation of authored scene copy, not OCR or audio transcription.
  return text.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
}
/** Extracts timecodes from actually evaluated scene opacity, avoiding overlapping SRT cue intervals. */
export function motionSceneCaptions(project: MotionProject): CaptionSegment[] {
  validateMotionProject(project);
  const fps = project.composition.fps.numerator / project.composition.fps.denominator;
  const sceneTitles = project.composition.layers
    .filter((item): item is TextLayer => item.kind === "text" && /^scene-\d+-title$/.test(item.id));
  const sceneText = sceneTitles.map(layer => {
    const index = Number(layer.id.split("-")[1]);
    const subtitle = project.composition.layers.find(item =>
      item.kind === "text" && item.id === "scene-" + index + "-subtitle") as TextLayer | undefined;
    const copy = [safeCopy(layer.text), subtitle && safeCopy(subtitle.text)].filter(Boolean).join("\n");
    return { layer, copy };
  });
  if (!sceneText.length) return [];
  const segments: CaptionSegment[] = [];
  let active = "";
  let started = 0;
  for (let frame = 0; frame <= project.composition.durationFrames; frame++) {
    let next = "";
    if (frame < project.composition.durationFrames) {
      let strongest = 0.49;
      for (const { layer, copy } of sceneText) {
        const opacity = layer.tracks.find(track => track.property === "opacity");
        const value = opacity ? evaluateTrack(opacity, frame) : layer.opacity;
        if (value > strongest) { strongest = value; next = copy; }
      }
    }
    if (active !== next) {
      if (active && frame > started) segments.push({ start: started / fps, end: frame / fps, text: active });
      started = frame;
      active = next;
    }
  }
  return segments;
}
export function motionSceneSrt(project: MotionProject): string {
  const segments = motionSceneCaptions(project);
  return segments.map((segment, index) =>
    String(index + 1) + "\n" +
    milliseconds(segment.start * project.composition.fps.numerator / project.composition.fps.denominator,
      project.composition.fps.numerator / project.composition.fps.denominator) +
    " --> " + milliseconds(segment.end * project.composition.fps.numerator / project.composition.fps.denominator,
      project.composition.fps.numerator / project.composition.fps.denominator) +
    "\n" + segment.text + "\n\n").join("");
}
