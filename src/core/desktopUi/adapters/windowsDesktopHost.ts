/**
 * windowsDesktopHost.ts — client for the single native Desktop UI host.
 *
 * The host is one verified WinExe (desktopHostArtifact.ts) that serves both
 * scoped PrintWindow capture and UIAutomation inspection over JSON lines. This
 * module owns process lifetime, strict line framing (2 MB command guard,
 * bounded response lines), the environment-nonce handshake, per-request
 * timeouts, one automatic restart after a crash, idle close, and validation of
 * every response against the requested target identity.
 *
 * Bounded lifetime: every child is spawned with a request cap and wall-clock
 * lifetime (sanitized here, enforced natively). The host announces a planned
 * exit with a typed `rotating` line; this client respawns it and re-issues the
 * pending request exactly once, counts rotations and exposes them through the
 * hook surface. Two rotations in a row mean the host is unusable and the
 * adapter falls back through the unchanged PowerShell paths.
 *
 * Fail closed, never weaken: any protocol, identity or size violation rejects
 * the request and closes the carrier so `windows.ts` can fall back to the
 * existing PowerShell capture worker / UIA carrier / one-shot script. Pure
 * framing and parsing helpers are exported for unit tests that never execute
 * the native binary.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { DesktopUiError } from "../errors.js";
import type { DesktopUiErrorCode } from "../errors.js";
import type {
  AccessibilitySnapshot,
  DesktopBounds,
  DesktopWindow,
  DesktopWindowTarget,
  NativeCapture,
} from "../types.js";
import { normalizeAccessibilityElements } from "./windowsAccessibilityHost.js";
import { boundsEquivalentWithDpi } from "./windowsPreviewWorker.js";
import { locateVerifiedDesktopHost } from "./desktopHostArtifact.js";

/** Core-generated handshake secret passed through the child environment only. */
export const DESKTOP_HOST_NONCE_ENV = "SUPERAGENT_DESKTOP_HOST_NONCE";
export const DESKTOP_HOST_REQUEST_TIMEOUT_MS = 15_000;
export const DESKTOP_HOST_IDLE_CLOSE_MS = 60_000;
/** Grace for buffered stdout to beat the process `exit` event on a rotation. */
const DESKTOP_HOST_EXIT_GRACE_MS = 50;
/** Command lines are tiny; a multi-megabyte command is a framing violation. */
export const DESKTOP_HOST_MAX_COMMAND_CHARS = 2 * 1024 * 1024;
/** Response lines are bounded separately: a full frame is larger than 2 MB. */
export const DESKTOP_HOST_MAX_RESPONSE_CHARS = 12 * 1024 * 1024;
/**
 * Bounded-lifetime protocol. The host reads these environment variables and
 * announces a planned rotation before the request that would exceed either
 * bound; this client forces the sanitized values into every child and absorbs
 * exactly one rotation per request, re-issuing that request so it is never lost.
 */
export const DESKTOP_HOST_MAX_REQUESTS_ENV = "SUPERAGENT_DESKTOP_HOST_MAX_REQUESTS";
export const DESKTOP_HOST_MAX_LIFETIME_MS_ENV = "SUPERAGENT_DESKTOP_HOST_MAX_LIFETIME_MS";
export const DESKTOP_HOST_DEFAULT_MAX_REQUESTS = 500;
export const DESKTOP_HOST_DEFAULT_MAX_LIFETIME_MS = 600_000;
export const DESKTOP_HOST_MAX_REQUESTS_CEILING = 1_000_000;
export const DESKTOP_HOST_MAX_LIFETIME_CEILING_MS = 86_400_000;
/** A second rotation without a served response means the host is unusable. */
export const DESKTOP_HOST_MAX_ROTATIONS_PER_REQUEST = 1;
const MAX_FRAME_BASE64_CHARS = 11_200_000;
const MIN_IMAGE_BYTES = 24;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_RECORDED_RESPONSE_LINES = 4;
const MAX_ELEMENT_RECORDS = 4096;
const MAX_WARNINGS = 8;

