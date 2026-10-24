import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import type { MotionComposition, MotionLayer, MotionProject } from "./schema/types.js";
import { validateMotionProject, MotionValidationError } from "./schema/validation.js";
import { compileMotionEffectStack } from "./effects/effectStack.js";
import { getMotionJob, motionJobDir } from "./jobs/motionJobs.js";

export type MotionUpscaleTarget = "1080p" | "2k" | "4k" | "uhd";
export type MotionUpscaleMode = "lanczos" | "sharp" | "spline" | "superres";

export interface MotionUpscaleOptions {
  scale?: number;
  target?: MotionUpscaleTarget;
  targetWidth?: number;
}

export interface MotionUpscaleTargetInfo {
  target: MotionUpscaleTarget;
  label: string;
  width: number;
  height: number;
  scaleFactor: number;
}

const even = (n: number) => Math.max(16, Math.round(n / 2) * 2);
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

const TARGET_WIDTHS: Record<MotionUpscaleTarget, number> = {
  "1080p": 1920,
  "2k": 2560,
  "4k": 3840,
  "uhd": 3840,
};

/**
 * Returns available upscale targets based on current composition dimensions.
 */
export function getAvailableUpscaleTargets(width: number, height: number): MotionUpscaleTargetInfo[] {
  const isPortrait = height > width;
  const isSquare = Math.abs(width - height) < 4;
  const aspect = width / height;

  const targets: { target: MotionUpscaleTarget; label: string; maxDim: number }[] = [
    { target: "1080p", label: "Full HD (1080p)", maxDim: 1920 },
    { target: "2k", label: "2K Quad HD (1440p)", maxDim: 2560 },
    { target: "4k", label: "4K Ultra HD (2160p)", maxDim: 3840 },
  ];

  return targets.map(item => {
    let targetW: number;
    let targetH: number;
    if (isSquare) {
      const dim = item.target === "4k" ? 2160 : item.target === "2k" ? 1440 : 1080;
      targetW = dim;
      targetH = dim;
    } else if (isPortrait) {
      targetH = item.maxDim;
      targetW = even(targetH * aspect);
    } else {
      targetW = item.maxDim;
      targetH = even(targetW / aspect);
    }
    const factor = Number((targetW / width).toFixed(2));
    return {
      target: item.target,
      label: item.label,
      width: targetW,
      height: targetH,
      scaleFactor: factor,
    };
  });
}

/**
 * Upscales a vector Motion composition to higher resolution.
 * Accurately multiplies canvas dimensions, layer geometries, keyframe tracks,
 * font sizes, corner radii, and stroke widths without degradation.
 */
export function upscaleMotionComposition(project: MotionProject, options: MotionUpscaleOptions = {}): MotionComposition {
  validateMotionProject(project);
  const source = project.composition.stackBase ?? project.composition;

  let targetWidth: number;
  let scaleFactor: number;

  if (options.targetWidth !== undefined) {
    targetWidth = options.targetWidth;
    if (!Number.isSafeInteger(targetWidth) || targetWidth < 160 || targetWidth > 3840 || targetWidth % 2 !== 0) {
      throw new MotionValidationError(["targetWidth must be an even integer between 160 and 3840"]);
    }
    scaleFactor = targetWidth / source.width;
  } else if (options.target !== undefined) {
    if (!Object.hasOwn(TARGET_WIDTHS, options.target)) {
      throw new MotionValidationError(["Unsupported upscale target: " + String(options.target)]);
    }
    const isPortrait = source.height > source.width;
    const isSquare = Math.abs(source.width - source.height) < 4;
    const aspect = source.width / source.height;
    const maxDim = TARGET_WIDTHS[options.target];

    if (isSquare) {
      const dim = options.target === "4k" || options.target === "uhd" ? 2160 : options.target === "2k" ? 1440 : 1080;
      targetWidth = dim;
    } else if (isPortrait) {
      const targetHeight = maxDim;
      targetWidth = even(targetHeight * aspect);
    } else {
      targetWidth = maxDim;
    }
    scaleFactor = targetWidth / source.width;
  } else {
    scaleFactor = options.scale ?? 2;
    if (!Number.isFinite(scaleFactor) || scaleFactor < 1 || scaleFactor > 8) {
      throw new MotionValidationError(["scale factor must be between 1 and 8"]);
    }
    targetWidth = even(source.width * scaleFactor);
  }

  if (targetWidth > 3840) targetWidth = 3840;
  const targetHeight = even(targetWidth * (source.height / source.width));
  if (targetHeight > 3840) {
    throw new MotionValidationError(["Upscaled height exceeds 3840px limit"]);
  }

  const factor = targetWidth / source.width;

  const layers: MotionLayer[] = source.layers.map(layer => {
    const w = clamp(Math.round(layer.width * factor), 1, 100000);
    const h = clamp(Math.round(layer.height * factor), 1, 100000);
    const x = clamp(Math.round(layer.x * factor), -100000, 100000);
    const y = clamp(Math.round(layer.y * factor), -100000, 100000);

    const tracks = layer.tracks.map(t => {
      if (t.property === "x" || t.property === "y") {
        return {
          ...t,
          keyframes: t.keyframes.map(k => ({
            ...k,
            value: clamp(Math.round(k.value * factor), -100000, 100000),
          })),
        };
      }
      if (t.property === "strokeDashoffset") {
        return {
          ...t,
          keyframes: t.keyframes.map(k => ({
            ...k,
            value: Number((k.value * factor).toFixed(2)),
          })),
        };
      }
      return structuredClone(t);
    });

    const result: MotionLayer = {
      ...structuredClone(layer),
      x,
      y,
      width: w,
      height: h,
      tracks,
    };

    if (result.kind === "text") {
      result.fontSize = clamp(Math.round(result.fontSize * factor), 1, 1024);
    }
    if (result.kind === "rect" && result.cornerRadius !== undefined) {
      result.cornerRadius = Math.min(Math.round(result.cornerRadius * factor), w / 2, h / 2);
    }
    if (result.kind === "path") {
      if (result.strokeWidth !== undefined) {
        result.strokeWidth = Math.max(0.1, Number((result.strokeWidth * factor).toFixed(2)));
      }
      if (result.strokeDasharray && result.strokeDasharray.length > 0) {
        result.strokeDasharray = result.strokeDasharray.map(v => Math.max(0.1, Number((v * factor).toFixed(2))));
      }
      if (result.strokeDashoffset !== undefined) {
        result.strokeDashoffset = Number((result.strokeDashoffset * factor).toFixed(2));
      }
      if (factor !== 1) {
        result.scaleX = Number(((result.scaleX ?? 1) * factor).toFixed(4));
        result.scaleY = Number(((result.scaleY ?? 1) * factor).toFixed(4));
      }
    }

    return result;
  });

  const base: MotionComposition = {
    ...structuredClone(source),
    width: targetWidth,
    height: targetHeight,
    layers,
  };

  delete base.effectStack;
  delete base.stackBase;

  const result = project.composition.effectStack
    ? compileMotionEffectStack({ ...project, composition: base }, project.composition.effectStack)
    : base;

  validateMotionProject({ ...project, composition: result });
  return result;
}

