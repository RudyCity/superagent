/**
 * Explicit, bounded and local CDP session archives.
 *
 * User opt-in is required for video. Sensitive browser pixels may appear in
 * MP4, so archives are saved under the ACTIVE PROJECT workspace,
 * never in the SuperAgent installation or ~/.superagent-r configuration.
 * No camera/microphone/OS screen capture; only the exact managed CDP page.
 * Commands and diagnostics are redacted before persistence.
 */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile, appendFile, stat, realpath, lstat, rm } from "node:fs/promises";
import { join, resolve, parse, relative, isAbsolute } from "node:path";
import { getRootConfigDir, getPackageRootDir } from "../config/paths.js";

const FPS = 2;
const FRAME_MS = 500;
const MAX_MS = 10 * 60_000;
const MAX_FRAMES = FPS * MAX_MS / 1000;
const MAX_SESSIONS = 4;
const MAX_FRAME_BYTES = 1_000_000;
const MAX_VIDEO_BYTES = 160_000_000;
const MAX_LOG_ROWS = 2500;
const allowedActions = new Set([
  "move_cursor", "hover_cursor", "click_cursor", "click", "type", "navigate",
  "drag", "drag_and_drop", "scroll_cursor", "show_cursor", "hide_cursor",
  "select_option", "upload_file", "handle_file_chooser", "frame_click",
  "frame_type", "frame_scroll", "evaluate", "handle_dialog", "activate",
  "close_tab", "new_tab",
]);