/** Why the native host planned its own exit; the client respawns it. */
export type DesktopHostRotationReason = "request-cap" | "lifetime" | "unknown";

/** Bounded lifetime the client forces into every host child. */
export interface DesktopHostBudget {
  /** Commands one host process serves before it announces a rotation. */
  maxRequests: number;
  /** Wall-clock lifetime of one host process before it announces a rotation. */
  maxLifetimeMs: number;
}

/** Minimal child-process surface so tests can inject a scripted fake. */
export interface DesktopHostChild {
  stdin: { write(chunk: string): unknown; end?(): void };
  stdout: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown };
  stderr?: { resume?(): void } | null;
  kill(): boolean;
  on(event: string, listener: (...args: any[]) => void): unknown;
}

export interface DesktopHostMetricHooks {
  /** One validated frame/element response was served by the native host. */
  onFrame?: (kind: "capture" | "inspect") => void;
  /** The host became permanently unavailable and the adapter will fall back. */
  onFallback?: (reason: string) => void;
  /** One automatic restart after a crash was granted. */
  onRestart?: () => void;
  /** The host announced a planned rotation and the client respawned it. */
  onRotation?: (reason: DesktopHostRotationReason) => void;
}

export interface WindowsDesktopHostOptions {
  spawnChild?: (executable: string, env: NodeJS.ProcessEnv) => DesktopHostChild;
  locateArtifact?: () => string | null;
  createNonce?: () => string;
  hooks?: DesktopHostMetricHooks;
  requestTimeoutMs?: number;
  idleCloseMs?: number;
  /** Force the request cap instead of resolving it from the environment. */
  maxRequests?: number;
  /** Force the lifetime bound instead of resolving it from the environment. */
  maxLifetimeMs?: number;
}

type HostReadOutcome =
  | { kind: "line"; line: string }
  | { kind: "rotating"; reason: DesktopHostRotationReason };

interface HostWaiter {
  resolve: (outcome: HostReadOutcome) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function boundedPositiveInteger(value: unknown, fallback: number, ceiling: number): number {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 && value <= ceiling ? value : fallback;
  }
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (!/^[0-9]+$/.test(trimmed)) return fallback;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= ceiling ? parsed : fallback;
}

/**
 * Resolve the bounded-lifetime budget. Explicit options win over the
 * environment so tests and embedding code can force a small cap without
 * mutating process state. Invalid values fall back to the defaults; the host
 * re-validates the sanitized values it receives and fails closed if they are
 * ever malformed.
 */
export function resolveDesktopHostBudget(
  env: NodeJS.ProcessEnv = process.env,
  overrides: { maxRequests?: number; maxLifetimeMs?: number } = {},
): DesktopHostBudget {
  return {
    maxRequests: boundedPositiveInteger(
      overrides.maxRequests ?? env[DESKTOP_HOST_MAX_REQUESTS_ENV],
      DESKTOP_HOST_DEFAULT_MAX_REQUESTS,
      DESKTOP_HOST_MAX_REQUESTS_CEILING,
    ),
    maxLifetimeMs: boundedPositiveInteger(
      overrides.maxLifetimeMs ?? env[DESKTOP_HOST_MAX_LIFETIME_MS_ENV],
      DESKTOP_HOST_DEFAULT_MAX_LIFETIME_MS,
      DESKTOP_HOST_MAX_LIFETIME_CEILING_MS,
    ),
  };
}

/**
 * The host writes its planned-exit line in fixed field order, so a cheap prefix
 * check keeps multi-megabyte frame payloads out of the JSON parser on the hot
 * path. `parseRotationLine` remains the authority for the full shape.
 */
function isLikelyRotationLine(line: string): boolean {
  return line.length <= 512 && line.startsWith('{"type":"rotating"');
}

/** Parse a planned-exit line. Anything that is not a rotation returns null. */
export function parseRotationLine(line: string): DesktopHostRotationReason | null {
  let parsed: any;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || parsed.type !== "rotating") return null;
  if (parsed.reason === "request-cap") return "request-cap";
  if (parsed.reason === "lifetime") return "lifetime";
  return "unknown";
}

