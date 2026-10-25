import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { readMotionVideo } from "../assets/motionVideoClips.js";
import { traceImageData } from "../vector/imageTracer.js";
import { createMotionProject, motionWorkspaceRoot, studioStorageRoot, updateMotionProject } from "../project/projectStore.js";
import { renderMotionSvg } from "../runtime/frameSvg.js";
import { validateMotionProject } from "../schema/validation.js";
import type { MotionComposition, MotionProject, MotionTrack, PathLayer } from "../schema/types.js";

const execute = promisify(execFile);
const MIN_PIXELS = 30;
const MAX_OBJECTS = 4;
const TARGET_WIDTH = 320;
const MAX_FRAME_PIXELS = 320 * 720;
const MAX_TRACKED_SAMPLES = 9;

export function studioBaseSampleFrames(durationFrames: number): number[] {
  if (!Number.isSafeInteger(durationFrames) || durationFrames < 30 || durationFrames > 360)
    throw new Error("Invalid bounded frame duration");
  const count = durationFrames <= 120 ? 5 : durationFrames <= 240 ? 7 : 9;
  const max = durationFrames - 1;
  return Array.from({ length: count }, (_, i) =>
    Math.round(max * .96 * i / (count - 1)));
}


export interface StudioTrackedObject {
  id: string;
  boxes: Array<{ frame: number; x: number; y: number; width: number; height: number }>;
  matchingCosts: number[];
}
export interface StudioMultiObjectReconstruction {
  status: "experimental-multi";
  projectId: string;
  revision: number;
  objects: StudioTrackedObject[];
  sampleTimes: number[];
  dimensions: { width: number; height: number };
  confidence: number;
  measuredForegroundIoU: number[];
  interpolationCheckIoU: number[];
  reviewPng: string;
  limitations: string[];
}
interface Component {
  x: number; y: number; width: number; height: number;
  count: number; r: number; g: number; b: number;
}
interface Frame {
  time: number;
  width: number; height: number;
  pixels: Uint8ClampedArray;
  components: Component[];
  background: RGB;
}

function colorHex(r: number, g: number, b: number): string {
  return "#" + [r, g, b].map(channel =>
    Math.round(Math.max(0, Math.min(255, channel))).toString(16).padStart(2, "0")).join("");
}
type RGB = readonly [number, number, number];
const FOREGROUND_RGB_DISTANCE = 58;

function colorDistance(r: number, g: number, b: number, background: RGB): number {
  return Math.hypot(r - background[0], g - background[1], b - background[2]);
}

/** Corner checks fail closed on camera motion, uneven backgrounds or
 * objects touching frame corners, instead of tracing the backdrop.
 */
function frameBackground(pixels: Uint8Array | Uint8ClampedArray, width: number, height: number): RGB {
  const corners = [0, width - 1, width * (height - 1), width * height - 1]
    .map(index => Array.from(pixels.subarray(index * 4, index * 4 + 3)));
  const median = [0, 1, 2].map(channel => {
    const values = corners.map(pixel => pixel[channel]).sort((a, b) => a - b);
    return (values[1] + values[2]) / 2;
  }) as [number, number, number];
  if (corners.some(pixel => colorDistance(pixel[0], pixel[1], pixel[2], median) > 42))
    throw new Error("Background corners are inconsistent or obstructed");
  return median;
}
function stableSceneBackground(frames: Frame[]): RGB {
  const reference = frames[0].background;
  if (frames.some(frame =>
    colorDistance(frame.background[0], frame.background[1], frame.background[2], reference) > 35))
    throw new Error("Background changed across sampled frames");
  return reference;
}

/** Eight-connected foreground segmentation against a stable sampled backdrop.
 * Works for bright/dark/saturated isolated objects when they differ in RGB
 * from the backdrop. This is not general-purpose semantic segmentation.
 */
