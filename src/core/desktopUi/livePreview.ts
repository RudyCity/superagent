/**
 * Private, bounded native-window preview for the authenticated local Tray.
 * No remote transport, desktop-wide capture, implicit control, recording, or
 * unattended start. The native adapter owns platform-specific permissions.
 */
import crypto from "node:crypto";
import { createNativeDesktopUiAdapter } from "./nativeAdapter.js";
import { listDiscoveredWindows, MAX_WINDOW_DISCOVERY_LIMIT, requireFreshWindowTarget } from "./discovery.js";
import { readPngSize, sha256 } from "./png.js";
import {
  encodeJpegPreview, MAX_PREVIEW_SOURCE_BYTES, MAX_PREVIEW_SOURCE_PIXELS, validateJpegSettings,
} from "./livePreviewEncoding.js";
import { DesktopUiError } from "./errors.js";
import { WGC_HELPER_BACKEND } from "./adapters/windowsWgcArtifact.js";
import type {
  DesktopDiscoveredWindow, DesktopUiAdapter, DesktopWindowCaptureSource, NativeCapture,
} from "./types.js";

export const PRIVATE_PREVIEW_TTL_MS = 5 * 60_000;
export const PRIVATE_PREVIEW_INTERVAL_MS = 250;
export const PRIVATE_PREVIEW_MAX_PNG_BYTES = 2 * 1024 * 1024;

interface PreviewSession {
  readonly token: string;
  readonly window: DesktopDiscoveredWindow;
  readonly adapter: DesktopUiAdapter;
  readonly source?: DesktopWindowCaptureSource;
  readonly expiresAt: number;
  nextFrameAt: number;
  capturing: boolean;
  lastRendered?: { hash: string; profile: string };
}

function sameWindow(a: DesktopDiscoveredWindow, b: DesktopDiscoveredWindow): boolean {
  return a.pid === b.pid && a.nativeId === b.nativeId &&
    a.title === b.title && a.application === b.application &&
    a.bounds.x === b.bounds.x && a.bounds.y === b.bounds.y &&
    a.bounds.width === b.bounds.width && a.bounds.height === b.bounds.height;
}

function matchesCapture(window: DesktopDiscoveredWindow, capture: NativeCapture): boolean {
  const actual = capture.targetWindow;
  return actual.pid === window.pid && actual.nativeId === window.nativeId &&
    actual.title === window.title &&
    actual.bounds.x === window.bounds.x && actual.bounds.y === window.bounds.y &&
    actual.bounds.width === window.bounds.width && actual.bounds.height === window.bounds.height;
}

function assertWindowPixelBounds(
  target: DesktopDiscoveredWindow,
  width: number,
  height: number,
  source?: DesktopWindowCaptureSource,
): void {
  const physicalWidth = target.bounds.width;
  const physicalHeight = target.bounds.height;
  if (source?.backend === "win32-persistent-exact-hwnd") {
    // The native worker constructs the bitmap from GetWindowRect; no
    // retina/scale ambiguity is possible on this path.
    if (width !== physicalWidth || height !== physicalHeight) {
      throw new DesktopUiError("STALE_SCREENSHOT", "Native bitmap dimensions do not match the approved HWND.");
    }
    return;
  }
  if (source?.backend === WGC_HELPER_BACKEND) {
    // WGC returns compositor content without Win32 invisible borders.
    // Accept a narrowly bounded, proportional exact-HWND crop only.
    const x = width / physicalWidth;
    const y = height / physicalHeight;
    if (!Number.isFinite(x) || !Number.isFinite(y) ||
        x < 0.90 || x > 1.10 || y < 0.90 || y > 1.10 ||
        Math.abs(x - y) > 0.08) {
      throw new DesktopUiError("STALE_SCREENSHOT", "WGC content dimensions differ from approved window.");
    }
    return;
  }
  // macOS can yield 1x/2x/3x screenshots from a logical AX window; Linux
  // screenshots should normally be 1x. Reject unexpected crops or unrelated
  // desktop-sized images rather than ever treating them as approved windows.
  const x = width / physicalWidth;
  const y = height / physicalHeight;
  if (!Number.isFinite(x) || !Number.isFinite(y) ||
      x < 0.9 || y < 0.9 || x > 3.1 || y > 3.1 || Math.abs(x - y) > 0.08) {
    throw new DesktopUiError("STALE_SCREENSHOT", "Native frame dimensions differ from the approved application window.");
  }
}