/**
 * A typed startup refusal (for example ELEVATED_TOKEN or
 * PRIVILEGE_HARDENING_FAILED) arrives instead of the ready line. Identify it so
 * the carrier can fail permanently with the host's own code instead of
 * retrying into a process that refuses to serve.
 */
export function parseHostErrorCode(line: string): string | null {
  if (line.length > 4096 || !line.startsWith('{"type":"error"')) return null;
  try {
    const parsed = JSON.parse(line);
    return parsed && typeof parsed.code === "string" ? parsed.code : null;
  } catch {
    return null;
  }
}

/**
 * A response-shape violation (as opposed to an identity refusal) makes the
 * carrier untrustworthy, so the caller closes and restarts it. Identity
 * refusals are normal when a window moves and must not burn the restart budget.
 */
function protocolError(code: DesktopUiErrorCode, message: string): DesktopUiError {
  return new DesktopUiError(code, message, { hostProtocol: true });
}

function boundsFromHost(value: any): DesktopBounds {
  if (
    !value ||
    typeof value !== "object" ||
    !isFiniteNumber(value.x) ||
    !isFiniteNumber(value.y) ||
    !isFiniteNumber(value.width) ||
    !isFiniteNumber(value.height) ||
    value.width <= 0 ||
    value.height <= 0
  ) {
    throw protocolError("PROCESS_FAILED", "Desktop host returned invalid window bounds.");
  }
  return { x: value.x, y: value.y, width: value.width, height: value.height };
}

function windowFromHost(value: any): DesktopWindow {
  const bounds = boundsFromHost(value?.bounds);
  if (
    !value ||
    typeof value !== "object" ||
    !isFiniteNumber(value.pid) ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    typeof value.nativeId !== "string" ||
    !/^[0-9]+$/.test(value.nativeId)
  ) {
    throw protocolError("PROCESS_FAILED", "Desktop host returned an invalid window descriptor.");
  }
  return {
    pid: value.pid,
    nativeId: value.nativeId,
    title: typeof value.title === "string" ? value.title : "",
    active: value.active === true,
    ...(isFiniteNumber(value.scaleFactor) && value.scaleFactor > 0
      ? { scaleFactor: value.scaleFactor }
      : {}),
    bounds,
  };
}

/**
 * Split a raw chunk buffer into complete trimmed lines. The caller keeps `rest`
 * between chunks. Empty control lines are dropped; every non-empty line is
 * preserved in order.
 */
export function extractHostLines(buffer: string): { lines: string[]; rest: string } {
  const lines: string[] = [];
  let rest = buffer;
  for (;;) {
    const end = rest.indexOf("\n");
    if (end < 0) break;
    const line = rest.slice(0, end).trim();
    rest = rest.slice(end + 1);
    if (line.length > 0) lines.push(line);
  }
  return { lines, rest };
}

/**
 * Validate the `ready` handshake. The echoed nonce must exactly match the Core
 * secret that was passed through the child environment; anything else is fatal
 * (no restart), because it means the process on the other end is not ours.
 */
export function validateReadyLine(line: string, expectedNonce: string): void {
  let ready: any;
  try {
    ready = JSON.parse(line);
  } catch {
    throw new DesktopUiError("PROCESS_FAILED", "Desktop host ready line is not valid JSON.");
  }
  if (!ready || ready.type !== "ready") {
    throw new DesktopUiError("PROCESS_FAILED", "Desktop host did not announce readiness.");
  }
  if (typeof expectedNonce !== "string" || expectedNonce.length < 16) {
    throw new DesktopUiError("PROCESS_FAILED", "Desktop host nonce was not provisioned.");
  }
  if (typeof ready.nonce !== "string" || ready.nonce !== expectedNonce) {
    throw new DesktopUiError("PROCESS_FAILED", "Desktop host nonce mismatch.");
  }
}