export function findStudioForegroundComponents(
  pixels: Uint8Array | Uint8ClampedArray, width: number, height: number,
  background: RGB,
): Component[] {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
      width <= 0 || height <= 0 || width * height > MAX_FRAME_PIXELS ||
      pixels.length !== width * height * 4 ||
      background.length !== 3 || background.some(channel => !Number.isFinite(channel) || channel < 0 || channel > 255))
    throw new Error("Invalid bounded decoded video frame");
  const mask = new Uint8Array(width * height);
  for (let index = 0; index < mask.length; index++) {
    const pos = index * 4;
    if (pixels[pos + 3] >= 64 &&
        colorDistance(pixels[pos], pixels[pos + 1], pixels[pos + 2], background) >= FOREGROUND_RGB_DISTANCE)
      mask[index] = 1;
  }
  const result: Component[] = [];
  const queue = new Int32Array(mask.length);
  for (let first = 0; first < mask.length; first++) {
    if (!mask[first]) continue;
    let head = 0, tail = 1;
    queue[0] = first;
    mask[first] = 0;
    let xmin = width, ymin = height, xmax = 0, ymax = 0;
    let red = 0, green = 0, blue = 0;
    while (head < tail) {
      const i = queue[head++];
      const x = i % width, y = Math.floor(i / width);
      xmin = Math.min(xmin, x); ymin = Math.min(ymin, y);
      xmax = Math.max(xmax, x); ymax = Math.max(ymax, y);
      const offset = i * 4;
      red += pixels[offset]; green += pixels[offset + 1]; blue += pixels[offset + 2];
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
        const neighbor = yy * width + xx;
        if (mask[neighbor]) { mask[neighbor] = 0; queue[tail++] = neighbor; }
      }
    }
    if (tail < MIN_PIXELS) continue;
    const boxWidth = xmax - xmin + 1, boxHeight = ymax - ymin + 1;
    if (boxWidth * boxHeight >= width * height * .55 || boxWidth < 5 || boxHeight < 5) continue;
    result.push({ x: xmin, y: ymin, width: boxWidth, height: boxHeight,
      count: tail, r: red / tail, g: green / tail, b: blue / tail });
    if (result.length > MAX_OBJECTS) throw new Error(
      "Too many foreground components; this prototype supports at most four separated shapes");
  }
  return result.sort((a, b) => a.x - b.x || a.y - b.y);
}

/** Compatibility helper for existing black-background brightness fixtures. */
export function findStudioBrightComponents(
  pixels: Uint8Array | Uint8ClampedArray, width: number, height: number,
): Component[] {
  return findStudioForegroundComponents(pixels, width, height, [0, 0, 0]);
}

function matchingCost(a: Component, b: Component, width: number, height: number): number {
  const distance = Math.hypot((a.x + a.width / 2 - b.x - b.width / 2) / width,
    (a.y + a.height / 2 - b.y - b.height / 2) / height);
  const palette = Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b) / 441.673;
  const areaRatio = (b.width * b.height) / (a.width * a.height);
  const size = Math.abs(Math.log(areaRatio));
  return distance * .68 + palette * .42 + size * .24;
}

/** Enumerate up to 4! assignments; refuse ambiguous association instead of
 * silently changing identities when two shapes meet/cross.
 */
export function associateStudioObjects(
  reference: Component[], observed: Component[], width: number, height: number,
): { indices: number[]; costs: number[]; gap: number } {
  if (!reference.length || reference.length !== observed.length || reference.length > MAX_OBJECTS)
    throw new Error("Foreground object count changed across frames; manual review required");
  const candidates: Array<{ indices: number[]; costs: number[]; total: number }> = [];
  const visit = (current: number[], used: boolean[]) => {
    if (current.length === reference.length) {
      const costs = current.map((idx, i) => matchingCost(reference[i], observed[idx], width, height));
      candidates.push({ indices: current, costs, total: costs.reduce((sum, n) => sum + n, 0) });
      return;
    }
    for (let i = 0; i < observed.length; i++) if (!used[i]) {
      used[i] = true; visit([...current, i], used); used[i] = false;
    }
  };
  visit([], Array(observed.length).fill(false));
  candidates.sort((a, b) => a.total - b.total ||
    a.indices.join("").localeCompare(b.indices.join("")));
  const best = candidates[0];
  const gap = candidates[1] ? candidates[1].total - best.total : 1;
  if (best.costs.some(cost => cost > .48) || gap < .045)
    throw new Error("Ambiguous or excessive shape displacement; manual review required");
  return { indices: best.indices, costs: best.costs, gap };
}

