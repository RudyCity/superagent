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
}

function colorHex(r: number, g: number, b: number): string {
  return "#" + [r, g, b].map(channel =>
    Math.round(Math.max(0, Math.min(255, channel))).toString(16).padStart(2, "0")).join("");
}
function consistentDarkBackground(frames: Frame[]): string {
  const samples = frames.flatMap(frame => {
    const { width, height, pixels } = frame;
    return [0, width - 1, width * (height - 1), width * height - 1].map(index => {
      const offset = index * 4;
      return [pixels[offset], pixels[offset + 1], pixels[offset + 2]];
    });
  });
  const averaged = [0, 1, 2].map(channel =>
    samples.reduce((sum, rgb) => sum + rgb[channel], 0) / samples.length);
  if (averaged.some(n => n > 85) || samples.some(rgb =>
    rgb.some((n, channel) => Math.abs(n - averaged[channel]) > 30)))
    throw new Error("Background is not stable and dark across sampled frames");
  return colorHex(averaged[0], averaged[1], averaged[2]);
}

/** Flood-fill isolated bright objects. Eight-neighbour segmentation at a
 * fixed threshold; no background pixels, file paths, model calls or URLs.
 */
export function findStudioBrightComponents(
  pixels: Uint8Array | Uint8ClampedArray, width: number, height: number,
): Component[] {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
      width <= 0 || height <= 0 || width * height > MAX_FRAME_PIXELS ||
      pixels.length !== width * height * 4) throw new Error("Invalid bounded decoded video frame");
  const mask = new Uint8Array(width * height);
  for (let index = 0; index < mask.length; index++) {
    const pos = index * 4;
    const luminosity = .299 * pixels[pos] + .587 * pixels[pos + 1] + .114 * pixels[pos + 2];
    if (pixels[pos + 3] >= 64 && luminosity >= 155) mask[index] = 1;
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
    // Full-frame foreground is indistinguishable from a bright background.
    if (boxWidth * boxHeight >= width * height * .55 || boxWidth < 5 || boxHeight < 5) continue;
    result.push({ x: xmin, y: ymin, width: boxWidth, height: boxHeight,
      count: tail, r: red / tail, g: green / tail, b: blue / tail });
    if (result.length > MAX_OBJECTS) throw new Error(
      "Too many foreground components; this prototype supports at most four separated shapes");
  }
  return result.sort((a, b) => a.x - b.x || a.y - b.y);
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
  const components = findStudioBrightComponents(pixels, image.width, image.height);
  if (!components.length) throw new Error("Reference frame has no isolated bright foreground");
  return { time, width: image.width, height: image.height, pixels, components };
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
    rgba[destination] = frame.pixels[original];
    rgba[destination + 1] = frame.pixels[original + 1];
    rgba[destination + 2] = frame.pixels[original + 2];
    rgba[destination + 3] = frame.pixels[original + 3];
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
      const original = .299 * source.pixels[offset] + .587 * source.pixels[offset + 1] +
        .114 * source.pixels[offset + 2] >= 155;
      const output = .299 * pixels[offset] + .587 * pixels[offset + 1] +
        .114 * pixels[offset + 2] >= 155;
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

    const times = [0, duration * .5, duration * .85];
    const frames: Frame[] = [];
    for (const time of times) frames.push(await decodedFrame(source, time));
    if (frames.some(f => f.width !== frames[0].width || f.height !== frames[0].height))
      throw new Error("Reference frames changed dimensions");
    if (frames[0].components.length < 2)
      throw new Error("Multi-object prototype requires 2-4 isolated bright objects");

    const background = consistentDarkBackground(frames);
    const ordered: Component[][] = [frames[0].components];
    const costs: number[][] = [];
    for (let i = 1; i < frames.length; i++) {
      const previous = ordered[i - 1];
      const matched = associateStudioObjects(previous, frames[i].components, frames[i].width, frames[i].height);
      const next = matched.indices.map(idx => frames[i].components[idx]);
      for (let j = 0; j < next.length; j++) {
        const previousArea = previous[j].width * previous[j].height;
        const ratio = next[j].width * next[j].height / previousArea;
        if (ratio < .65 || ratio > 1.5)
          throw new Error("Foreground geometry changed too much for safe tracking");
      }
      costs.push(matched.costs);
      ordered.push(next);
    }
    const totalFrames = Math.max(30, Math.round(duration * 30));
    const sampledFrames = times.map(time => Math.min(totalFrames - 1, Math.round(time * 30)));
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
    const review = await compareSampledVideoAndStudio(expected, frames, sampledFrames);
    // Fail before writing a project if tracing has produced a misleading or
    // visually unrelated foreground. The threshold is intentionally modest.
    if (review.foregroundIoU.some(score => score < .38))
      throw new Error("Vector reconstruction failed minimum sampled foreground fidelity");
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
      reviewPng,
      limitations: [
        "Only 2-4 separated bright shapes on a dark background; no AI vision model is used.",
        "Three sampled frames estimate x/y movement only; geometry/rotation/text/audio are not reconstructed.",
        "Crossing or overlapping objects, occlusion and unstable identities fail closed.",
        "Confidence is association-cost heuristic; foreground IoU measures only three sampled binary masks.",
      ],
    };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}