function parseResponse(line: string, failure: DesktopUiError): any {
  if (line.length < 2 || line.length > DESKTOP_HOST_MAX_RESPONSE_CHARS) {
    throw protocolError(failure.code, failure.message);
  }
  let response: any;
  try {
    response = JSON.parse(line);
  } catch {
    throw protocolError(failure.code, `${failure.message} The response was not valid JSON.`);
  }
  if (!response || typeof response !== "object") throw protocolError(failure.code, failure.message);
  if (response.type === "error") {
    throw new DesktopUiError(
      failure.code,
      `${failure.message} The native host refused the request (${typeof response.code === "string" ? response.code : "UNKNOWN"}).`,
    );
  }
  return response;
}

/**
 * Validate one `frame` response. The image must be a bounded PNG and the
 * reported window must still be the requested PID/HWND; titles are reported,
 * never pinned, because applications legitimately rewrite them.
 */
export function parseFrameResponse(line: string, target: DesktopWindowTarget): NativeCapture {
  const failure = new DesktopUiError("SCREENSHOT_UNAVAILABLE", "Native desktop host capture was rejected.");
  const response = parseResponse(line, failure);
  if (response.type !== "frame") throw protocolError("SCREENSHOT_UNAVAILABLE", failure.message);
  const encoded = response.png;
  if (
    typeof encoded !== "string" ||
    encoded.length < 32 ||
    encoded.length > MAX_FRAME_BASE64_CHARS ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
  ) {
    throw protocolError("SCREENSHOT_UNAVAILABLE", "Native desktop host returned an invalid frame payload.");
  }
  const image = Buffer.from(encoded, "base64");
  if (image.length < MIN_IMAGE_BYTES || image.length > MAX_IMAGE_BYTES) {
    throw protocolError("SCREENSHOT_UNAVAILABLE", "Native desktop host frame is outside size bounds.");
  }
  if (!image.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw protocolError("SCREENSHOT_UNAVAILABLE", "Native desktop host frame is not a PNG image.");
  }
  const targetWindow = windowFromHost(response.window);
  if (targetWindow.pid !== target.pid) throw failure;
  if (typeof target.nativeId === "string" && targetWindow.nativeId !== target.nativeId) throw failure;
  return { image, capturedAt: new Date().toISOString(), targetWindow };
}

/**
 * Validate one `elements` response and normalize it with the same authority the
 * PowerShell carriers use. When a reference capture is supplied, the reported
 * geometry must be DPI-equivalent (2 px tolerance, both scaling directions) to
 * the captured frame so capture and inspection can never describe two windows.
 */
export function parseElementsResponse(
  line: string,
  target: DesktopWindowTarget,
  reference?: Pick<NativeCapture, "targetWindow">,
): AccessibilitySnapshot {
  const failure = new DesktopUiError("ACCESSIBILITY_UNAVAILABLE", "Native desktop host inspection was rejected.");
  const response = parseResponse(line, failure);
  if (response.type !== "elements") throw protocolError("ACCESSIBILITY_UNAVAILABLE", failure.message);
  if (!Array.isArray(response.elements) || response.elements.length > MAX_ELEMENT_RECORDS) {
    throw protocolError("ACCESSIBILITY_UNAVAILABLE", "Native desktop host returned an invalid element list.");
  }
  const window = windowFromHost(response.window);
  if (window.pid !== target.pid) throw failure;
  if (typeof target.nativeId === "string" && window.nativeId !== target.nativeId) throw failure;
  if (reference) {
    if (reference.targetWindow.pid !== window.pid || reference.targetWindow.nativeId !== window.nativeId) {
      throw failure;
    }
    if (!boundsEquivalentWithDpi(window.bounds, reference.targetWindow.bounds, window.scaleFactor)) {
      throw failure;
    }
  }
  const warnings = Array.isArray(response.warnings)
    ? response.warnings.filter((warning: unknown): warning is string => typeof warning === "string").slice(0, MAX_WARNINGS)
    : undefined;
  return {
    window,
    elements: normalizeAccessibilityElements(response.elements),
    ...(warnings && warnings.length > 0 ? { warnings } : {}),
  };
}