export type ArchiveScope = Readonly<{ targetKey: string; actorId: string; generation: string }>;
export type ArchiveDiagnostics = Readonly<{ at: string; kind: string; details: Record<string, unknown> }>;
export type SessionArchiveOptions = {
  /** Absolute existing project working directory from the active tool workspace. */
  projectDirectory: string;
  /** MP4 enabled by default; can be disabled only through a future explicit mode. */
  video?: boolean;
  confirmSensitiveVideo: boolean;
  /** Frame source must be the verified exact CDP target, never a new tab. */
  captureFrame: () => Promise<string>;
  /** A read-only validity check, re-evaluated for every periodic capture. */
  checkLease: () => Promise<boolean>;
  /** Stop only the diagnostic capture that this recording itself started. */
  stopDiagnostics?: () => Promise<void>;
};
type Session = {
  id: string;
  scope: ArchiveScope;
  directory: string;
  start: number;
  status: "recording" | "stopping" | "saved" | "failed";
  timer?: ReturnType<typeof setInterval>;
  inFlight?: Promise<void>;
  encoder: ChildProcessWithoutNullStreams;
  encoderExit: Promise<{code: number | null; log: string}>;
  frames: number;
  dropped: number;
  commands: number;
  diagnostics: number;
  problems: string[];
  totalFrameBytes: number;
  lastCaptureAt: number;
  recordId?: string;
  pendingWrites: Promise<void>;
  stopDiagnostics?: () => Promise<void>;
};
const sessions = new Map<string, Session>();
const scopeKey = (scope: ArchiveScope) => scope.targetKey + "\0" + scope.actorId;
async function archiveRoot(projectDirectory: string): Promise<string> {
  if (!projectDirectory || !isAbsolute(projectDirectory))
    throw Error("Recording requires an explicit active project directory.");
  const project = await realpath(resolve(projectDirectory));
  if (project === parse(project).root)
    throw Error("Recording at a filesystem root is prohibited.");
  for (const base of [getRootConfigDir(),getPackageRootDir()]) {
    const forbidden = await realpath(base).catch(() => resolve(base));
    const beneathForbidden = relative(forbidden, project);
    if (!beneathForbidden || (!beneathForbidden.startsWith("..") && !isAbsolute(beneathForbidden)))
      throw Error("Recording may not be saved in the SuperAgent runtime/configuration/source directory; select an active external project.");
  }
  const parent = join(project, ".superagent");
  const recordings = join(parent, "recordings");
  for (const folder of [parent, recordings, join(recordings, "cdp")]) {
    try {
      const existing = await lstat(folder);
      if (existing.isSymbolicLink() || !existing.isDirectory())
        throw Error("Recording destination is not a real project directory.");
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
      await mkdir(folder, { mode: 0o700 });
    }
  }
  // A local ignore rule prevents accidental git add -A of screenshots/video.
  const ignoreFile = join(recordings, ".gitignore");
  try {
    const info = await lstat(ignoreFile);
    if (info.isSymbolicLink() || !info.isFile()) throw Error("Unsafe recording ignore file.");
  } catch (error:any) {
    if (error.code !== "ENOENT") throw error;
    await writeFile(ignoreFile, "*\n", { flag:"wx",mode:0o600 });
  }
  return join(recordings, "cdp");
}
const hash = (input: string) => createHash("sha256").update(input).digest("hex");
const safeCount = (n: number) => Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, n));
const safeError = (error: unknown) => String((error as Error)?.message ?? error)
  .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [REDACTED]")
  .replace(/(password|token|secret|cookie|authorization|api[_-]?key|sessionToken)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
  .replace(/https?:\/\/[^\s]+/gi, "[URL REDACTED]")
  .slice(0, 300);

async function appendSafe(file: string, payload: object) {
  await appendFile(file, JSON.stringify(payload) + "\n", { encoding: "utf8", mode: 0o600 });
}
function queueSafe(item: Session, file: string, payload: object) {
  item.pendingWrites = item.pendingWrites.then(() => appendSafe(file, payload))
    .catch(error => {
      item.problems.push("Archive event write failed: " + safeError(error));
      // Preserve the queue after one failure, but report it in the manifest.
    });
}
function publicStatus(item: Session) {
  return { recordingId: item.id, status: item.status, startedAt: new Date(item.start).toISOString(),
    elapsedMs: safeCount(Date.now() - item.start), video: true, fps: FPS,
    frameCount: item.frames, droppedFrames: item.dropped,
    commandCount: item.commands, diagnosticCount: item.diagnostics,
    directory: item.directory, videoFile: join(item.directory,"video.mp4"),
    transcriptFile: join(item.directory,"transcript.jsonl"),
    diagnosticsFile: join(item.directory,"diagnostics.jsonl"),
    consoleFile: join(item.directory,"console.jsonl"),
    networkFile: join(item.directory,"network.jsonl"),
    errorsFile: join(item.directory,"errors.jsonl"),
    manifestFile: join(item.directory,"manifest.json"),
    errors: [...item.problems] };
}
function findActive(scope: ArchiveScope) {
  const item = sessions.get(scopeKey(scope));
  if (!item || item.scope.generation !== scope.generation)
    throw Error("Session recording not available for this verified actor and target generation.");
  return item;
}

/** ffmpeg is an optional local binary, never auto-downloaded during recording. */
export function assertSessionVideoEncoder(): void {
  const result = spawnSync("ffmpeg", ["-version"], { timeout: 3000, windowsHide: true, stdio: "ignore" });
  if (result.status !== 0) throw Error("Video recording requires an installed ffmpeg executable on PATH.");
}
async function frameTick(item: Session, capture: () => Promise<string>, valid: () => Promise<boolean>) {
  if (item.status !== "recording") return;
  if (Date.now() - item.start >= MAX_MS || item.frames >= MAX_FRAMES) {
    item.problems.push("Maximum 10-minute video duration reached; recording needs an explicit stop.");
    item.status = "stopping";
    if (item.timer) clearInterval(item.timer);
    return;
  }
  if (!(await valid())) {
    item.problems.push("Target ownership or session generation changed; capture stopped.");
    item.status = "stopping";
    if (item.timer) clearInterval(item.timer);
    return;
  }
  const base64 = await capture();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || base64.length > Math.ceil(MAX_FRAME_BYTES*4/3)+4)
    throw Error("CDP video frame is invalid or exceeds the size bound.");
  const frame = Buffer.from(base64, "base64");
  if (frame.length < 100 || frame.length > MAX_FRAME_BYTES ||
      frame[0] !== 0xff || frame[1] !== 0xd8 || frame[2] !== 0xff)
    throw Error("CDP frame must be a bounded JPEG.");
  if (item.totalFrameBytes + frame.length > MAX_VIDEO_BYTES)
    throw Error("Session capture byte budget exceeded.");
  if (!item.encoder.stdin.writable || !item.encoder.stdin.write(frame))
    throw Error("Video encoder backpressure; capture halted to avoid unbounded buffering.");
  item.frames++;
  item.totalFrameBytes += frame.length;
  item.lastCaptureAt = Date.now();
}