async function decodedFrame(source: string, time: number): Promise<Frame> {
  const { stdout } = await execute("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-ss", String(time), "-i", source,
    "-frames:v", "1", "-vf", "scale=" + TARGET_WIDTH + ":-2",
    "-c:v", "png", "-f", "image2pipe", "pipe:1",
  ], { timeout: 15000, maxBuffer: 4 * 1024 * 1024, encoding: "buffer", windowsHide: true });
  if (!Buffer.isBuffer(stdout) || stdout.length < 24) throw new Error("Cannot decode reference frame");
  const image = await loadImage(stdout);
  if (image.width > TARGET_WIDTH || image.width * image.height > MAX_FRAME_PIXELS)
    throw new Error("Reference frame exceeds reconstruction limits");
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0);
  const pixels = ctx.getImageData(0, 0, image.width, image.height).data;
  const background = frameBackground(pixels, image.width, image.height);
  const components = findStudioForegroundComponents(pixels, image.width, image.height, background);
  if (!components.length) throw new Error("Reference frame has no isolated foreground with sufficient color contrast");
  return { time, width: image.width, height: image.height, pixels, components, background };
}

/** A local contour (cropped around an object), not a screenshot embedded in SVG. */
function vectorObject(frame: Frame, region: Component): string {
  const pad = 2, cropWidth = region.width + pad * 2, cropHeight = region.height + pad * 2;
  const rgba = new Uint8ClampedArray(cropWidth * cropHeight * 4);
  for (let y = 0; y < cropHeight; y++) for (let x = 0; x < cropWidth; x++) {
    const sx = region.x + x - pad, sy = region.y + y - pad;
    if (sx < 0 || sy < 0 || sx >= frame.width || sy >= frame.height) continue;
    const original = (sy * frame.width + sx) * 4;
    const destination = (y * cropWidth + x) * 4;
    const foreground = frame.pixels[original + 3] >= 64 &&
      colorDistance(frame.pixels[original], frame.pixels[original + 1],
        frame.pixels[original + 2], frame.background) >= FOREGROUND_RGB_DISTANCE;
    rgba[destination] = rgba[destination + 1] = rgba[destination + 2] = foreground ? 255 : 0;
    rgba[destination + 3] = 255;
  }
  const traced = traceImageData({ width: cropWidth, height: cropHeight, data: rgba }, {
    mode: "silhouette", invert: true, threshold: 155, smooth: false,
    simplify: 1, minArea: MIN_PIXELS, fill: "#ffffff",
  });
  if (traced.paths.length !== 1 || !traced.paths[0].d || traced.paths[0].d.length > 20000)
    throw new Error("Ambiguous or untraceable local vector contour");
  return traced.paths[0].d;
}

/** Compare the original decoded frames with the actual Studio frame renderer.
 * This is sampled foreground-mask IoU, not an assertion of photorealistic
 * fidelity. The bounded PNG contact sheet has original left, output right.
 */