function defaultSpawnChild(executable: string, env: NodeJS.ProcessEnv): DesktopHostChild {
  return spawn(executable, [], {
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env,
  }) as unknown as DesktopHostChild;
}

function defaultCreateNonce(): string {
  return randomBytes(16).toString("hex");
}

/**
 * One shared native-host carrier. Requests are serialized (the protocol serves
 * one command at a time); a crash earns exactly one automatic restart, after
 * which the carrier reports itself permanently unavailable so callers fall back
 * without paying spawn time on every perception attempt.
 */
export class WindowsDesktopHost {
  private readonly executablePath: string;
  private readonly options: WindowsDesktopHostOptions;
  private readonly budget: DesktopHostBudget;
  private child: DesktopHostChild | null = null;
  private buffer = "";
  private waiter: HostWaiter | null = null;
  private queue: string[] = [];
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private starting: Promise<void> | null = null;
  private busy = false;
  private restartsRemaining = 1;
  private permanentlyFailed = false;
  private rotations = 0;
  private served = 0;

  constructor(executablePath: string, options: WindowsDesktopHostOptions = {}) {
    this.executablePath = executablePath;
    this.options = options;
    this.budget = resolveDesktopHostBudget(process.env, options);
  }

  /** True while the host is believed usable (never a permission decision). */
  get available(): boolean {
    return !this.permanentlyFailed;
  }

  /** Planned host rotations this carrier absorbed without losing a request. */
  get rotationCount(): number {
    return this.rotations;
  }

  /** Responses successfully served to callers by the native host. */
  get servedRequestCount(): number {
    return this.served;
  }

  /** The bounded lifetime forced into every host child. */
  get lifetimeBudget(): DesktopHostBudget {
    return { ...this.budget };
  }

  async capture(target: DesktopWindowTarget): Promise<NativeCapture> {
    this.requireUsable();
    if (!Number.isSafeInteger(target.pid) || target.pid <= 0) {
      throw new DesktopUiError("TARGET_NOT_FOUND", "Native desktop host capture requires a positive integer PID.");
    }
    if (typeof target.nativeId !== "string" || !/^[0-9]+$/.test(target.nativeId)) {
      throw new DesktopUiError("TARGET_NOT_FOUND", "Native desktop host capture requires a decimal HWND string.");
    }
    const line = await this.request({ cmd: "capture", pid: target.pid, hwnd: target.nativeId });
    let capture: NativeCapture;
    try {
      capture = parseFrameResponse(line, target);
    } catch (error) {
      this.rejectResponse(error);
      throw error;
    }
    this.served += 1;
    this.options.hooks?.onFrame?.("capture");
    return capture;
  }

  async inspect(
    target: DesktopWindowTarget,
    reference?: Pick<NativeCapture, "targetWindow">,
  ): Promise<AccessibilitySnapshot> {
    this.requireUsable();
    if (!Number.isSafeInteger(target.pid) || target.pid <= 0) {
      throw new DesktopUiError("TARGET_NOT_FOUND", "Native desktop host inspection requires a positive integer PID.");
    }
    const nativeId = target.nativeId ?? reference?.targetWindow.nativeId;
    if (typeof nativeId !== "string" || !/^[0-9]+$/.test(nativeId)) {
      throw new DesktopUiError("TARGET_NOT_FOUND", "Native desktop host inspection requires a decimal HWND string.");
    }
    const line = await this.request({ cmd: "inspect", pid: target.pid, hwnd: nativeId });
    let snapshot: AccessibilitySnapshot;
    try {
      snapshot = parseElementsResponse(line, { ...target, nativeId }, reference);
    } catch (error) {
      this.rejectResponse(error);
      throw error;
    }
    this.served += 1;
    this.options.hooks?.onFrame?.("inspect");
    return snapshot;
  }

  /** Release the carrier. Safe to call more than once; prevents respawn. */
  close(): void {
    this.permanentlyFailed = true;
    this.releaseChild();
  }

  private requireUsable(): void {
    if (this.permanentlyFailed) {
      throw new DesktopUiError("DESKTOP_UI_UNAVAILABLE", "Native desktop host is unavailable.");
    }
  }