export async function startCdpSessionArchive(
  scope: ArchiveScope, opts: SessionArchiveOptions,
): Promise<ReturnType<typeof publicStatus>> {
  if (!scope.targetKey.startsWith("managed:") || !scope.actorId || !scope.generation)
    throw Error("A verified managed CDP target and agent are required.");
  if (opts.video === false || opts.confirmSensitiveVideo !== true)
    throw Error("MP4 recording is enabled by default and requires confirmSensitiveVideo:true.");
  if (sessions.has(scopeKey(scope))) throw Error("A recording already exists for this actor/target. Stop it first.");
  if ([...sessions.values()].filter(x => x.status === "recording").length >= MAX_SESSIONS)
    throw Error("Too many concurrent recordings.");
  if (!(await opts.checkLease())) throw Error("Target lease is no longer valid.");
  assertSessionVideoEncoder();
  const id = randomUUID();
  const root = await archiveRoot(opts.projectDirectory);
  const directory = join(root, id);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await mkdir(directory, { mode: 0o700 });
  for (const file of ["transcript.jsonl","diagnostics.jsonl","errors.jsonl","console.jsonl","network.jsonl"]) {
    await writeFile(join(directory,file),"",{flag:"wx",mode:0o600});
  }
  const args = ["-hide_banner","-loglevel","error","-nostdin","-y",
    "-f","image2pipe","-framerate",String(FPS),"-vcodec","mjpeg","-i","pipe:0",
    "-vf","scale=960:540:force_original_aspect_ratio=decrease,pad=960:540:(ow-iw)/2:(oh-ih)/2",
    "-pix_fmt","yuv420p","-c:v","libx264","-preset","ultrafast","-crf","29",
    "-movflags","+faststart",join(directory,"video.mp4")];
  const encoder = spawn("ffmpeg", args, { windowsHide:true, stdio:["pipe","pipe","pipe"] });
  let ffmpegError = "";
  encoder.stderr.on("data", chunk => {
    ffmpegError = (ffmpegError + String(chunk)).slice(-1500);
  });
  const encoderExit = new Promise<{code:number|null;log:string}>(resolve => {
    encoder.once("error",error => resolve({code:-1,log:safeError(error)}));
    encoder.once("close",code => resolve({code,log:safeError(ffmpegError)}));
  });
  encoder.stdin.on("error", () => { /* reported by frameTick on next write */ });
  const item: Session = {
    id, scope, directory, start:Date.now(), status:"recording",
    encoder, encoderExit, frames:0,dropped:0,commands:0,diagnostics:0,
    totalFrameBytes:0,lastCaptureAt:0,problems:[],pendingWrites:Promise.resolve(),
    stopDiagnostics:opts.stopDiagnostics,
  };
  try {
    // Fail before announcing success if the first screenshot isn't available.
    await frameTick(item, opts.captureFrame, opts.checkLease);
    await appendSafe(join(directory,"transcript.jsonl"), { at:new Date().toISOString(),
      category:"recording_started", actorHash:hash(scope.actorId).slice(0,12) });
    const save = async () => {
      if (item.inFlight || item.status !== "recording") return;
      item.inFlight = frameTick(item, opts.captureFrame, opts.checkLease)
        .catch(error => {
          item.dropped++;
          item.problems.push(safeError(error));
          item.status="stopping";
          if (item.timer) clearInterval(item.timer);
        }).finally(() => { item.inFlight = undefined; });
      await item.inFlight;
      if (String(item.status) === "stopping") {
        void stopCdpSessionArchive(item.scope).catch(error => {
          item.problems.push("Auto-finalization failed: " + safeError(error));
          item.status = "failed";
        });
      }
    };
    item.timer = setInterval(() => { void save(); }, FRAME_MS);
    item.timer.unref?.();
    sessions.set(scopeKey(scope), item);
    return publicStatus(item);
  } catch (error) {
    encoder.stdin.end();
    await encoderExit;
    await rm(directory, { recursive:true,force:true }).catch(()=>{});
    throw error;
  }
}

