import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chromium } from "playwright-core";
import { studioStorageRoot } from "../project/projectStore.js";
import { renderStudioNativeHtml } from "./studioNativeCodeExporter.js";
import type { MotionProject } from "../schema/types.js";

export interface StudioBrowserVideoOptions {
  width?: number;
  height?: number;
  fps?: number;
  durationSeconds?: number;
  signal?: AbortSignal;
  onProgress?: (completed: number, total: number) => void;
  audioAssetId?: string;
}
export interface StudioBrowserVideoResult {
  id: string;
  file: string;
  bytes: number;
  width: number;
  height: number;
  fps: number;
  frameCount: number;
  source: "studio" | "html" | "studio-react";
}

function validateOptions(options: StudioBrowserVideoOptions) {
  const width = options.width ?? 640;
  const height = options.height ?? 360;
  const fps = options.fps ?? 12;
  const durationSeconds = options.durationSeconds ?? 2;
  if (!Number.isSafeInteger(width) || width < 160 || width > 1920 || width % 2 ||
      !Number.isSafeInteger(height) || height < 90 || height > 1080 || height % 2 ||
      !Number.isSafeInteger(fps) || fps < 1 || fps > 30 ||
      typeof durationSeconds !== "number" || !Number.isFinite(durationSeconds) ||
      durationSeconds < 0.25 || durationSeconds > 12 ||
      width * height > 1920 * 1080 || Math.ceil(durationSeconds * fps) > 300)
    throw new RangeError("Code-to-Video requires even 160–1920×90–1080 dimensions, 1–30 FPS, 0.25–12 seconds, max 300 frames");
  return { width, height, fps, durationSeconds, frameCount: Math.ceil(durationSeconds * fps) };
}

/** Read the literal offline HTML from a Studio-generated React TSX adapter.
 * Never compile or execute TSX supplied by a user. Custom React must be built
 * to an isolated self-contained HTML page first.
 */
export function extractStudioReactOfflineHtml(reactTsx: string): string {
  if (typeof reactTsx !== "string" ||
      Buffer.byteLength(reactTsx, "utf8") > 2 * 1024 * 1024 ||
      !reactTsx.startsWith('"use client";') ||
      !reactTsx.includes('srcDoc={STUDIO_OFFLINE_HTML}')) {
    throw new Error("Unsupported React source: only Studio-generated TSX wrappers can be extracted");
  }
  const prefix = "const STUDIO_OFFLINE_HTML = ";
  const literalLine = reactTsx.split(String.fromCharCode(10)).find(line => line.startsWith(prefix));
  if (!literalLine || !literalLine.endsWith(";"))
    throw new Error("Studio React wrapper HTML literal not found");
  const literal = literalLine.slice(prefix.length, -1);
  const html = JSON.parse(literal) as unknown;
  if (typeof html !== "string" || !html.startsWith("<!doctype html>") ||
      !html.includes('id="studio-stage"') ||
      !html.includes("__studioRenderAt")) {
    throw new Error("Invalid Studio React wrapper HTML");
  }
  return html;
}

function validateHtml(html: string) {
  // SVG's standard xmlns URI is declarative XML namespace metadata, not a
  // network resource. Preserve it while blocking other URLs in user HTML.
  const networkScan = typeof html === "string"
    ? html.replace(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/g, "")
    : "";
  if (typeof html !== "string" || html.length < 30 || Buffer.byteLength(html, "utf8") > 256 * 1024 ||
      !/<!doctype html>|<html[\s>]/i.test(html) ||
      /<(?:iframe|frame|object|embed|base|meta\s+http-equiv)\b/i.test(html) ||
      /<script\b[^>]*\bsrc\s*=/i.test(html) ||
      /<link\b/i.test(html) ||
      /\b(?:file|https?|ftp|ws|wss):/i.test(networkScan) ||
      /\b(?:importScripts|serviceWorker|SharedWorker|WebSocket|EventSource)\b/i.test(html))
    throw new Error("Unsupported external HTML: supply a self-contained trusted document with no remote/file URLs, frames, external scripts or links");
  return html;
}

