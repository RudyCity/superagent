import type { MotionTrack, TextLayer } from "../schema/types.js";

export interface StudioCaptionLine {
  text: string; confidence: number;
  x: number; y: number; width: number; height: number;
}
export interface StudioCaptionSample {
  index: number; lines: StudioCaptionLine[];
}
export interface StudioCaptionSegment {
  text: string; first: number; last: number;
  observations: Array<{ frame: number; caption: StudioCaptionLine }>;
}
export interface StudioCaptionLayer {
  layer: TextLayer; startFrame: number; endFrame: number; confidence: number;
}
const normalized = (text: string) => text.trim().replace(/\s+/g, " ").toUpperCase();

/** Recognize changes, blanks and reappearances while rejecting one-off OCR
 * readings; each segment must occur in at least two consecutive observations.
 * The source has already passed the bounded per-word OCR confidence checks.
 */
export function segmentStudioCaptionTimeline(
  samples: StudioCaptionSample[], durationFrames: number, width: number, height: number,
): StudioCaptionSegment[] {
  if (samples.length !== 9 || width <= 0 || height <= 0 ||
      samples.some((sample, i) => !Number.isSafeInteger(sample.index) ||
        sample.index < 0 || sample.index >= durationFrames ||
        (i > 0 && sample.index <= samples[i - 1].index) || sample.lines.length > 3))
    throw new Error("Invalid bounded OCR timeline samples");
  const complete: StudioCaptionSegment[] = [];
  let active: StudioCaptionSegment[] = [];
  for (const sample of samples) {
    const occupied = new Set<number>();
    const next: StudioCaptionSegment[] = [];
    for (const run of active) {
      const last = run.observations.at(-1)!.caption;
      const matches = sample.lines.flatMap((line, index) => {
        if (occupied.has(index) || normalized(line.text) !== normalized(run.text)) return [];
        const drift = Math.hypot((line.x - last.x) / width, (line.y - last.y) / height);
        const widthRatio = line.width / last.width, heightRatio = line.height / last.height;
        return drift <= .28 && widthRatio >= .65 && widthRatio <= 1.55 &&
          heightRatio >= .65 && heightRatio <= 1.55
          ? [{ index, line, drift }] : [];
      }).sort((a, b) => a.drift - b.drift);
      if (matches.length) {
        const chosen = matches[0];
        occupied.add(chosen.index);
        run.last++;
        run.observations.push({ frame: sample.index, caption: chosen.line });
        next.push(run);
      } else {
        complete.push(run);
      }
    }
    for (let index = 0; index < sample.lines.length; index++) {
      if (occupied.has(index)) continue;
      const line = sample.lines[index];
      next.push({
        first: samples.indexOf(sample), last: samples.indexOf(sample), text: line.text,
        observations: [{ frame: sample.index, caption: line }],
      });
    }
    active = next;
  }
  complete.push(...active);
  if (complete.some(run => run.observations.length === 1))
    throw new Error("OCR timeline contains an unconfirmed single-sample caption; manual review required");
  if (!complete.length || complete.length > 12)
    throw new Error("OCR timeline needs 1–12 repeated high-confidence caption segments");
  return complete.sort((a, b) => a.first - b.first || a.observations[0].caption.y - b.observations[0].caption.y);
}

/** Opacity uses discrete 'step' easing. The visible interval begins/ends
 * halfway between an observed visible caption and a different/empty sample.
 * Timing is estimated, not frame-accurate to the original video.
 */
export function buildStudioCaptionTimelineLayers(
  samples: StudioCaptionSample[], segments: StudioCaptionSegment[],
  durationFrames: number, fill: string,
): StudioCaptionLayer[] {
  return segments.map((segment, index) => {
    const first = segment.observations[0].caption;
    const before = samples[segment.first - 1]?.index;
    const after = samples[segment.last + 1]?.index;
    const startFrame = before === undefined ? 0 :
      Math.round((before + samples[segment.first].index) / 2);
    const endFrame = after === undefined ? durationFrames - 1 :
      Math.round((samples[segment.last].index + after) / 2) - 1;
    const padY = Math.max(2, Math.round(first.height * .12));
    const position = (property: "x" | "y"): MotionTrack => ({
      property, keyframes: segment.observations.map(({ frame, caption }) => ({
        frame, value: caption[property] - (property === "y" ? padY : 0), easing: "linear" as const,
      })),
    });
    const visibility: MotionTrack["keyframes"] = [];
    if (startFrame > 0) visibility.push({ frame: 0, value: 0, easing: "step" });
    visibility.push({ frame: startFrame, value: 1, easing: "step" });
    if (endFrame < durationFrames - 1) {
      visibility.push({ frame: endFrame, value: 1, easing: "step" });
      visibility.push({ frame: endFrame + 1, value: 0, easing: "step" });
    } else if (visibility.length === 1 && startFrame < durationFrames - 1) {
      visibility.push({ frame: durationFrames - 1, value: 1, easing: "step" });
    }
    const layer: TextLayer = {
      id: "ocr-caption-" + (index + 1), kind: "text", text: segment.text,
      x: first.x, y: first.y - padY,
      width: Math.max(8, Math.round(first.width * 1.25)),
      height: Math.max(8, Math.round(first.height * 1.4)),
      rotation: 0, opacity: 1, fill,
      fontSize: Math.max(8, Math.min(96, Math.round(first.height * 1.2))),
      fontFamily: "Arial",
      tracks: [position("x"), position("y"), { property: "opacity", keyframes: visibility }],
    };
    return {
      layer, startFrame, endFrame,
      confidence: segment.observations.reduce((sum, item) => sum + item.caption.confidence, 0) /
        segment.observations.length,
    };
  });
}