export function recordCdpSessionCommand(scope: ArchiveScope, command: string, result: string) {
  const item = sessions.get(scopeKey(scope));
  if (!item || item.scope.generation !== scope.generation ||
      item.status !== "recording" || !allowedActions.has(command) ||
      item.commands >= MAX_LOG_ROWS) return;
  item.commands++;
  const failed = result.startsWith("control_chrome_cdp failed:");
  const row = {
    at:new Date().toISOString(), sequence:item.commands, action:command,
    outcome: failed ? "failed" : "completed",
    ...(failed ? { error:safeError(result) } : {}),
    // Never persist selector, typed text, URL, tokens or arbitrary raw outputs.
  };
  queueSafe(item, join(item.directory,"transcript.jsonl"), row);
  if (failed) queueSafe(item,join(item.directory,"errors.jsonl"),row);
}
export function recordCdpSessionDiagnostic(targetKey: string, event: ArchiveDiagnostics) {
  for (const item of sessions.values()) {
    if (item.scope.targetKey !== targetKey || item.status !== "recording" ||
        item.diagnostics >= MAX_LOG_ROWS) continue;
    item.diagnostics++;
    // Diagnostics are already redacted by chromeCdpDiagnostics. Retain the
    // existing limited event schema, never CDP request/response bodies.
    const details = Object.fromEntries(Object.entries(event.details)
      .filter(([key]) => ["level","source","text","description","url",
        "lineNumber","columnNumber","method","status","mimeType",
        "type","errorText","canceled","blockedReason","durationMs","values"].includes(key))
      .map(([key, value]) => [key, Array.isArray(value)
        ? value.slice(0,12).map(v=>safeError(v)) :
        typeof value === "string" ? safeError(value) : value]));
    const row = {at:event.at,kind:event.kind,details};
    queueSafe(item, join(item.directory,"diagnostics.jsonl"),row);
    if (event.kind === "console" || event.kind === "log" || event.kind === "exception")
      queueSafe(item,join(item.directory,"console.jsonl"),row);
    if (["request","response","request_failed","request_finished"].includes(event.kind))
      queueSafe(item,join(item.directory,"network.jsonl"),row);
    if (event.kind === "exception" || event.kind === "request_failed" ||
        ((event.kind === "console" || event.kind === "log") &&
          ["error","warning","warn"].includes(String(details.level).toLowerCase())) ||
        (event.kind === "response" && Number(details.status)>=400))
      queueSafe(item,join(item.directory,"errors.jsonl"),row);
  }
}
export function getCdpSessionArchiveStatus(scope: ArchiveScope) {
  return publicStatus(findActive(scope));
}
export async function stopCdpSessionArchive(scope: ArchiveScope, actionTranscript?: object) {
  const item = findActive(scope);
  if (item.status === "saved") return publicStatus(item);
  if (item.status !== "recording" && item.status !== "stopping")
    throw Error("Session archive cannot be stopped again.");
  item.status = "stopping";
  if (item.timer) clearInterval(item.timer);
  if (item.inFlight) await item.inFlight;
  await item.pendingWrites;
  if (item.stopDiagnostics) {
    await item.stopDiagnostics().catch(error => {
      item.problems.push("Diagnostic collection shutdown failed: " + safeError(error));
    });
  }
  item.encoder.stdin.end();
  const exit = await Promise.race([
    item.encoderExit,
    new Promise<{code:number|null;log:string}>(resolve =>
      setTimeout(()=>resolve({code:-1,log:"FFmpeg did not finish within 15 seconds."}),15000)),
  ]);
  if (exit.code !== 0) {
    item.encoder.kill();
    item.problems.push("Video encoding failed: " + safeError(exit.log));
  }
  let mp4Bytes=0;
  try { mp4Bytes=(await stat(join(item.directory,"video.mp4"))).size; }catch{}
  if (mp4Bytes < 256 || mp4Bytes > MAX_VIDEO_BYTES) {
    item.problems.push("MP4 output is missing, incomplete, or oversized.");
  }
  const outcome = exit.code===0 && mp4Bytes>=256 && mp4Bytes<=MAX_VIDEO_BYTES
    ? "saved" : "failed";
  item.status = outcome;
  if (actionTranscript) {
    await writeFile(join(item.directory,"actions.json"),
      JSON.stringify(actionTranscript,null,2),{flag:"wx",mode:0o600});
  }
  const publicManifest = {...publicStatus(item), finishedAt:new Date().toISOString(),
    videoBytes:mp4Bytes, sensitiveVisualContent:true,
    includesAudio:false, includesNetworkBodies:false, includesTypedText:false,
    source:"managed-cdp-exact-tab", retention:"Local; delete manually when no longer required."};
  await writeFile(join(item.directory,"manifest.json"),
    JSON.stringify(publicManifest,null,2),{flag:"wx",mode:0o600});
  const summary = [
    "# SuperAgent CDP session recording",
    "Recording ID: " + item.id,
    "Status: " + item.status,
    "Captured frames: " + item.frames,
    "Dropped frames: " + item.dropped,
    "Recorded commands: " + item.commands,
    "Captured diagnostics: " + item.diagnostics,
    "Video: video.mp4 (960×540, 2 FPS, no audio)",
    "Action transcript: transcript.jsonl, actions.json",
    "Console: console.jsonl | Errors: errors.jsonl | Network metadata: network.jsonl",
    "Combined diagnostics: diagnostics.jsonl",
    "Sensitive contents of visible tabs may appear in the video. Keep the archive private.",
    ...item.problems.map(problem=>"Warning: "+safeError(problem)),
  ].join("\n") + "\n";
  await writeFile(join(item.directory,"README.txt"),summary,{flag:"wx",mode:0o600});
  return publicManifest;
}
export function resetCdpSessionArchivesForTests() {
  for (const item of sessions.values()) {
    if (item.timer) clearInterval(item.timer);
    if (item.status === "recording") { item.encoder.stdin.end(); item.encoder.kill(); }
  }
  sessions.clear();
}
