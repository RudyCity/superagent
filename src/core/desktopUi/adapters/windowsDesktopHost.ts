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
/** Command lines are tiny; a multi-megabyte command is a framing violation. */
export const DESKTOP_HOST_MAX_COMMAND_CHARS = 2 * 1024 * 1024;
/** Response lines are bounded separately: a full frame is larger than 2 MB. */
export const DESKTOP_HOST_MAX_RESPONSE_CHARS = 12 * 1024 * 1024;
const MAX_FRAME_BASE64_CHARS = 11_200_000;
const MIN_IMAGE_BYTES = 24;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_RECORDED_RESPONSE_LINES = 4;
const MAX_ELEMENT_RECORDS = 4096;
const MAX_WARNINGS = 8;

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
}

export interface WindowsDesktopHostOptions {
  spawnChild?: (executable: string, env: NodeJS.ProcessEnv) => DesktopHostChild;
  locateArtifact?: () => string | null;
  createNonce?: () => string;
  hooks?: DesktopHostMetricHooks;
  requestTimeoutMs?: number;
  idleCloseMs?: number;
}

interface HostWaiter {
  resolve: (line: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
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
  private child: DesktopHostChild | null = null;
  private buffer = "";
  private waiter: HostWaiter | null = null;
  private queue: string[] = [];
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private starting: Promise<void> | null = null;
  private busy = false;
  private restartsRemaining = 1;
  private permanentlyFailed = false;

  constructor(executablePath: string, options: WindowsDesktopHostOptions = {}) {
    this.executablePath = executablePath;
    this.options = options;
  }

  /** True while the host is believed usable (never a permission decision). */
  get available(): boolean {
    return !this.permanentlyFailed;
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
      await this.ensureStarted();
      const command = JSON.stringify(payload);
      if (command.length > DESKTOP_HOST_MAX_COMMAND_CHARS) {
        this.releaseChild(true);
        throw new DesktopUiError("INVALID_ACTION", "Native desktop host command exceeded the 2 MB line bound.");
      }
      this.writeLine(command);
      const line = await this.readLine();
      if (line.length > DESKTOP_HOST_MAX_RESPONSE_CHARS) {
        this.releaseChild(true);
        throw new DesktopUiError("PROCESS_FAILED", "Native desktop host exceeded the response line bound.");
      }
      return line;
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
    const env: NodeJS.ProcessEnv = { ...process.env, [DESKTOP_HOST_NONCE_ENV]: nonce };
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
    child.stdout.on("data", (chunk: Buffer | string) => this.onData(child, chunk));
    child.on("error", () => this.onTransportFailure(child));
    child.on("exit", () => this.onTransportFailure(child));
    let readyLine: string;
    try {
      readyLine = await this.readLine();
    } catch (error) {
      if (this.child === child) this.releaseChild(true);
      throw error instanceof DesktopUiError
        ? error
        : new DesktopUiError("PROCESS_FAILED", "Native desktop host never became ready.");
    }
    try {
      validateReadyLine(readyLine, nonce);
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
      if (this.waiter) {
        const waiter = this.waiter;
        this.waiter = null;
        clearTimeout(waiter.timer);
        waiter.resolve(line);
      } else if (this.queue.length < MAX_RECORDED_RESPONSE_LINES) {
        this.queue.push(line);
      } else {
        this.onTransportFailure(child);
        return;
      }
    }
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

  private readLine(): Promise<string> {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift()!);
    if (!this.child) {
      return Promise.reject(new DesktopUiError("PROCESS_FAILED", "Native desktop host is not running."));
    }
    return new Promise<string>((resolve, reject) => {
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