async function compareSampledVideoAndStudio(
  project: MotionProject, decoded: Frame[], frames: number[],
): Promise<{ foregroundIoU: number[]; contactSheet: Buffer }> {
  const width = decoded[0].width, height = decoded[0].height;
  const expectedBackground = [
    parseInt(project.composition.background.slice(1, 3), 16),
    parseInt(project.composition.background.slice(3, 5), 16),
    parseInt(project.composition.background.slice(5, 7), 16),
  ] as RGB;
  const header = 28;
  const contact = createCanvas(width * 2, height * decoded.length + header);
  const context = contact.getContext("2d");
  context.fillStyle = "#151923";
  context.fillRect(0, 0, contact.width, header);
  context.fillStyle = "#ffffff";
  context.font = "14px Arial";
  context.fillText("Video source (sampled)", 8, 19);
  context.fillText("Studio SVG reconstruction", width + 8, 19);
  const quality: number[] = [];
  for (let index = 0; index < decoded.length; index++) {
    const source = decoded[index];
    const image = await loadImage(Buffer.from(renderMotionSvg(project, frames[index])));
    const result = createCanvas(width, height);
    const resultContext = result.getContext("2d");
    resultContext.drawImage(image, 0, 0, width, height);
    const pixels = resultContext.getImageData(0, 0, width, height).data;
    let common = 0, union = 0;
    for (let offset = 0; offset < pixels.length; offset += 4) {
      const original = colorDistance(source.pixels[offset], source.pixels[offset + 1],
        source.pixels[offset + 2], source.background) >= FOREGROUND_RGB_DISTANCE;
      const output = colorDistance(pixels[offset], pixels[offset + 1],
        pixels[offset + 2], expectedBackground) >= FOREGROUND_RGB_DISTANCE;
      if (original || output) union++;
      if (original && output) common++;
    }
    if (!union) throw new Error("Video comparison had no visible foreground");
    quality.push(Number((common / union).toFixed(4)));
    const originalCanvas = createCanvas(width, height);
    const originalContext = originalCanvas.getContext("2d");
    const frameImage = originalContext.createImageData(width, height);
    frameImage.data.set(source.pixels);
    originalContext.putImageData(frameImage, 0, 0);
    context.drawImage(originalCanvas, 0, header + index * height);
    context.drawImage(result, width, header + index * height);
  }
  const png = await contact.encode("png");
  if (png.length > 2 * 1024 * 1024) throw new Error("Studio comparison PNG exceeded safe size limit");
  return { foregroundIoU: quality, contactSheet: png };
}

/** Experimental multiple-object video → editable SVG paths and keyframes.
 * No calls to an AI model. Rejects changing object counts, unstable area,
 * ambiguous identity matches and clips beyond tight resource limits.
 */