export interface MotionArtifactUpscaleResult {
  jobId: string;
  sourceFile: string;
  upscaledFile: string;
  width: number;
  height: number;
  bytes: number;
  sha256: string;
  durationSeconds: number;
}

/**
 * Upscales a rendered H.264 MP4 artifact to higher resolution using FFmpeg Lanczos / unsharp filters.
 */
export async function upscaleMotionArtifact(
  workspace: string,
  jobId: string,
  options: {
    scale?: number;
    target?: MotionUpscaleTarget;
    mode?: MotionUpscaleMode;
    ffmpeg?: string;
  } = {},
): Promise<MotionArtifactUpscaleResult> {
  const job = await getMotionJob(workspace, jobId);
  if (job.status !== "completed" || !job.artifact) {
    throw new Error("Motion job artifact not ready for upscaling");
  }

  const renderDir = await motionJobDir(workspace, "renders");
  const source = path.join(renderDir, jobId + ".mp4");
  if (job.artifact.path !== source) {
    throw new Error("Invalid Motion artifact ownership");
  }

  const stat = await fs.lstat(source);
  if (!stat.isFile() || stat.size !== job.artifact.bytes) {
    throw new Error("Invalid Motion artifact file");
  }

  const [num, den] = job.profile.fps.split("/").map(Number);
  const durationSeconds = job.profile.frameCount * den / num;
  const currentWidth = job.profile.width;
  const currentHeight = job.profile.height;

  let targetWidth: number;
  if (options.target !== undefined) {
    const isPortrait = currentHeight > currentWidth;
    const isSquare = Math.abs(currentWidth - currentHeight) < 4;
    const aspect = currentWidth / currentHeight;
    const maxDim = TARGET_WIDTHS[options.target] ?? 1920;
    if (isSquare) {
      targetWidth = options.target === "4k" || options.target === "uhd" ? 2160 : options.target === "2k" ? 1440 : 1080;
    } else if (isPortrait) {
      targetWidth = even(maxDim * aspect);
    } else {
      targetWidth = maxDim;
    }
  } else {
    const factor = options.scale ?? 2;
    targetWidth = even(currentWidth * factor);
  }

  if (targetWidth > 3840) targetWidth = 3840;
  const targetHeight = even(targetWidth * (currentHeight / currentWidth));
  if (targetHeight > 3840) {
    throw new Error("Target upscale dimensions exceed 3840px limit");
  }

  const mode = options.mode ?? "sharp";
  let filterString: string;
  if (mode === "lanczos") {
    filterString = `scale=${targetWidth}:${targetHeight}:flags=lanczos+accurate_rnd`;
  } else if (mode === "spline") {
    filterString = `scale=${targetWidth}:${targetHeight}:flags=spline+accurate_rnd`;
  } else if (mode === "superres") {
    filterString = `scale=${targetWidth}:${targetHeight}:flags=lanczos+accurate_rnd,unsharp=7:7:1.0:7:7:0.0`;
  } else {
    // "sharp" default
    filterString = `scale=${targetWidth}:${targetHeight}:flags=lanczos+accurate_rnd,unsharp=5:5:0.7:5:5:0.0`;
  }

  const outputFile = path.join(renderDir, `${jobId}-upscaled-${targetWidth}x${targetHeight}.mp4`);
  const ffmpegBin = options.ffmpeg ?? "ffmpeg";

  const args = [
    "-hide_banner",
    "-loglevel", "error",
    "-nostdin",
    "-y",
    "-i", source,
    "-vf", filterString,
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    "-preset", "fast",
    "-crf", "18",
    "-c:a", "copy",
    "-movflags", "+faststart",
    outputFile,
  ];

  await new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpegBin, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let stderr = "";
    child.stderr?.on("data", chunk => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", code => {
      if (code === 0) resolve();
      else reject(new Error("FFmpeg upscale failed: " + stderr.slice(-300)));
    });
  });

  const outStat = await fs.lstat(outputFile);
  const hash = crypto.createHash("sha256");
  for await (const chunk of createReadStream(outputFile)) hash.update(chunk);

  return {
    jobId,
    sourceFile: source,
    upscaledFile: outputFile,
    width: targetWidth,
    height: targetHeight,
    bytes: outStat.size,
    sha256: hash.digest("hex"),
    durationSeconds,
  };
}
