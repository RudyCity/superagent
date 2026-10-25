import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { readMotionVideo } from "../assets/motionVideoClips.js";
import { traceImageBuffer, type TracedPath } from "../vector/imageTracer.js";
import { createMotionProject, motionWorkspaceRoot, updateMotionProject } from "../project/projectStore.js";
import { validateMotionProject } from "../schema/validation.js";
import type { MotionComposition, MotionTrack } from "../schema/types.js";

const run = promisify(execFile);
type Bounds = TracedPath["bounds"];
interface Snapshot {
  at: number;
  source: TracedPath;
  bounds: Bounds;
  imageWidth: number;
  imageHeight: number;
}

function bestContour(paths: TracedPath[], width: number, height: number): TracedPath {
  const allowed = paths.filter(p => {
    const area = p.bounds.width * p.bounds.height;
    return area >= 50 && area < width * height * 0.7;
  }).sort((a, b) =>
    b.bounds.width * b.bounds.height - a.bounds.width * a.bounds.height);
  if (!allowed[0]) throw new Error("Video reconstruction found no isolated high-contrast foreground");
  return allowed[0];
}

/**
 * Experimental deterministic P3 seed: tracks one dominant bright vector
 * silhouette across three constrained frames. Not model-powered, not exact
 * reverse engineering. Never reads arbitrary paths: source is a verified,
 * already-imported content-addressed Studio video ID.
 */
export async function reconstructSimpleStudioVideo(workspace: string, videoId: string): Promise<{
  status: "prototype"; projectId: string; revision: number;
  sampleTimes: number[]; confidence: number; dimensions: { width: number; height: number };
  limitations: string[];
}> {
  const video = await readMotionVideo(workspace, videoId);
  if (video.length > 12 * 1024 * 1024)
    throw new Error("Experimental video reconstruction is limited to 12 MB");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "studio-reconstruct-"));
  try {
    const sourcePath = path.join(directory, video[0] === 0x1a ? "source.webm" : "source.mp4");
    await fs.writeFile(sourcePath, video, { mode: 0o600 });
    const meta = await run("ffprobe", [
      "-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height",
      "-of", "json", sourcePath,
    ], { timeout: 10000, maxBuffer: 32_768, windowsHide: true });
    const data = JSON.parse(String(meta.stdout));
    const duration = Number(data.format?.duration);
    const track = data.streams?.find((s: { codec_type?: string }) => s.codec_type === "video");
    const w = Number(track?.width), h = Number(track?.height);
    if (!(duration >= 1 && duration <= 12) ||
        !(w >= 32 && w <= 1280 && h >= 32 && h <= 720) ||
        w / h < 0.25 || w / h > 4)
      throw new Error("Reconstruction prototype accepts 1-12 s, 32-1280x32-720 video only");
    const times = [0, duration * 0.5, duration * 0.85];
    const samples: Snapshot[] = [];
    for (const at of times) {
      const { stdout } = await run("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-ss", String(at),
        "-i", sourcePath, "-frames:v", "1", "-vf", "scale=320:-2",
        "-c:v", "png", "-f", "image2pipe", "pipe:1",
      ], { timeout: 15000, maxBuffer: 4 * 1024 * 1024, encoding: "buffer", windowsHide: true });
      if (!Buffer.isBuffer(stdout) || stdout.length < 24)
        throw new Error("Reconstruction video frame was unreadable");
      const traced = await traceImageBuffer(stdout, {
        mode: "silhouette", invert: true, threshold: 155, smooth: false, simplify: 1.5, minArea: 50,
      });
      const contour = bestContour(traced.paths, traced.width, traced.height);
      samples.push({ at, source: contour, bounds: contour.bounds,
        imageWidth: traced.width, imageHeight: traced.height });
    }
    const first = samples[0];
    const baseArea = first.bounds.width * first.bounds.height;
    const stable = samples.every(s => {
      const area = s.bounds.width * s.bounds.height;
      return area / baseArea >= 0.55 && area / baseArea <= 1.8 &&
        s.imageWidth === first.imageWidth && s.imageHeight === first.imageHeight;
    });
    if (!stable) throw new Error(
      "Reconstruction foreground changed shape/size; review manually instead of fabricating motion");
    const durationFrames = Math.round(duration * 30);
    const framePositions = [0, Math.round(times[1] * 30), Math.round(times[2] * 30)];
    const makeTrack = (axis: "x" | "y"): MotionTrack => ({
      property: axis,
      keyframes: samples.map((s, i) => ({
        frame: Math.min(durationFrames - 1, framePositions[i]),
        value: (s.bounds[axis] - first.bounds[axis]),
        easing: "linear" as const,
      })),
    });
    const composition: MotionComposition = {
      width: first.imageWidth, height: first.imageHeight,
      fps: { numerator: 30, denominator: 1 }, durationFrames,
      background: "#090d15",
      layers: [{
        id: "reconstructed-subject", kind: "path",
        x: 0, y: 0,
        width: Math.max(1, first.bounds.width), height: Math.max(1, first.bounds.height),
        rotation: 0, opacity: 1,
        fill: first.source.fill,
        d: first.source.d, tracks: [makeTrack("x"), makeTrack("y")],
      }],
    };
    // Validate the complete vector composition before allocating a real
    // project. Failed or incompatible footage must not leave empty projects.
    const now = new Date().toISOString();
    validateMotionProject({
      schemaVersion: 1, id: "studio-reference-preview",
      workspaceRoot: await motionWorkspaceRoot(workspace),
      name: "Reference video vector reconstruction",
      revision: 1, createdAt: now, updatedAt: now, composition,
    });
    const project = await createMotionProject(workspace, "Reference video vector reconstruction");
    const updated = await updateMotionProject(workspace, project.id, project.revision, [
      { type: "replace-composition", composition },
    ]);
    const movements = samples.map(s =>
      Math.hypot(s.bounds.x - first.bounds.x, s.bounds.y - first.bounds.y));
    const confidence = Number(Math.max(0.1, Math.min(0.75,
      0.75 - movements.reduce((a, v) => a + v, 0) / (first.imageWidth * 10))).toFixed(2));
    return {
      status: "prototype", projectId: project.id, revision: updated.revision,
      sampleTimes: times.map(v => Number(v.toFixed(3))),
      dimensions: { width: first.imageWidth, height: first.imageHeight },
      confidence,
      limitations: [
        "Only one dominant bright 2D silhouette is traced; original source code cannot be recovered.",
        "Only 3 sampled frames drive positional x/y keyframes; occlusion, rotations, scale and text are not reconstructed.",
        "Confidence is a heuristic stability indicator, not a measured pixel/video fidelity score.",
        "Video/audio are not embedded in the generated vector composition; review Studio preview before exporting code.",
      ],
    };
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}