export async function reconstructMultiObjectStudioVideo(
  workspace: string, videoId: string,
): Promise<StudioMultiObjectReconstruction> {
  const bytes = await readMotionVideo(workspace, videoId);
  if (bytes.length > 12 * 1024 * 1024)
    throw new Error("Multi-object reconstruction limited to 12 MiB imported videos");
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "studio-multi-vector-"));
  try {
    const source = path.join(tmp, bytes[0] === 0x1a ? "source.webm" : "source.mp4");
    await fs.writeFile(source, bytes, { mode: 0o600 });
    const probe = await execute("ffprobe", [
      "-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height",
      "-of", "json", source,
    ], { timeout: 10000, maxBuffer: 32768, windowsHide: true });
    const meta = JSON.parse(String(probe.stdout));
    const duration = Number(meta.format?.duration);
    const stream = meta.streams?.find((item: { codec_type?: string }) => item.codec_type === "video");
    const w = Number(stream?.width), h = Number(stream?.height);
    if (!(duration >= 1 && duration <= 12) ||
      !(w >= 32 && w <= 1280 && h >= 32 && h <= 720) ||
      w / h < .25 || w / h > 4)
      throw new Error("Multi-object reconstruction accepts 1-12 s, 32-1280x32-720 sources only");

    const totalFrames = Math.max(30, Math.round(duration * 30));
    let sampledFrames = studioBaseSampleFrames(totalFrames);
    const decoded = new Map<number, Frame>();
    async function loadFrame(index: number): Promise<Frame> {
      const cached = decoded.get(index);
      if (cached) return cached;
      // All frame indices are bounded by the probed duration.
      const sample = await decodedFrame(source, index / 30);
      decoded.set(index, sample);
      return sample;
    }
    async function associateSamples(indices: number[]) {
      // Never spawn 9 FFmpeg processes simultaneously on small desktop PCs.
      const snapshots: Frame[] = [];
      for (const index of indices) snapshots.push(await loadFrame(index));
      if (snapshots.some(f => f.width !== snapshots[0].width || f.height !== snapshots[0].height))
        throw new Error("Reference frames changed dimensions");
      if (snapshots[0].components.length < 2)
        throw new Error("Multi-object prototype requires 2-4 isolated bright objects");
      const ordered: Component[][] = [snapshots[0].components];
      const costs: number[][] = [];
      for (let i = 1; i < snapshots.length; i++) {
        const previous = ordered[i - 1];
        const matched = associateStudioObjects(previous, snapshots[i].components,
          snapshots[i].width, snapshots[i].height);
        const next = matched.indices.map(idx => snapshots[i].components[idx]);
        for (let j = 0; j < next.length; j++) {
          const previousArea = previous[j].width * previous[j].height;
          const ratio = next[j].width * next[j].height / previousArea;
          if (ratio < .65 || ratio > 1.5)
            throw new Error("Foreground geometry changed too much for safe tracking");
        }
        costs.push(matched.costs);
        ordered.push(next);
      }
      return { snapshots, ordered, costs };
    }
    // First track 5-9 duration-scaled frames; refine high-motion intervals.
    // Tracking stays bounded to at most 9 decoded samples even on busy clips.
    let tracked = await associateSamples(sampledFrames);
    if (sampledFrames.length < MAX_TRACKED_SAMPLES) {
      const width = tracked.snapshots[0].width, height = tracked.snapshots[0].height;
      const candidates: Array<{ midpoint: number; score: number }> = [];
      for (let i = 1; i < sampledFrames.length; i++) {
        const score = Math.max(...tracked.ordered[i].map((obj, j) => {
          const prior = tracked.ordered[i - 1][j];
          return Math.hypot((obj.x - prior.x) / width, (obj.y - prior.y) / height);
        }));
        const midpoint = Math.round((sampledFrames[i - 1] + sampledFrames[i]) / 2);
        if (score >= .035 && midpoint !== sampledFrames[i - 1] &&
            midpoint !== sampledFrames[i]) candidates.push({ midpoint, score });
      }
      candidates.sort((a, b) => b.score - a.score || a.midpoint - b.midpoint);
      const added = candidates.slice(0, MAX_TRACKED_SAMPLES - sampledFrames.length)
        .map(candidate => candidate.midpoint);
      if (added.length > 0) {
        sampledFrames = [...sampledFrames, ...added].sort((a, b) => a - b);
        tracked = await associateSamples(sampledFrames);
      }
    }
    const { snapshots: frames, ordered, costs } = tracked;
    const background = colorHex(...stableSceneBackground(frames));
    const times = sampledFrames.map(frame => frame / 30);
    const layers: PathLayer[] = [];
    const objects: StudioTrackedObject[] = [];
    for (let j = 0; j < ordered[0].length; j++) {
      const first = ordered[0][j];
      const track = (axis: "x" | "y"): MotionTrack => ({
        property: axis,
        keyframes: ordered.map((set, index) => ({
          frame: sampledFrames[index], value: set[j][axis], easing: "linear" as const,
        })),
      });
      const id = "reconstructed-object-" + (j + 1);
      layers.push({
        kind: "path", id, x: first.x - 2, y: first.y - 2,
        width: first.width + 4, height: first.height + 4,
        rotation: 0, opacity: 1,
        fill: colorHex(first.r, first.g, first.b), fillRule: "evenodd",
        d: vectorObject(frames[0], first),
        tracks: [track("x"), track("y")],
      });
      // local crop has a two-pixel margin, so compensate in animated coordinates.
      layers[j].tracks.forEach(t => t.keyframes.forEach(k => { k.value -= 2; }));
      objects.push({
        id, boxes: ordered.map((set, i) => ({
          frame: sampledFrames[i], x: set[j].x, y: set[j].y,
          width: set[j].width, height: set[j].height,
        })),
        matchingCosts: costs.map(step => Number(step[j].toFixed(4))),
      });
    }
    const composition: MotionComposition = {
      width: frames[0].width, height: frames[0].height,
      background, fps: { numerator: 30, denominator: 1 },
      durationFrames: totalFrames, layers,
    };
    const now = new Date().toISOString();
    const expected: MotionProject = {
      schemaVersion: 1, id: "studio-multi-preview", workspaceRoot: await motionWorkspaceRoot(workspace),
      name: "Multiple reconstructed vector objects", revision: 1,
      createdAt: now, updatedAt: now, composition,
    };
    validateMotionProject(expected);
    // Three-frame contact sheet remains stable for the existing authenticated
    // API/UI while all 5-9 samples influence editable position tracks.
    const reviewIndices = [0, Math.floor((frames.length - 1) / 2), frames.length - 1];
    const review = await compareSampledVideoAndStudio(expected,
      reviewIndices.map(index => frames[index]),
      reviewIndices.map(index => sampledFrames[index]));
    // Probe two midpoints which were *not* used as reconstruction keyframes:
    // failures expose interpolation drift hidden by on-sample mask tests.
    const gaps = sampledFrames.slice(1).map((last, i) => {
      const start = sampledFrames[i];
      return { width: last - start, midpoint: Math.round((start + last) / 2) };
    }).filter(gap => gap.width > 2 && !sampledFrames.includes(gap.midpoint))
      .sort((a, b) => b.width - a.width || a.midpoint - b.midpoint)
      .slice(0, 2);
    const checkFrames = gaps.map(gap => gap.midpoint).sort((a, b) => a - b);
    const check = checkFrames.length > 0
      ? await compareSampledVideoAndStudio(expected,
        await Promise.all(checkFrames.map(loadFrame)), checkFrames)
      : null;
    if (review.foregroundIoU.some(score => score < .38))
      throw new Error("Vector reconstruction failed minimum sampled foreground fidelity");
    if (check && check.foregroundIoU.some(score => score < .38))
      throw new Error("Vector reconstruction failed out-of-sample interpolation fidelity");
    const project = await createMotionProject(workspace, "Multiple reconstructed vector objects");
    const saved = await updateMotionProject(workspace, project.id, project.revision,
      [{ type: "replace-composition", composition }]);
    const root = await studioStorageRoot(workspace, true);
    const code = path.join(root, "code");
    await fs.mkdir(code, { recursive: true, mode: 0o700 });
    const info = await fs.lstat(code);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("Unsafe Studio review artifact directory");
    const reviewPng = path.join(code, saved.id + "-r" + saved.revision + "-multi-review.png");
    await fs.writeFile(reviewPng, review.contactSheet, { flag: "wx", mode: 0o600 });
    const average = costs.flat().reduce((sum, n) => sum + n, 0) / costs.flat().length;
    return {
      status: "experimental-multi", projectId: saved.id, revision: saved.revision, objects,
      sampleTimes: times.map(n => Number(n.toFixed(3))),
      dimensions: { width: frames[0].width, height: frames[0].height },
      confidence: Number(Math.max(.1, Math.min(.75, .75 - average)).toFixed(2)),
      measuredForegroundIoU: review.foregroundIoU,
      interpolationCheckIoU: check?.foregroundIoU ?? [],
      reviewPng,
      limitations: [
        "Only 2-4 separated high-contrast shapes on a stable solid-color background; no AI vision model is used.",
        "Only 5-9 bounded position samples estimate x/y; geometry/rotation/text/audio are not reconstructed.",
        "Crossing or overlapping objects, occlusion and unstable identities fail closed.",
        "Confidence is association-cost heuristic; review IoU covers three samples and interpolation QA up to two unsampled frames.",
      ],
    };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}