async function findChromeExecutable(): Promise<string> {
  const envPath = process.env.STUDIO_CHROMIUM_PATH;
  const candidates = [
    envPath,
    process.platform === "win32" ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" : undefined,
    process.platform === "win32" ? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" : undefined,
    process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : undefined,
    "/usr/bin/chromium", "/usr/bin/google-chrome",
  ].filter((item): item is string => !!item);
  for (const candidate of candidates) {
    const stat = await fs.stat(candidate).catch(() => null);
    if (stat?.isFile()) return candidate;
  }
  throw Object.assign(new Error("Code-to-Video requires local Chrome/Chromium or STUDIO_CHROMIUM_PATH"), { statusCode: 503 });
}

export async function localStudioCodeVideoReady(): Promise<boolean> {
  try {
    await findChromeExecutable();
    const { probeFfmpeg } = await import("../render/ffmpegEncoder.js");
    return await probeFfmpeg();
  } catch { return false; }
}

async function safeOutputPath(workspace: string): Promise<{ dir: string; id: string; file: string }> {
  const storage = await studioStorageRoot(workspace, true);
  const dir = path.join(storage, "code");
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const stats = await fs.lstat(dir);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("Unsafe Studio code output directory");
  const id = "codevideo-" + crypto.randomUUID().replace(/-/g, "").slice(0, 24);
  return { dir, id, file: path.join(dir, id + ".mp4") };
}

/** Render local self-contained HTML with offline Chromium and pipe sampled
 * PNG frames into FFmpeg. JS may run in Chromium, never in Bun/Node.
 * For first-party Studio, frame position is forced deterministically.
 * For generic HTML, CSS/WAAPI animations can be sampled; arbitrary React/JS
 * timelines require a built local HTML output exposing __studioRenderAt(t).
 *
 * Developer-preview ONLY: browser engine is defense-in-depth, not a VM for
 * hostile HTML. Caller must explicitly trust the local HTML source.
 */