  private async request(payload: Record<string, unknown>): Promise<string> {
    if (this.busy) {
      throw new DesktopUiError("DESKTOP_UI_UNAVAILABLE", "Native desktop host is already serving a request.");
    }
    this.busy = true;
    this.clearIdleTimer();
    try {
      const command = JSON.stringify(payload);
      if (command.length > DESKTOP_HOST_MAX_COMMAND_CHARS) {
        this.releaseChild(true);
        throw new DesktopUiError("INVALID_ACTION", "Native desktop host command exceeded the 2 MB line bound.");
      }
      // One attempt, plus exactly one re-issue after a planned rotation, so a
      // request is never lost when the host reaches its cap or lifetime.
      for (let attempt = 1; attempt <= 1 + DESKTOP_HOST_MAX_ROTATIONS_PER_REQUEST; attempt++) {
        await this.ensureStarted();
        // Register the receiver before writing: a rotation line can be delivered
        // before the command write returns, and it must not be lost.
        const pending = this.readLine();
        try {
          this.writeLine(command);
        } catch (error) {
          // writeLine released the carrier, which rejects the waiter; consume it
          // so the original transport error is the one the caller sees.
          pending.catch(() => undefined);
          throw error;
        }
        const outcome = await pending;
        if (outcome.kind === "rotating") {
          // handleRotation already tore the carrier down cleanly; the next
          // attempt spawns the replacement and re-issues this exact command.
          continue;
        }
        if (outcome.line.length > DESKTOP_HOST_MAX_RESPONSE_CHARS) {
          this.releaseChild(true);
          throw new DesktopUiError("PROCESS_FAILED", "Native desktop host exceeded the response line bound.");
        }
        return outcome.line;
      }
      this.failPermanently("Native desktop host rotated twice without serving the request.");
      throw new DesktopUiError("PROCESS_FAILED", "Native desktop host rotated twice without serving the request.");
    } catch (error) {
      throw error instanceof DesktopUiError
        ? error
        : new DesktopUiError("PROCESS_FAILED", "Native desktop host request failed.");
    } finally {
      this.busy = false;
      // Keep the receiver empty so a late line cannot serve a future request.
      this.queue.length = 0;
      this.armIdleTimer();
    }
  }

  private async ensureStarted(): Promise<void> {
    if (this.child) return;
    this.requireUsable();
    if (this.starting) return this.starting;
    const starting = this.startChild();
    this.starting = starting;
    try {
      await starting;
    } finally {
      this.starting = null;
    }
  }

