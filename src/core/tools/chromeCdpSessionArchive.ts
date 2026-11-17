/**
 * Explicit, bounded and local CDP session archives.
 *
 * User opt-in is required for video. Sensitive browser pixels may appear in
 * MP4, so archives are saved under the ACTIVE PROJECT workspace,
 * never in the SuperAgent installation or ~/.superagent-r configuration.
 * No camera/microphone/OS screen capture; only the exact verified managed or Delegate CDP page.
 * Commands and diagnostics are redacted before persistence.
 */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile, appendFile, stat, realpath, lstat, rm } from "node:fs/promises";
import { join, resolve, parse, relative, isAbsolute } from "node:path";
import { getRootConfigDir, getPackageRootDir } from "../config/paths.js";
import { browserActionRecordingStatus, stopBrowserActionRecording,
  readBrowserActionRecording } from "./chromeCdpActionRecorder.js";

const MAX_MS = 10 * 60_000;
export const CDP_RECORDING_PRESETS = Object.freeze({
  compact: { fps: 3, width: 640, height: 360, crf: 32 },
  standard: { fps: 5, width: 960, height: 540, crf: 29 },
  detail: { fps: 5, width: 1280, height: 720, crf: 26 },
});
export type CdpRecordingPreset = keyof typeof CDP_RECORDING_PRESETS;
function recordingPreset(value: unknown): CdpRecordingPreset {
  if (value === undefined) return "standard";
  if (value === "compact" || value === "standard" || value === "detail") return value;
  throw Error("videoPreset must be compact, standard, or detail.");
}
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
  videoPreset?: CdpRecordingPreset;
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
  preset: CdpRecordingPreset;
  profile: Readonly<{fps:number;width:number;height:number;crf:number}>;
  status: "recording" | "stopping" | "saved" | "failed";
  timer?: ReturnType<typeof setInterval>;
  inFlight?: Promise<void>;
  encoder: ChildProcessWithoutNullStreams;
  encoderExit: Promise<{code: number | null; log: string}>;
  frames: number;
  dropped: number;
  /** Bounded retry window for navigation-only CDP screenshot detachments. */
  consecutiveCaptureFailures: number;
  commands: number;
  diagnostics: number;
  problems: string[];
  totalFrameBytes: number;
  lastCaptureAt: number;
  recordId?: string;
  pendingWrites: Promise<void>;
  stopDiagnostics?: () => Promise<void>;
  /** Exactly one finalizer per session; repeated stop calls share the result. */
  finalizePromise?: Promise<ReturnType<typeof publicStatus>>;
};
const sessions = new Map<string, Session>();
const scopeKey = (scope: ArchiveScope) => scope.targetKey + "\0" + scope.actorId;
async function archiveRoot(projectDirectory: string): Promise<string> {
  if (!projectDirectory || !isAbsolute(projectDirectory))
    throw Error("Recording requires an explicit active project directory.");
  const desired = resolve(projectDirectory);
  const outside = (base: string, candidate: string) => {
    const diff = relative(base, candidate);
    return diff !== "" && (diff.startsWith("..") || isAbsolute(diff));
  };
  // Check lexical paths first: the config directory may not exist yet. Never
  // report ENOENT or write to a known internal SuperAgent location.
  const protectedRoots = [getRootConfigDir(),getPackageRootDir()];
  for (const base of protectedRoots) {
    if (!outside(resolve(base), desired))
      throw Error("Recording may not be saved in the SuperAgent runtime/configuration/source directory; select an active external project.");
  }
  const project = await realpath(desired);
  if (project === parse(project).root)
    throw Error("Recording at a filesystem root is prohibited.");
  for (const base of protectedRoots) {
    const forbidden = await realpath(base).catch(() => resolve(base));
    if (!outside(forbidden, project))
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
const safeError = (error: unknown) => {
  // Browser, encoder and filesystem errors may include arbitrary page text,
  // local paths or secrets. Persist categories only; never free-form messages.
  const message = String((error as Error)?.message ?? error);
  if (/ffmpeg|encoder|codec|pipe:/i.test(message)) return "RECORDING_ENCODER_ERROR";
  if (/screenshot|target|detach|websocket|navigation|capture|frame/i.test(message))
    return "RECORDING_CAPTURE_ERROR";
  if (/lease|owner|generation|permission|authorized/i.test(message))
    return "RECORDING_OWNERSHIP_ERROR";
  if (/directory|filesystem|file|write|space|ENOENT|EACCES|EPERM/i.test(message))
    return "RECORDING_STORAGE_ERROR";
  return "RECORDING_OPERATION_ERROR";
};

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
function archiveSource(item: Session): "managed-cdp-exact-tab" | "delegate-cdp-exact-tab" | "native-window-exact-window" {
  return item.scope.targetKey.startsWith("native:") ? "native-window-exact-window" :
    item.scope.targetKey.startsWith("delegate:") ? "delegate-cdp-exact-tab" : "managed-cdp-exact-tab";
}
function publicStatus(item: Session) {
  return { recordingId: item.id,
    status: item.status, startedAt: new Date(item.start).toISOString(),
    elapsedMs: safeCount(Date.now() - item.start), video: true, source:archiveSource(item),
    fps: item.profile.fps, videoPreset:item.preset,
    videoWidth:item.profile.width, videoHeight:item.profile.height,
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
function isTransientCdpCaptureFailure(error: unknown): boolean {
  const message=String((error as Error)?.message??error);
  return /(?:Page\.captureScreenshot|CDP WebSocket|target tab).*?(?:not attached|closed unexpectedly|detached|target closed|cannot find context|navigat)/i.test(message);
}
async function frameTick(item: Session, capture: () => Promise<string>, valid: () => Promise<boolean>) {
  if (item.status !== "recording") return;
  if (Date.now() - item.start >= MAX_MS || item.frames >= item.profile.fps * MAX_MS / 1000) {
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
  item.consecutiveCaptureFailures=0;
  item.totalFrameBytes += frame.length;
  item.lastCaptureAt = Date.now();
}

export async function startCdpSessionArchive(
  scope: ArchiveScope, opts: SessionArchiveOptions,
): Promise<ReturnType<typeof publicStatus>> {
  if (!/^(managed|delegate|native):/.test(scope.targetKey) || !scope.actorId || !scope.generation)
    throw Error("A verified managed/Delegate CDP target or native approved window is required.");
  if (opts.video === false || opts.confirmSensitiveVideo !== true)
    throw Error("MP4 recording is enabled by default and requires confirmSensitiveVideo:true.");
  const previous = sessions.get(scopeKey(scope));
  if (previous && previous.status !== "saved" && previous.status !== "failed")
    throw Error("A recording already exists for this actor/target. Stop it first.");
  if (previous) sessions.delete(scopeKey(scope));
  if ([...sessions.values()].filter(x => x.status === "recording").length >= MAX_SESSIONS)
    throw Error("Too many concurrent recordings.");
  if (!(await opts.checkLease())) throw Error("Target lease is no longer valid.");
  const preset=recordingPreset(opts.videoPreset);
  const profile=CDP_RECORDING_PRESETS[preset];
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
    "-f","image2pipe","-framerate",String(profile.fps),"-vcodec","mjpeg","-i","pipe:0",
    "-vf",`scale=${profile.width}:${profile.height}:force_original_aspect_ratio=decrease,pad=${profile.width}:${profile.height}:(ow-iw)/2:(oh-ih)/2`,
    "-pix_fmt","yuv420p","-c:v","libx264","-preset","ultrafast","-crf",String(profile.crf),
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
    id, scope, directory, start:Date.now(), preset, profile, status:"recording",
    encoder, encoderExit, frames:0,dropped:0,consecutiveCaptureFailures:0,commands:0,diagnostics:0,
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
          const problem=safeError(error);
          item.problems.push(problem);
          queueSafe(item,join(item.directory,"errors.jsonl"),{
            at:new Date().toISOString(),kind:"video_frame_capture_failed",error:problem,
          });
          // Chrome briefly detaches its screenshot surface during navigation.
          // Keep recording on the same verified tab for at most 8 consecutive
          // transient failures (~1.6s at 5 FPS); all other failures stop safely.
          if (isTransientCdpCaptureFailure(error) &&
              ++item.consecutiveCaptureFailures <= 8) return;
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
    item.timer = setInterval(() => { void save(); }, 1000 / item.profile.fps);
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
    ...(failed ? { errorCode:"BROWSER_ACTION_FAILED" } : {}),
    // Never persist selector, typed text, URL, tokens or arbitrary raw outputs.
  };
  queueSafe(item, join(item.directory,"transcript.jsonl"), row);
  if (failed) queueSafe(item,join(item.directory,"errors.jsonl"),row);
}
export function recordCdpSessionDiagnostic(targetKey: string, event: ArchiveDiagnostics) {
  // Console messages, exception descriptions and request URLs are untrusted
  // page data. Never persist their text, even after best-effort regex redaction.
  const kinds = new Set(["console","log","exception","request","response",
    "request_failed","request_finished"]);
  if (!kinds.has(event.kind)) return;
  const input = event.details || {};
  const details: Record<string, string | number | boolean> = {};
  const levels = new Set(["error","warning","warn","info","debug","log","verbose"]);
  if (typeof input.level === "string" && levels.has(input.level.toLowerCase()))
    details.level = input.level.toLowerCase();
  const methods = new Set(["GET","POST","PUT","PATCH","DELETE","HEAD","OPTIONS"]);
  if (typeof input.method === "string" && methods.has(input.method.toUpperCase()))
    details.method = input.method.toUpperCase();
  for (const field of ["status","lineNumber","columnNumber","durationMs"] as const) {
    const value = input[field];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1_000_000)
      details[field] = value;
  }
  if (typeof input.canceled === "boolean") details.canceled = input.canceled;
  details.messageRedacted = true;
  for (const item of sessions.values()) {
    if (item.scope.targetKey !== targetKey || item.status !== "recording" ||
        item.diagnostics >= MAX_LOG_ROWS) continue;
    item.diagnostics++;
    const row = {at:new Date().toISOString(),kind:event.kind,details};
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
  // A tab may close while an operator simultaneously requests stop.
  // Never run two FFmpeg finalizers or create actions.json twice.
  if (!item.finalizePromise)
    item.finalizePromise = finalizeCdpSessionArchive(item, actionTranscript);
  return item.finalizePromise;
}
async function finalizeCdpSessionArchive(item: Session, actionTranscript?: object) {
  if (item.status === "saved") return publicStatus(item);
  if (item.status !== "recording" && item.status !== "stopping")
    throw Error("Session archive cannot be stopped again.");
  item.status = "stopping";
  if (item.timer) clearInterval(item.timer);
  if (item.inFlight) await item.inFlight;
  queueSafe(item,join(item.directory,"transcript.jsonl"),{
    at:new Date().toISOString(),category:"recording_stopped",frameCount:item.frames,
    droppedFrames:item.dropped,
  });
  await item.pendingWrites;
  if (item.stopDiagnostics) {
    await item.stopDiagnostics().catch(error => {
      item.problems.push("Diagnostic collection shutdown failed: " + safeError(error));
    });
  }
  item.encoder.stdin.end();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const exit = await Promise.race([
    item.encoderExit,
    new Promise<{code:number|null;log:string}>(resolve => {
      timeout = setTimeout(()=>resolve({code:-1,log:"FFmpeg did not finish within 15 seconds."}),15000);
      timeout.unref?.();
    }),
  ]);
  if (timeout) clearTimeout(timeout);
  if (exit.code !== 0) {
    item.encoder.kill();
    const problem="Video encoding failed: "+safeError(exit.log);
    item.problems.push(problem);
    queueSafe(item,join(item.directory,"errors.jsonl"),{
      at:new Date().toISOString(),kind:"video_encoder_failed",error:problem,
    });
    await item.pendingWrites;
  }
  let mp4Bytes=0;
  try { mp4Bytes=(await stat(join(item.directory,"video.mp4"))).size; }catch{}
  if (mp4Bytes < 256 || mp4Bytes > MAX_VIDEO_BYTES) {
    item.problems.push("MP4 output is missing, incomplete, or oversized.");
  }
  const outcome = exit.code===0 && mp4Bytes>=256 && mp4Bytes<=MAX_VIDEO_BYTES
    ? "saved" : "failed";
  item.status = outcome;
  const source = actionTranscript && typeof actionTranscript==="object" && !Array.isArray(actionTranscript)
    ? actionTranscript as { events?:unknown; recordingId?:unknown; recordedCount?:unknown }
    : {};
  // Persist an allowlisted and always-present redacted action journal, even if
  // recording ended automatically on lease expiry or the action TTL elapsed.
  const actions = Array.isArray(source.events) ? source.events.slice(0,128).flatMap((value:unknown) => {
    if (!value || typeof value!=="object" || Array.isArray(value)) return [];
    const event=value as Record<string,unknown>;
    if (!Number.isSafeInteger(event.sequence) || typeof event.action!=="string" ||
        !allowedActions.has(event.action)) return [];
    const row: Record<string,unknown> = {
      sequence:event.sequence,action:event.action,status:"dispatched",
      ...(typeof event.at==="number" && Number.isFinite(event.at) ? {at:event.at} : {}),
    };
    if (event.position && typeof event.position==="object") {
      const p=event.position as {x?:unknown;y?:unknown};
      if (typeof p.x==="number" && typeof p.y==="number" &&
          Number.isFinite(p.x) && Number.isFinite(p.y) &&
          Math.abs(p.x)<=100000 && Math.abs(p.y)<=100000)
        row.position={x:p.x,y:p.y};
    }
    for (const digest of ["locatorDigest","pageDigest"]) {
      if (typeof event[digest]==="string" && /^[a-f0-9]{64}$/.test(event[digest]))
        row[digest]=event[digest];
    }
    return [row];
  }) : [];
  await writeFile(join(item.directory,"actions.json"),
    JSON.stringify({source:"redacted_action_journal",recordedCount:actions.length,events:actions},null,2),
    {flag:"wx",mode:0o600});
  const publicManifest = {...publicStatus(item), finishedAt:new Date().toISOString(),
    videoBytes:mp4Bytes, sensitiveVisualContent:true,
    includesAudio:false, includesNetworkBodies:false, includesTypedText:false,
    source:archiveSource(item),
    retention:"Local; delete manually when no longer required."};
  await writeFile(join(item.directory,"manifest.json"),
    JSON.stringify(publicManifest,null,2),{flag:"wx",mode:0o600});
  const summary = [
    "# SuperAgent exact-target session recording",
    "Recording ID: " + item.id,
    "Status: " + item.status,
    "Captured frames: " + item.frames,
    "Dropped frames: " + item.dropped,
    "Recorded commands: " + item.commands,
    "Captured diagnostics: " + item.diagnostics,
    "Video: video.mp4 ("+item.profile.width+"×"+item.profile.height+", "+item.profile.fps+" FPS, no audio)",
    "Action transcript: transcript.jsonl, actions.json",
    "Console: console.jsonl | Errors: errors.jsonl | Network metadata: network.jsonl",
    "Combined diagnostics: diagnostics.jsonl",
    "Sensitive contents of the approved window may appear in the video. Keep the archive private.",
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

/** Native operator-only inventory probe. Do not expose a raw filesystem handle to MCP. */
export function inspectCdpSessionArchiveDirectory(directory: string) {
  const item=[...sessions.values()].find(s=>s.directory===directory);
  return item ? publicStatus(item) : undefined;
}

/** Local authenticated Tray stop: human ownership, never an MCP capability. */
export async function stopCdpSessionArchiveByOperator(directory: string) {
  const item=[...sessions.values()].find(s=>s.directory===directory);
  if (!item) throw Error("Active recording not found in this Core.");
  if (item.status === "saved") return publicStatus(item);
  if (item.status === "failed") throw Error("Recording has already failed.");
  const journal=browserActionRecordingStatus(item.scope.targetKey,item.scope.actorId,item.scope.generation);
  if (journal.active) stopBrowserActionRecording(item.scope.targetKey,item.scope.actorId,item.scope.generation);
  let actions: object | undefined;
  if ("recordingId" in journal && typeof journal.recordingId === "string") {
    try {
      actions=readBrowserActionRecording(item.scope.targetKey,item.scope.actorId,
        item.scope.generation,journal.recordingId);
    } catch { /* A journal may expire before the video recorder is stopped. */ }
  }
  return stopCdpSessionArchive(item.scope,actions);
}