function assertKeys(raw: unknown, keys: string[]): asserts raw is Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) ||
      Object.keys(raw).some(key => !keys.includes(key)) ||
      Object.keys(raw).length !== keys.length) {
    throw new DesktopUiError("INVALID_ACTION", "Invalid private preview request.");
  }
}

interface PreviewFrameRequest {
  token: string;
  codec: "png" | "jpeg";
  knownHash?: string;
  maxWidth?: number;
  quality?: number;
}

function requireFrameRequest(raw: unknown): PreviewFrameRequest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new DesktopUiError("INVALID_ACTION", "Invalid preview frame request.");
  }
  const body = raw as Record<string, unknown>;
  if (Object.keys(body).some(key =>
        !["token", "codec", "knownHash", "maxWidth", "quality"].includes(key)) ||
      typeof body.token !== "string" ||
      (body.codec !== undefined && !["png", "jpeg"].includes(String(body.codec))) ||
      (body.knownHash !== undefined &&
       (typeof body.knownHash !== "string" || !/^[a-f0-9]{64}$/.test(body.knownHash)))) {
    throw new DesktopUiError("INVALID_ACTION", "Invalid preview frame options.");
  }
  const codec = (body.codec ?? "png") as "png" | "jpeg";
  if (codec === "png" && (body.quality !== undefined || body.maxWidth !== undefined)) {
    throw new DesktopUiError("INVALID_ACTION", "JPEG options require JPEG encoding.");
  }
  if (codec === "jpeg") validateJpegSettings(body);
  return {
    token: body.token,
    codec,
    ...(body.knownHash !== undefined ? { knownHash: body.knownHash as string } : {}),
    ...(body.maxWidth !== undefined ? { maxWidth: Number(body.maxWidth) } : {}),
    ...(body.quality !== undefined ? { quality: Number(body.quality) } : {}),
  };
}

export class NativeWindowPreviewManager {
  private active: PreviewSession | null = null;
  private starting = false;
  constructor(
    private readonly createAdapter: () => DesktopUiAdapter = createNativeDesktopUiAdapter,
    private readonly now: () => number = Date.now,
  ) {}

  async discover() {
    const adapter = this.createAdapter();
    const capability = await adapter.probe();
    if (!capability.available || !capability.screenshot) {
      throw new DesktopUiError("SCREENSHOT_UNAVAILABLE", "Native window capture is unavailable or not authorized by the OS.");
    }
    const result = await listDiscoveredWindows(adapter, MAX_WINDOW_DISCOVERY_LIMIT);
    return { platform: adapter.platform, windows: result.windows, truncated: result.truncated };
  }

