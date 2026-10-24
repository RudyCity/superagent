import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import type { MotionProject } from "../schema/types.js";

export interface RenderProfile {
  width: number;
  height: number;
  fps: string;
  frameCount: number;
}
export function deriveRenderProfile(project: MotionProject, requestedWidth = 640, maxFrames = 1800): RenderProfile {
  if (!Number.isSafeInteger(requestedWidth) || requestedWidth < 160 || requestedWidth > 3840 || requestedWidth % 2 !== 0) {
    throw new RangeError("Render width must be an even integer from 160 to 3840");
  }
  const height = Math.round((requestedWidth * project.composition.height / project.composition.width) / 2) * 2;
  if (height < 2 || height > 3840) throw new RangeError("Output dimensions exceed render limits");
  if (project.composition.durationFrames > maxFrames) {
    throw new RangeError(`Render limited to ${maxFrames} frames for this preview pipeline`);
  }
  return {
    width: requestedWidth, height,
    fps: `${project.composition.fps.numerator}/${project.composition.fps.denominator}`,
    frameCount: project.composition.durationFrames,
  };
}

/** Probes FFmpeg without shell expansion, returning true only for a working encoder binary. */
export async function probeFfmpeg(ffmpeg = "ffmpeg"): Promise<boolean> {
  try {
    const child = spawn(ffmpeg, ["-hide_banner", "-version"], { stdio: ["ignore", "ignore", "ignore"], windowsHide: true });
    const [code] = await once(child, "close") as [number | null];
    return code === 0;
  } catch { return false; }
}

interface MotionAudioInput {
  path: string;
  startFrame: number;
  volume: number;
  seconds: number;
  fadeInFrames: number;
  fadeOutFrames: number;
  loop: boolean;
  role?: "music" | "voiceover";
}
/** Safe numeric graph assembled only from schema-validated audio metadata. */
function encodingArgs(profile: RenderProfile, file: string, tracks: MotionAudioInput[] = []): string[] {
  const [num, den] = profile.fps.split("/").map(Number);
  const duration = profile.frameCount * den / num;
  const args = [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-n",
    "-f", "rawvideo", "-pixel_format", "rgba",
    "-video_size", `${profile.width}x${profile.height}`,
    "-framerate", profile.fps, "-i", "pipe:0",
    ...tracks.flatMap(track => [...(track.loop ? ["-stream_loop", "-1"] : []), "-i", track.path]),
  ];
  if (tracks.length) {
    const filters = tracks.map((track, index) => {
      const offsetMs = Math.round(track.startFrame * den / num * 1000);
      const fadeIn = Math.min(track.seconds, track.fadeInFrames * den / num);
      const fadeOut = Math.min(track.loop ? Math.max(0, duration - offsetMs / 1000) : track.seconds, track.fadeOutFrames * den / num);
      const effectiveSeconds = track.loop ? Math.max(0, duration - offsetMs / 1000) : track.seconds;
      const out = Math.max(0, effectiveSeconds - fadeOut);
      return `[${index + 1}:a:0]volume=${track.volume}` +
        (fadeIn ? `,afade=t=in:st=0:d=${fadeIn}` : "") +
        (fadeOut ? `,afade=t=out:st=${out}:d=${fadeOut}` : "") +
        `,adelay=${offsetMs}:all=1,apad,atrim=duration=${duration},asetpts=PTS-STARTPTS[a${index}]`;
    });
    const musicIndex = tracks.findIndex(track => track.role === "music");
    const voiceIndex = tracks.findIndex(track => track.role === "voiceover");
    const duck = tracks.length > 1 && musicIndex >= 0 && voiceIndex >= 0;
    const duckGraph = duck ? [
      `[a${voiceIndex}]asplit=2[voice-duck-side][voice-mix]`,
      `[a${musicIndex}][voice-duck-side]sidechaincompress=threshold=0.02:ratio=8:attack=20:release=250[ducked-music]`,
    ] : [];
    const sources = tracks.map((_, index) => duck && index === musicIndex ? "[ducked-music]" :
      duck && index === voiceIndex ? "[voice-mix]" : `[a${index}]`);
    const mixed = tracks.length === 1 ? "[a0]" :
      sources.join("") + `amix=inputs=${tracks.length}:duration=longest:normalize=0,atrim=duration=${duration}[mixed]`;
    args.push("-filter_complex", [...filters, ...duckGraph, ...(tracks.length > 1 ? [mixed] : [])].join(";"),
      "-map", "0:v:0", "-map", tracks.length === 1 ? "[a0]" : "[mixed]",
      "-c:a", "aac", "-b:a", "128k");
  } else args.push("-an");
  return args.concat([
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-preset", "veryfast", "-crf", "23", "-threads", "2",
    "-movflags", "+faststart", "-f", "mp4", file,
  ]);
}