  private async startChild(): Promise<void> {
    const createNonce = this.options.createNonce ?? defaultCreateNonce;
    const spawnChild = this.options.spawnChild ?? defaultSpawnChild;
    const nonce = createNonce();
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      [DESKTOP_HOST_NONCE_ENV]: nonce,
      // Always send sanitized bounds: a malformed inherited value must never be
      // what the native host validates, and the client knows what it will absorb.
      [DESKTOP_HOST_MAX_REQUESTS_ENV]: String(this.budget.maxRequests),
      [DESKTOP_HOST_MAX_LIFETIME_MS_ENV]: String(this.budget.maxLifetimeMs),
    };
    let child: DesktopHostChild;
    try {
      child = spawnChild(this.executablePath, env);
    } catch {
      this.failPermanently("Native desktop host could not be spawned.");
      throw new DesktopUiError("DESKTOP_UI_UNAVAILABLE", "Native desktop host could not be spawned.");
    }
    this.child = child;
    this.buffer = "";
    this.queue.length = 0;
    try {
      child.stderr?.resume?.();
    } catch {
      /* stderr is drained only to keep the pipe empty; it is never logged. */
    }
    try {
      // A host that rotates while a command is pending can leave the stdin pipe
      // closed; an unhandled EPIPE on stdin would otherwise take down the Core.
      (child.stdin as { on?: (event: string, listener: (...args: any[]) => void) => unknown }).on?.(
        "error",
        () => undefined,
      );
    } catch {
      /* injected doubles may expose a non-evented stdin */
    }
    child.stdout.on("data", (chunk: Buffer | string) => this.onData(child, chunk));
    child.on("error", () => this.onTransportFailure(child));
    // A planned rotation writes its line and then exits, and Node can emit
    // `exit` before the already-buffered stdout chunk. Defer the crash decision
    // by one short grace so the rotation line always wins.
    child.on("exit", () => this.onChildExit(child));
    let ready: HostReadOutcome;
    try {
      ready = await this.readLine();
    } catch (error) {
      if (this.child === child) this.releaseChild(true);
      throw error instanceof DesktopUiError
        ? error
        : new DesktopUiError("PROCESS_FAILED", "Native desktop host never became ready.");
    }
    if (ready.kind !== "line") {
      // A planned exit before the handshake proves the configured budget is
      // unusable; retrying would only spawn another host that rotates again.
      this.failPermanently("Native desktop host rotated before the handshake completed.");
      throw new DesktopUiError("PROCESS_FAILED", "Native desktop host rotated before the handshake completed.");
    }
    const startupErrorCode = parseHostErrorCode(ready.line);
    if (startupErrorCode) {
      // ELEVATED_TOKEN / PRIVILEGE_HARDENING_FAILED / TOKEN_UNAVAILABLE: the host
      // refused to run. Never restart into it; surfacing the code keeps the
      // refusal auditable while the adapter falls back.
      this.failPermanently(`Native desktop host refused to start (${startupErrorCode}).`);
      throw new DesktopUiError(
        "DESKTOP_UI_UNAVAILABLE",
        `Native desktop host refused to start (${startupErrorCode}).`,
      );
    }
    try {
      validateReadyLine(ready.line, nonce);
    } catch (error) {
      // A nonce mismatch means this is not our process; never restart into it.
      this.failPermanently("Native desktop host handshake was rejected.");
      throw error;
    }
  }

  private onData(child: DesktopHostChild, chunk: Buffer | string): void {
    if (this.child !== child) return;
    this.buffer += chunk.toString();
    if (this.buffer.length > DESKTOP_HOST_MAX_RESPONSE_CHARS) {
      this.onTransportFailure(child);
      return;
    }
    const split = extractHostLines(this.buffer);
    this.buffer = split.rest;
    for (const line of split.lines) {
      if (isLikelyRotationLine(line)) {
        const reason = parseRotationLine(line);
        if (reason !== null) {
          this.handleRotation(child, reason);
          return;
        }
      }
      if (this.waiter) {
        const waiter = this.waiter;
        this.waiter = null;
        clearTimeout(waiter.timer);
        waiter.resolve({ kind: "line", line });
      } else if (this.queue.length < MAX_RECORDED_RESPONSE_LINES) {
        this.queue.push(line);
      } else {
        this.onTransportFailure(child);
        return;
      }
    }
  }

  /**
   * The host announced a planned exit. Tear the carrier down without spending
   * the crash-restart budget, count the rotation, and hand the pending request
   * back to `request` so it re-issues on the replacement host.
   */
  private handleRotation(child: DesktopHostChild, reason: DesktopHostRotationReason): void {
    if (this.child !== child) return;
    this.rotations += 1;
    const waiter = this.waiter;
    this.waiter = null;
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve({ kind: "rotating", reason });
    }
    this.releaseChild(false);
    this.options.hooks?.onRotation?.(reason);
  }

  private writeLine(line: string): void {
    const child = this.child;
    if (!child) throw new DesktopUiError("DESKTOP_UI_UNAVAILABLE", "Native desktop host is not running.");
    try {
      child.stdin.write(`${line}\n`);
    } catch {
      this.releaseChild(true);
      throw new DesktopUiError("PROCESS_FAILED", "Native desktop host stopped accepting commands.");
    }
  }

  private readLine(): Promise<HostReadOutcome> {
    if (this.queue.length > 0) return Promise.resolve({ kind: "line", line: this.queue.shift()! });
    if (!this.child) {
      return Promise.reject(new DesktopUiError("PROCESS_FAILED", "Native desktop host is not running."));
    }
    return new Promise<HostReadOutcome>((resolve, reject) => {
      const timer = setTimeout(
        () => this.onTransportFailure(this.child),
        this.options.requestTimeoutMs ?? DESKTOP_HOST_REQUEST_TIMEOUT_MS,
      );
      timer.unref?.();
      this.waiter = { resolve, reject, timer };
    });
  }

  private onTransportFailure(child: DesktopHostChild | null): void {
    if (child !== null && this.child !== child) return;
    if (!this.child) return;
    this.releaseChild(true);
  }

  private onChildExit(child: DesktopHostChild): void {
    if (this.child !== child) return;
    const timer = setTimeout(() => {
      if (this.child === child) this.onTransportFailure(child);
    }, DESKTOP_HOST_EXIT_GRACE_MS);
    timer.unref?.();
  }

  /** Close a carrier whose response shape violated the protocol. */
  private rejectResponse(error: unknown): void {
    if (error instanceof DesktopUiError && error.details?.hostProtocol === true) {
      this.releaseChild(true);
    }
  }

  /**
   * Tear down the live child. `crash` consumes the single restart budget and
   * rejects the waiting request; a clean close never does.
   */
  private releaseChild(crash = false): void {
    const child = this.child;
    this.child = null;
    this.buffer = "";
    this.queue.length = 0;
    this.clearIdleTimer();
    const waiter = this.waiter;
    this.waiter = null;
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.reject(new DesktopUiError("PROCESS_FAILED", "Native desktop host stopped serving the request."));
    }
    if (child) {
      try {
        child.kill();
      } catch {
        /* process already gone */
      }
    }
    if (crash) {
      if (this.restartsRemaining > 0) {
        this.restartsRemaining -= 1;
        this.options.hooks?.onRestart?.();
      } else {
        this.failPermanently("Native desktop host crashed twice; falling back.");
      }
    }
  }

  private failPermanently(reason: string): void {
    this.permanentlyFailed = true;
    this.options.hooks?.onFallback?.(reason);
    const child = this.child;
    this.child = null;
    this.buffer = "";
    this.queue.length = 0;
    this.clearIdleTimer();
    const waiter = this.waiter;
    this.waiter = null;
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.reject(new DesktopUiError("PROCESS_FAILED", "Native desktop host is unavailable."));
    }
    if (child) {
      try {
        child.kill();
      } catch {
        /* process already gone */
      }
    }
  }

  private armIdleTimer(): void {
    this.clearIdleTimer();
    if (!this.child || this.permanentlyFailed) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.releaseChild(false);
    }, this.options.idleCloseMs ?? DESKTOP_HOST_IDLE_CLOSE_MS);
    this.idleTimer.unref?.();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}