  async start(raw: unknown) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new DesktopUiError("INVALID_ACTION", "Invalid window preview request.");
    }
    const request = raw as Record<string, unknown>;
    const approvedFields = ["expectedTitle", "expectedApplication", "expectedBounds"];
    const hasPinnedApproval = approvedFields.some(key => Object.hasOwn(request, key));
    assertKeys(request, hasPinnedApproval
      ? ["pid", "nativeId", "consent", ...approvedFields]
      : ["pid", "nativeId", "consent"]);
    if (request.consent !== true || !Number.isSafeInteger(request.pid) ||
        Number(request.pid) <= 0 || typeof request.nativeId !== "string" ||
        request.nativeId.length < 1 || request.nativeId.length > 256) {
      throw new DesktopUiError("INVALID_ACTION", "Explicit consent and an exact native window are required.");
    }
    if (this.active && this.active.expiresAt <= this.now()) {
      this.active.source?.close();
      this.active = null;
    }
    if (this.starting || this.active) {
      throw new DesktopUiError("INVALID_ACTION", "A private preview is already active. Stop it before switching windows.");
    }
    this.starting = true;
    try {
      const adapter = this.createAdapter();
      const capability = await adapter.probe();
      if (!capability.available || !capability.screenshot) {
        throw new DesktopUiError("SCREENSHOT_UNAVAILABLE", "Native capture requires OS-level screen permission.");
      }
      const discovered = await listDiscoveredWindows(adapter, MAX_WINDOW_DISCOVERY_LIMIT);
      const window = requireFreshWindowTarget(discovered, Number(request.pid), request.nativeId);
      if (hasPinnedApproval) {
        const expected = request.expectedBounds;
        if (typeof request.expectedTitle !== "string" ||
            typeof request.expectedApplication !== "string" ||
            !expected || typeof expected !== "object" || Array.isArray(expected) ||
            Object.keys(expected).length !== 4 ||
            Object.keys(expected).some(key => !["x","y","width","height"].includes(key))) {
          throw new DesktopUiError("INVALID_ACTION", "Native preview approval target is invalid.");
        }
        const bounds = expected as Record<string, unknown>;
        if (request.expectedTitle !== window.title ||
            request.expectedApplication !== window.application ||
            !Object.keys(window.bounds).every(key =>
              bounds[key] === window.bounds[key as keyof typeof window.bounds])) {
          throw new DesktopUiError("STALE_SCREENSHOT", "The approved application window changed before preview began.");
        }
      }
      // Windows and macOS support exact background-window capture. Linux's
      // current adapter rejects inactive windows rather than guessing a screen.
      const token = crypto.randomBytes(32).toString("hex");
      const expiresAt = this.now() + PRIVATE_PREVIEW_TTL_MS;
      // Native fast paths independently verify the full approved target on
      // every frame. Never silently fall back when a protected target rejects
      // a native source; the user must start a fresh, approved session.
      const source = await adapter.openVerifiedCapture?.(window);
      this.active = { token, window: { ...window, bounds: { ...window.bounds } },
        adapter, source, expiresAt, nextFrameAt: 0, capturing: false };
      return { token, expiresAt, platform: adapter.platform,
        backend: source?.backend ?? "verified-window-snapshot",
        window: { pid: window.pid, nativeId: window.nativeId,
          title: window.title, application: window.application } };
    } finally {
      this.starting = false;
    }
  }

  private requireSession(token: unknown): PreviewSession {
    if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token) ||
        !this.active || this.active.token !== token) {
      throw new DesktopUiError("INPUT_DISABLED", "Private preview capability is missing or revoked.");
    }
    if (this.now() >= this.active.expiresAt) {
      this.active.source?.close();
      this.active = null;
      throw new DesktopUiError("INPUT_DISABLED", "Private preview expired; renewed consent is required.");
    }
    return this.active;
  }

  async frame(raw: unknown) {
    const request = requireFrameRequest(raw);
    const session = this.requireSession(request.token);
    if (session.capturing || this.now() < session.nextFrameAt) {
      throw new DesktopUiError("INVALID_ACTION", "Private preview capture is rate limited or busy.");
    }
    session.capturing = true;
    const startedAt = this.now();
    session.nextFrameAt = startedAt + PRIVATE_PREVIEW_INTERVAL_MS;
    try {
      // Windows fast worker performs matching pre/post OS-native checks
      // internally. Other platforms still use two full fresh discoveries,
      // bracketing the original capture operation.
      if (!session.source) {
        const before = requireFreshWindowTarget(
          await listDiscoveredWindows(session.adapter, MAX_WINDOW_DISCOVERY_LIMIT),
          session.window.pid, session.window.nativeId,
        );
        if (!sameWindow(session.window, before))
          throw new DesktopUiError("STALE_SCREENSHOT", "Window identity or bounds changed.");
      }
      const capture = session.source
        ? await session.source.capture()
        : await session.adapter.capture({
            pid: session.window.pid, nativeId: session.window.nativeId, title: session.window.title,
          });
      const maxBytes = request.codec === "jpeg" ? MAX_PREVIEW_SOURCE_BYTES : PRIVATE_PREVIEW_MAX_PNG_BYTES;
      if (!matchesCapture(session.window, capture) ||
          capture.image.byteLength < 24 || capture.image.byteLength > maxBytes) {
        throw new DesktopUiError("STALE_SCREENSHOT", "Native capture target mismatch or image exceeded privacy limits.");
      }
      const { width, height } = readPngSize(capture.image);
      if (width > 8192 || height > 8192 || width * height > MAX_PREVIEW_SOURCE_PIXELS) {
        throw new DesktopUiError("SCREENSHOT_UNAVAILABLE", "Unsafe native capture dimensions.");
      }
      assertWindowPixelBounds(session.window, width, height, session.source);
      if (!session.source) {
        const after = requireFreshWindowTarget(
          await listDiscoveredWindows(session.adapter, MAX_WINDOW_DISCOVERY_LIMIT),
          session.window.pid, session.window.nativeId,
        );
        if (!sameWindow(session.window, after)) {
          throw new DesktopUiError("STALE_SCREENSHOT", "Window changed during native capture.");
        }
      }
      if (this.active !== session || this.now() >= session.expiresAt) {
        throw new DesktopUiError("STALE_SCREENSHOT", "Preview was revoked during capture.");
      }
      // No PNG or JPEG pixels leave Core until two fresh window-identity
      // checks have succeeded. Hashes cover the source PNG bytes.
      const hash = sha256(capture.image);
      // The viewer may request a different JPEG width/quality after a PNG
      // baseline. Reuse is valid only for the exact previously rendered
      // representation, never merely because source pixels match.
      const jpegSettings = request.codec === "jpeg" ? validateJpegSettings(request) : undefined;
      const profile = jpegSettings
        ? `jpeg:${jpegSettings.maxWidth}:${jpegSettings.quality}`
        : "png";
      const unchanged = request.knownHash === hash &&
        session.lastRendered?.hash === hash && session.lastRendered.profile === profile;
      const elapsedMs = Math.max(0, this.now() - startedAt);
      const nextPollMs = unchanged ? 1200
        : Math.max(PRIVATE_PREVIEW_INTERVAL_MS, Math.min(1600, Math.round(elapsedMs * 0.75)));
      if (unchanged) {
        return { unchanged: true as const, hash, capturedAt: capture.capturedAt, nextPollMs };
      }
      const frame = jpegSettings
        ? await encodeJpegPreview(capture.image, jpegSettings)
        : { format: "png" as const, png: Buffer.from(capture.image).toString("base64"), width, height };
      // Revocation can race with native asynchronous JPEG encoding.
      if (this.active !== session || this.now() >= session.expiresAt) {
        throw new DesktopUiError("INPUT_DISABLED", "Preview was revoked during image encoding.");
      }
      session.lastRendered = { hash, profile };
      return { unchanged: false as const, hash, ...frame, capturedAt: capture.capturedAt, nextPollMs };
    } catch {
      // Any uncertain native capture immediately terminates the stream.
      session.source?.close();
      if (this.active === session) this.active = null;
      throw new DesktopUiError("SCREENSHOT_UNAVAILABLE", "Private preview stopped: target or capture verification failed.");
    } finally {
      session.capturing = false;
    }
  }

  stop(raw: unknown): { stopped: true } {
    assertKeys(raw, ["token"]);
    const session = this.requireSession(raw.token);
    session.source?.close();
    this.active = null;
    return { stopped: true };
  }
}

export const nativeWindowPreviewManager = new NativeWindowPreviewManager();