/**
 * Raw RGBA frames are piped with Node stream backpressure into isolated FFmpeg.
 * The caller owns the temporary output path and must only publish after success.
 */
export async function encodeMotionMp4(
  project: MotionProject,
  profile: RenderProfile,
  temporaryFile: string,
  options: { ffmpeg?: string; signal?: AbortSignal; onProgress?: (frame: number) => Promise<void>; workspace?: string } = {},
): Promise<void> {
  if (options.signal?.aborted) throw new Error("Motion render cancelled");
  // Resolve an immutable, hash-verified asset before starting FFmpeg.
  const { motionAudioTracks, resolveMotionAudioTracks, readMotionAudio, inspectMotionWav } = await import("../assets/motionAudio.js");
  const audioTracks = motionAudioTracks(project);
  if (audioTracks.length && !options.workspace) throw new Error("Motion audio requires a workspace asset store");
  const audioPaths = audioTracks.length ? await resolveMotionAudioTracks(options.workspace!, project) : [];
  const audioInputs: MotionAudioInput[] = await Promise.all(audioTracks.map(async (track, index) => ({
    path: audioPaths[index],
    startFrame: track.startFrame,
    volume: track.volume,
    seconds: inspectMotionWav(await readMotionAudio(options.workspace!, track.assetId)).seconds,
    fadeInFrames: track.fadeInFrames ?? 0,
    fadeOutFrames: track.fadeOutFrames ?? 0,
    loop: track.loop === true,
    role: track.role,
  })));
  // Canvas is optional for non-render commands and should not slow terminal startup.
  const { createMotionFrameRenderer } = await import("./canvasFrames.js");
  const child = spawn(
    options.ffmpeg ?? "ffmpeg", encodingArgs(profile, temporaryFile, audioInputs),
    { windowsHide: true, stdio: ["pipe", "ignore", "pipe"] },
  );
  let stderr = "";
  let spawnError: Error | undefined;
  let cancelled = false;
  child.on("error", (err) => { spawnError = err; });
  child.stderr.on("data", (bytes: Buffer) => { stderr = (stderr + bytes.toString()).slice(-4000); });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
  const abort = () => {
    cancelled = true;
    child.kill("SIGTERM");
    child.stdin.destroy();
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  let failure: Error | undefined;
  try {
    const imageLayers = project.composition.layers.filter(layer => layer.kind === "image");
    const images = new Map<string, import("@napi-rs/canvas").Image>();
    if (imageLayers.length) {
      if (!options.workspace) throw new Error("Motion image layers require a workspace asset store");
      const [{ resolveMotionAssets }, { loadImage }] = await Promise.all([
        import("../assets/motionAssets.js"), import("@napi-rs/canvas"),
      ]);
      const assets = await resolveMotionAssets(options.workspace, project);
      for (const [assetId, bytes] of assets) images.set(assetId, await loadImage(bytes));
    }
    const drawFrame = createMotionFrameRenderer(project, profile.width, profile.height, images);
    for (let frame = 0; frame < profile.frameCount; frame++) {
      if (options.signal?.aborted) throw new Error("Motion render cancelled");
      if (options.onProgress) await options.onProgress(frame);
      if (options.signal?.aborted) throw new Error("Motion render cancelled");
      const rgba = drawFrame(frame);
      await new Promise<void>((resolve, reject) => {
        child.stdin.write(rgba, error => error ? reject(error) : resolve());
      });
    }
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
    child.kill("SIGTERM");
    child.stdin.destroy();
  } finally {
    options.signal?.removeEventListener("abort", abort);
    child.stdin.end();
  }
  const result = await exit;
  if (cancelled || options.signal?.aborted) throw new Error("Motion render cancelled");
  if (failure) throw failure;
  if (spawnError) throw spawnError;
  if (result.code !== 0) throw new Error("FFmpeg failed: " + (stderr || `exit code ${result.code}`));
  const stat = await fs.stat(temporaryFile);
  if (stat.size < 64) throw new Error("FFmpeg produced an empty video");
}