/**
 * Resolve the fixed verified artifact (never a caller path) and construct a
 * client. Returns `null` when the optional artifact is absent or invalid so the
 * Windows adapter keeps its existing carriers unchanged.
 */
export function createWindowsDesktopHost(options: WindowsDesktopHostOptions = {}): WindowsDesktopHost | null {
  if (process.platform !== "win32") return null;
  let executable: string | null;
  try {
    executable = (options.locateArtifact ?? locateVerifiedDesktopHost)();
  } catch {
    return null;
  }
  if (!executable) return null;
  return new WindowsDesktopHost(executable, options);
}

let sharedHost: WindowsDesktopHost | null = null;
let sharedHostResolved = false;

/**
 * Process-wide carrier shared by every Windows adapter instance. One native host
 * per Core, exactly like the persistent PowerShell carriers it fronts.
 */
export function getSharedWindowsDesktopHost(): WindowsDesktopHost | null {
  if (process.platform !== "win32") return null;
  if (!sharedHostResolved) {
    sharedHostResolved = true;
    sharedHost = createWindowsDesktopHost();
  }
  return sharedHost;
}

/** Test seam: drop the shared carrier so a later call re-resolves the artifact. */
export function resetSharedWindowsDesktopHostForTests(): void {
  sharedHost?.close();
  sharedHost = null;
  sharedHostResolved = false;
}