export async function renderStudioBrowserVideo(
  workspace: string,
  input: { project?: MotionProject; html?: string; reactTsx?: string },
  options: StudioBrowserVideoOptions = {},
): Promise<StudioBrowserVideoResult> {
  if ([input.project, input.html, input.reactTsx].filter(Boolean).length !== 1)
    throw new Error("Supply exactly one Studio project, HTML or Studio React TSX");
  const profile = validateOptions({
    ...options,
    ...(input.project ? {
      width: options.width ?? input.project.composition.width,
      height: options.height ?? input.project.composition.height,
      fps: options.fps ?? Math.min(30, Math.round(input.project.composition.fps.numerator /
        input.project.composition.fps.denominator)),
      durationSeconds: options.durationSeconds ?? (input.project.composition.durationFrames *
        input.project.composition.fps.denominator / input.project.composition.fps.numerator),
    } : {}),
  });
  const html = input.project
    ? renderStudioNativeHtml(input.project, "autoplay")
    : validateHtml(input.reactTsx ? extractStudioReactOfflineHtml(input.reactTsx) : input.html!);
  const executablePath = await findChromeExecutable();
  const { id, file, dir } = await safeOutputPath(workspace);
  let temporaryAudio: string | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let ffmpeg: ReturnType<typeof spawn> | undefined;
  const cancelled = () => {
    if (options.signal?.aborted) throw Object.assign(
      new Error("Code-to-Video render cancelled"), { name: "AbortError" });
  };
  const abort = () => { try { ffmpeg?.kill(); } catch {}
    void browser?.close().catch(() => {}); };
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    cancelled();
    if (options.audioAssetId !== undefined) {
      if (!/^audio-[a-f0-9]{64}$/.test(options.audioAssetId))
        throw new Error("Invalid Studio audio asset ID");
      const { readMotionAudio } = await import("../assets/motionAudio.js");
      const audio = await readMotionAudio(workspace, options.audioAssetId);
      temporaryAudio = path.join(dir, id + ".temporary.wav");
      await fs.writeFile(temporaryAudio, audio, { flag: "wx", mode: 0o600 });
    }
    cancelled();
    browser = await chromium.launch({
      executablePath, headless: true, timeout: 20000,
      args: ["--no-first-run", "--disable-extensions", "--disable-background-networking",
        "--disable-features=WebRtcHideLocalIpsWithMdns"],
    });
    const context = await browser.newContext({
      viewport: { width: profile.width, height: profile.height },
      deviceScaleFactor: 1, offline: true, serviceWorkers: "block",
      acceptDownloads: false, permissions: [],
      reducedMotion: "reduce",
    });
    await context.route("**/*", route => route.abort());
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: "load", timeout: 12000 });
    await page.evaluate(() => {
      document.body.style.margin = "0";
      document.body.style.overflow = "hidden";
      document.documentElement.style.overflow = "hidden";
      // Never start autoplay during a deterministic capture.
      (window as any).__studioStopCapture?.();
      for (const animation of document.getAnimations()) animation.pause();
    });
    cancelled();
    ffmpeg = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      "-f", "image2pipe", "-framerate", String(profile.fps),
      "-vcodec", "png", "-i", "pipe:0",
      ...(temporaryAudio ? ["-i", temporaryAudio] : []),
      "-vf", "scale=" + profile.width + ":" + profile.height,
      "-map", "0:v:0",
      ...(temporaryAudio ? ["-map", "1:a:0", "-af", "apad", "-c:a", "aac", "-b:a", "128k",
        "-t", String(profile.frameCount / profile.fps)] : ["-an"]),
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
      "-pix_fmt", "yuv420p", "-threads", "2", "-movflags", "+faststart",
      file,
    ], { windowsHide: true, stdio: ["pipe", "ignore", "pipe"] });
    const closed = new Promise<number | null>((resolve, reject) => {
      ffmpeg!.once("error", reject);
      ffmpeg!.once("close", resolve);
    });
    let ffmpegError = "";
    ffmpeg.stderr?.on("data", chunk => { ffmpegError = (ffmpegError + chunk.toString()).slice(-2000); });
    const timeoutAt = Date.now() + 90000;
    for (let i = 0; i < profile.frameCount; i++) {
      cancelled();
      if (Date.now() > timeoutAt) throw new Error("Code-to-Video browser render exceeded 90s");
      const time = i / profile.fps;
      await page.evaluate((seconds: number) => {
        const win = window as any;
        if (typeof win.__studioRenderAt === "function") win.__studioRenderAt(seconds);
        for (const animation of document.getAnimations()) {
          animation.pause();
          const end = animation.effect?.getComputedTiming().endTime;
          animation.currentTime = Number.isFinite(end) ? Math.min(seconds * 1000, end as number)
            : seconds * 1000;
        }
      }, time);
      const stage = page.locator("#studio-stage");
      const png = input.project && await stage.count()
        ? await stage.screenshot({ animations: "allow", timeout: 10000 })
        : await page.screenshot({ animations: "allow", timeout: 10000 });
      cancelled();
      if (!ffmpeg.stdin?.write(png)) await Promise.race([
        once(ffmpeg.stdin!, "drain"), closed.then(() => { throw new Error("FFmpeg stopped before all frames were encoded"); }),
      ]);
      options.onProgress?.(i + 1, profile.frameCount);
    }
    cancelled();
    ffmpeg.stdin?.end();
    const code = await closed;
    cancelled();
    if (code !== 0) throw new Error("Code-to-Video FFmpeg encoding failed: " + ffmpegError.slice(-400));
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1024 ||
      stat.size > 150 * 1024 * 1024) throw new Error("Invalid code-to-video MP4 output");
    return { id, file, bytes: stat.size, width: profile.width, height: profile.height,
      fps: profile.fps, frameCount: profile.frameCount, source: input.project ? "studio" : input.reactTsx ? "studio-react" : "html" };
  } catch (error) {
    ffmpeg?.kill();
    await fs.rm(file, { force: true });
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", abort);
    await browser?.close().catch(() => {});
    if (temporaryAudio) await fs.rm(temporaryAudio, { force: true }).catch(() => {});
  }
}

export async function readStudioCodeVideo(workspace: string, id: string): Promise<Buffer> {
  if (!/^codevideo-[a-f0-9]{24}$/.test(id)) throw new Error("Invalid code video ID");
  const root = await studioStorageRoot(workspace);
  const codeDir = path.join(root, "code");
  const dirStat = await fs.lstat(codeDir);
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink())
    throw new Error("Unsafe Studio code video directory");
  const output = path.join(codeDir, id + ".mp4");
  const info = await fs.lstat(output);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 150 * 1024 * 1024)
    throw new Error("Invalid code video file");
  return fs.readFile(output);
}
