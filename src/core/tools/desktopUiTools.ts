/**
 * desktopUiTools.ts — Native Desktop UI Automation & Semantic Schema Perception.
 *
 * Provides scoped single-window automation across Windows (UIA), macOS (AX),
 * and Linux (AT-SPI2/xdotool) using accessibility semantics with local UI-DETR vision fallback.
 *
 * Safety & Security Guarantees:
 * - Scoped single-window sessions with high-entropy tokens (256-bit).
 * - Default deny input: model-provided allowInput:true is NEVER trusted alone.
 *   Explicit server-side safe operator consent is required before native input can be dispatched.
 * - Strict semantic element addressing: raw x/y coordinates are forbidden.
 * - State freshness verification: requires exact perceptual revision and SHA-256 hash before action.
 * - Screenshot and user-text privacy: never logs screenshot image bytes or user text.
 */

import crypto from "node:crypto";
import {
  createNativeDesktopUiAdapter,
  createDesktopUiSession,
  findDiscoveredWindows,
  getDiscoveredActiveWindow,
  listDiscoveredWindows,
  MAX_WINDOW_DISCOVERY_LIMIT,
  requireFreshWindowTarget,
  createLocalUiDetrVisionDetector,
  DesktopUiError,
  type DesktopActionReceipt,
  type DesktopDiscoveredWindow,
  type DesktopKey,
  type DesktopModifier,
  type DesktopPoint,
  type DesktopScreenshotIdentity,
  type DesktopUiAdapter,
  type DesktopUiCapabilities,
  type DesktopUiElement,
  type DesktopUiSchema,
  type DesktopVisionDetector,
  type DesktopWindowDiscoveryResult,
  type DesktopWindowTarget,
  type NativeCapture,
} from "../desktopUi/index.js";
import type { Tool } from "./types.js";
import { DesktopAppManager } from "../desktopApp/index.js";
import { inspectSecurityPrompts } from "../desktopSecurity/index.js";
import {readTrustedInputPolicy,trustedWindowMatch,
  type TrustedInputPolicy,type TrustedInputTarget} from "./desktopTrustedInput.js";
import {createTrustedInputPrompt,type TrustedInputPrompt} from "../desktopUi/trustedInputPrompt.js";

export const MAX_DESKTOP_UI_SESSIONS = 10;
export const DEFAULT_SESSION_TTL_MS = 10 * 60 * 1000;
export const MAX_SESSION_TTL_MS = 30 * 60 * 1000;
export const MIN_SESSION_TTL_MS = 60 * 1000;
export const DEFAULT_MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const LOCAL_DESKTOP_UI_OWNER = "local-agent";
const DESKTOP_UI_TARGET_ALLOWLIST_ENV = "SUPERAGENT_DESKTOP_UI_ALLOWED_TARGETS";
const DESKTOP_UI_VISION_UPLOAD_ENV = "SUPERAGENT_DESKTOP_UI_ALLOW_VISION_UPLOAD";
const DESKTOP_UI_VISION_TOKEN_ENV = "SUPERAGENT_DESKTOP_UI_VISION_AUTH_TOKEN";

export const DESKTOP_UI_DISCOVERY_COMMANDS = [
  "list_windows",
  "get_active_window",
  "find_window",
  "inspect_window",
] as const;

export const DESKTOP_UI_APP_COMMANDS = [
  "list_installed_apps",
  "launch_app",
  "focus_window",
  "close_app",
  "restart_app",
  "plan_package_change",
  "apply_package_change",
  "inspect_security_prompts",
] as const;

const DISCOVERY_COMMAND_FIELDS: Record<string, ReadonlySet<string>> = {
  list_windows: new Set(["command", "action", "limit"]),
  get_active_window: new Set(["command", "action"]),
  find_window: new Set(["command", "action", "query", "pid", "limit"]),
  inspect_window: new Set(["command", "action", "pid", "nativeId", "includeScreenshotImage", "maxImageBytes"]),
  list_installed_apps: new Set(["command", "action", "limit"]),
  launch_app: new Set(["command", "action", "appId"]),
  focus_window: new Set(["command", "action", "pid", "nativeId"]),
  close_app: new Set(["command", "action", "pid", "nativeId"]),
  restart_app: new Set(["command", "action", "pid", "nativeId", "appId"]),
  plan_package_change: new Set(["command", "action", "packageAction", "packageId", "source", "version"]),
  apply_package_change: new Set(["command", "action", "approvalRequestId", "operationDigest", "invocationId"]),
  inspect_security_prompts: new Set(["command", "action"]),
};

export function assertDesktopUiDiscoveryCommandFields(args: Record<string, unknown>, command: string): void {
  const allowed = DISCOVERY_COMMAND_FIELDS[command];
  if (!allowed) return;
  const extra = Object.keys(args).filter((key) => !allowed.has(key));
  if (extra.length > 0) {
    throw new DesktopUiError("INVALID_ACTION", `Unsupported field(s) for ${command}: ${extra.sort().join(", ")}.`);
  }
}

export const VALID_DESKTOP_KEYS: ReadonlySet<DesktopKey> = new Set<DesktopKey>([
  "ENTER",
  "TAB",
  "ESCAPE",
  "BACKSPACE",
  "DELETE",
  "ARROW_UP",
  "ARROW_DOWN",
  "ARROW_LEFT",
  "ARROW_RIGHT",
  "HOME",
  "END",
  "PAGE_UP",
  "PAGE_DOWN",
  "SPACE",
]);

export const VALID_DESKTOP_MODIFIERS: ReadonlySet<DesktopModifier> = new Set<DesktopModifier>([
  "CTRL",
  "ALT",
  "SHIFT",
  "META",
]);

export interface DesktopUiConsentGrant {
  grantId: string;
  pid?: number;
  nativeId?: string;
  sessionToken?: string;
  title?: string;
  expiresAt: number;
  grantedBy: string;
}

export interface DesktopUiConsentOptions {
  pid?: number;
  nativeId?: string;
  sessionToken?: string;
  title?: string;
  ttlMs?: number;
  grantedBy?: string;
}

function requireBoundedTtl(ttlMs: number | undefined): number {
  const value = ttlMs ?? DEFAULT_SESSION_TTL_MS;
  if (!Number.isInteger(value) || value < MIN_SESSION_TTL_MS || value > MAX_SESSION_TTL_MS) {
    throw new DesktopUiError(
      "INVALID_ACTION",
      `ttlMs must be an integer between ${MIN_SESSION_TTL_MS} and ${MAX_SESSION_TTL_MS}.`,
    );
  }
  return value;
}

function isExactTargetAllowlisted(target: DesktopWindowTarget): boolean {
  const raw = process.env[DESKTOP_UI_TARGET_ALLOWLIST_ENV];
  if (!raw || !target.nativeId) return false;
  try {
    const entries = JSON.parse(raw);
    if (!Array.isArray(entries)) return false;
    return entries.some((entry) =>
      entry
      && Number.isInteger(entry.pid)
      && entry.pid === target.pid
      && typeof entry.nativeId === "string"
      && entry.nativeId === target.nativeId,
    );
  } catch {
    return false;
  }
}

function legacyGlobalConsentEnabled(): boolean {
  return process.env.SUPERAGENT_DESKTOP_UI_ALLOW_INPUT === "true"
    || process.env.SUPERAGENT_DESKTOP_ALLOW_INPUT === "true"
    || process.env.SUPERAGENT_DESKTOP_INPUT_CONSENT === "true";
}

export class DesktopUiConsentManager {
  private grants = new Map<string, DesktopUiConsentGrant>();

  grantConsent(options: DesktopUiConsentOptions = {}): string {
    const sessionToken = typeof options.sessionToken === "string" ? options.sessionToken.trim() : "";
    const nativeId = typeof options.nativeId === "string" ? options.nativeId.trim() : "";
    const hasExactTarget = Number.isInteger(options.pid) && Number(options.pid) > 0 && nativeId.length > 0;
    if (!sessionToken && !hasExactTarget) {
      throw new DesktopUiError(
        "INVALID_ACTION",
        "Desktop UI consent must bind to an exact session token or an exact pid/nativeId target.",
      );
    }

    const grantId = `consent_${crypto.randomUUID()}`;
    const ttlMs = requireBoundedTtl(options.ttlMs);
    this.grants.set(grantId, {
      grantId,
      ...(hasExactTarget ? { pid: options.pid, nativeId } : {}),
      ...(sessionToken ? { sessionToken } : {}),
      ...(typeof options.title === "string" && options.title.trim() ? { title: options.title.trim() } : {}),
      expiresAt: Date.now() + ttlMs,
      grantedBy: options.grantedBy ?? "host_operator",
    });
    return grantId;
  }

  revokeConsent(grantIdOrToken: string): boolean {
    if (this.grants.delete(grantIdOrToken)) return true;
    for (const [id, grant] of this.grants.entries()) {
      if (grant.sessionToken && grant.sessionToken === grantIdOrToken) {
        this.grants.delete(id);
        return true;
      }
    }
    return false;
  }

  hasConsent(target: DesktopWindowTarget, sessionToken?: string): boolean {
    if (legacyGlobalConsentEnabled() && isExactTargetAllowlisted(target)) {
      return true;
    }

    const now = Date.now();
    for (const [id, grant] of this.grants.entries()) {
      if (grant.expiresAt <= now) {
        this.grants.delete(id);
        continue;
      }
      if (sessionToken && grant.sessionToken && grant.sessionToken === sessionToken) {
        return true;
      }
      if (
        grant.pid === target.pid
        && typeof grant.nativeId === "string"
        && typeof target.nativeId === "string"
        && grant.nativeId === target.nativeId
      ) {
        return true;
      }
    }
    return false;
  }

  clearConsents(): void {
    this.grants.clear();
  }
}

export const desktopUiConsentManager = new DesktopUiConsentManager();
export const desktopAppManager = new DesktopAppManager({
  consentVerifier: (target) => desktopUiConsentManager.hasConsent(target),
});

export interface ActiveSessionRecord {
  token: string;
  ownerPrincipal: string;
  target: DesktopWindowTarget & { nativeId: string; title: string };
  session: ReturnType<typeof createDesktopUiSession>;
  createdAt: number;
  lastAccessedAt: number;
  expiresAt: number;
  ttlMs: number;
  inputRequested: boolean;
  inputAllowed: boolean;
  trustedGrantId?: string;
  trustedTarget?: TrustedInputTarget;
  adapter: DesktopUiAdapter;
  getLatestCapture: () => NativeCapture | null;
}

export interface OpenSessionParams {
  pid: number;
  nativeId: string;
  title: string;
  ownerPrincipal?: string;
  allowInput?: boolean;
  enableVision?: boolean;
  visionEndpoint?: string;
  ttlMs?: number;
  adapter?: DesktopUiAdapter;
  vision?: DesktopVisionDetector;
}

export interface SnapshotParams {
  sessionToken: string;
  ownerPrincipal?: string;
  includeScreenshotImage?: boolean;
  maxImageBytes?: number;
}

export interface ActionParams {
  sessionToken: string;
  ownerPrincipal?: string;
  action: "click" | "type" | "key" | "scroll";
  expectedRevision: number;
  expectedHash: string;
  elementId?: string;
  text?: string;
  key?: DesktopKey;
  modifiers?: DesktopModifier[];
  deltaX?: number;
  deltaY?: number;
  x?: unknown;
  y?: unknown;
  point?: unknown;
  coordinates?: unknown;
}

const FORBIDDEN_DESKTOP_COORDINATE_KEYS = new Set([
  "x", "y", "point", "points", "coordinate", "coordinates", "coords", "position",
  "mousex", "mousey", "screenx", "screeny", "clientx", "clienty",
]);

export function assertNoDesktopUiRawCoordinates(args: Record<string, unknown>): void {
  for (const key of Object.keys(args)) {
    if (FORBIDDEN_DESKTOP_COORDINATE_KEYS.has(key.toLowerCase())) {
      throw new DesktopUiError(
        "INVALID_ACTION",
        `Raw coordinate field '${key}' is forbidden. Desktop UI actions must use semantic elementId or a semantic key.`,
      );
    }
  }
}

function normalizeOwnerPrincipal(ownerPrincipal?: string): string {
  return typeof ownerPrincipal === "string" && ownerPrincipal.trim()
    ? ownerPrincipal.trim()
    : LOCAL_DESKTOP_UI_OWNER;
}

function createHostAuthorizedVisionDetector(endpoint?: string): DesktopVisionDetector {
  const authorizationToken = process.env[DESKTOP_UI_VISION_TOKEN_ENV]?.trim();
  const allowScreenshotUpload = process.env[DESKTOP_UI_VISION_UPLOAD_ENV] === "true";
  if (!allowScreenshotUpload && !authorizationToken) {
    throw new DesktopUiError(
      "VISION_UNAVAILABLE",
      `Vision screenshot upload is disabled. Set ${DESKTOP_UI_VISION_UPLOAD_ENV}=true or configure ${DESKTOP_UI_VISION_TOKEN_ENV} on the trusted host.`,
    );
  }
  return createLocalUiDetrVisionDetector({
    endpoint,
    allowScreenshotUpload,
    ...(authorizationToken ? { authorizationToken } : {}),
  });
}

export class DesktopUiSessionManager {
  private sessions = new Map<string, ActiveSessionRecord>();
  private consentManager: DesktopUiConsentManager;
  private readonly trustedPolicy: () => TrustedInputPolicy | null;
  private readonly trustedPrompt: TrustedInputPrompt;

  constructor(consentManager = desktopUiConsentManager, trusted: {
    policy?: () => TrustedInputPolicy | null;
    prompt?: TrustedInputPrompt;
  } = {}) {
    this.consentManager = consentManager;
    this.trustedPolicy = trusted.policy ?? readTrustedInputPolicy;
    this.trustedPrompt = trusted.prompt ?? createTrustedInputPrompt();
  }

  private trustedEntryStillActive(entry: TrustedInputTarget): boolean {
    const policy = this.trustedPolicy();
    if (policy?.mode !== "trusted" || entry.expiresAt <= Date.now()) return false;
    return policy.targets.some(current => current.pid === entry.pid &&
      current.nativeId === entry.nativeId && current.application === entry.application &&
      current.title === entry.title && current.approvedAt === entry.approvedAt &&
      current.expiresAt === entry.expiresAt);
  }

  getConsentManager(): DesktopUiConsentManager {
    return this.consentManager;
  }

  pruneExpiredSessions(): void {
    const now = Date.now();
    for (const [token, session] of this.sessions.entries()) {
      if (session.expiresAt <= now) {
        if (session.trustedGrantId) this.consentManager.revokeConsent(session.trustedGrantId);
        this.sessions.delete(token);
      }
    }
  }

  getActiveSessionsCount(): number {
    this.pruneExpiredSessions();
    return this.sessions.size;
  }

  getSession(token: string, ownerPrincipal?: string): ActiveSessionRecord | null {
    this.pruneExpiredSessions();
    const session = this.sessions.get(token);
    if (!session) return null;
    if (session.ownerPrincipal !== normalizeOwnerPrincipal(ownerPrincipal)) return null;
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(token);
      return null;
    }
    return session;
  }

  async probe(adapter?: DesktopUiAdapter): Promise<DesktopUiCapabilities> {
    const activeAdapter = adapter ?? createNativeDesktopUiAdapter();
    return activeAdapter.probe();
  }

  async listWindows(params: { limit?: number; adapter?: DesktopUiAdapter } = {}): Promise<DesktopWindowDiscoveryResult> {
    const adapter = params.adapter ?? createNativeDesktopUiAdapter();
    return listDiscoveredWindows(adapter, params.limit);
  }

  async getActiveWindow(adapter?: DesktopUiAdapter): Promise<DesktopDiscoveredWindow | null> {
    return getDiscoveredActiveWindow(adapter ?? createNativeDesktopUiAdapter());
  }

  async findWindow(params: { query: unknown; pid?: number; limit?: number; adapter?: DesktopUiAdapter }): Promise<DesktopWindowDiscoveryResult> {
    const discovery = await this.listWindows({ limit: params.limit, adapter: params.adapter });
    return { ...discovery, windows: findDiscoveredWindows(discovery, params.query, params.pid) };
  }

  async inspectWindow(params: { pid: number; nativeId: unknown; ownerPrincipal?: string; includeScreenshotImage?: boolean; maxImageBytes?: number; adapter?: DesktopUiAdapter }): Promise<{ window: DesktopDiscoveredWindow; schema: DesktopUiSchema; screenshotImage?: string; screenshotImageOmitted?: string }> {
    const ownerPrincipal = normalizeOwnerPrincipal(params.ownerPrincipal);
    const adapter = params.adapter ?? createNativeDesktopUiAdapter();
    const discovery = await listDiscoveredWindows(adapter, MAX_WINDOW_DISCOVERY_LIMIT);
    const target = requireFreshWindowTarget(discovery, params.pid, params.nativeId);
    const opened = await this.openSession({ pid: target.pid, nativeId: target.nativeId, title: target.title, ownerPrincipal, allowInput: false, adapter, ttlMs: MIN_SESSION_TTL_MS });
    try {
      const snapshot = await this.snapshot({ sessionToken: opened.sessionToken, ownerPrincipal, includeScreenshotImage: params.includeScreenshotImage === true, maxImageBytes: params.maxImageBytes });
      return { window: target, ...snapshot };
    } finally {
      this.closeSession(opened.sessionToken, ownerPrincipal);
    }
  }

  async openSession(params: OpenSessionParams): Promise<{
    sessionToken: string;
    target: DesktopWindowTarget;
    expiresAt: number;
    ttlMs: number;
    inputAllowed: boolean;
    consentDenied: boolean;
    message: string;
  }> {
    if (!Number.isInteger(params.pid) || params.pid <= 0) {
      throw new DesktopUiError("INVALID_ACTION", "Target window PID must be a positive integer.");
    }
    if (typeof params.nativeId !== "string" || !params.nativeId.trim()) {
      throw new DesktopUiError("INVALID_ACTION", "Target window nativeId must be a non-empty string.");
    }
    if (typeof params.title !== "string" || !params.title.trim()) {
      throw new DesktopUiError("INVALID_ACTION", "Target window title must be a non-empty string.");
    }

    this.pruneExpiredSessions();
    if (this.sessions.size >= MAX_DESKTOP_UI_SESSIONS) {
      throw new DesktopUiError(
        "DESKTOP_UI_UNAVAILABLE",
        `Maximum concurrent desktop UI sessions limit (${MAX_DESKTOP_UI_SESSIONS}) reached.`,
      );
    }

    const ownerPrincipal = normalizeOwnerPrincipal(params.ownerPrincipal);
    const sessionToken = crypto.randomBytes(32).toString("hex");
    const ttlMs = requireBoundedTtl(params.ttlMs);
    const target: DesktopWindowTarget & { nativeId: string; title: string } = {
      pid: params.pid,
      nativeId: params.nativeId.trim(),
      title: params.title.trim(),
    };

    // A Trusted-mode allowlist can auto-REQUEST consent when callers omit the
    // flag. Explicit allowInput:false always keeps the session read-only.
    // There is no global auto-grant, and no target match means no request.
    let policy: TrustedInputPolicy | null = null;
    try { policy = this.trustedPolicy(); } catch { policy = null; }
    const trustedCandidate = policy?.mode === "trusted" &&
      policy.targets.some(entry => entry.pid === target.pid &&
        entry.nativeId === target.nativeId && entry.title === target.title &&
        entry.expiresAt > Date.now());
    const inputRequested = params.allowInput === true ||
      (params.allowInput === undefined && trustedCandidate);
    const baseAdapter = params.adapter ?? createNativeDesktopUiAdapter();
    let trustedGrantId: string | undefined;
    let trustedTarget: TrustedInputTarget | undefined;

    // Trusted means allow a native approval REQUEST, not an automatic grant.
    // The OS identity is re-discovered, the host sees the exact target, and
    // the persisted trust entry is re-read after the dialog to prevent races.
    if (inputRequested && !this.consentManager.hasConsent(target, sessionToken)) {
      if (policy?.mode === "trusted" && typeof baseAdapter.listWindows === "function") {
        try {
          const windows = await listDiscoveredWindows(baseAdapter, MAX_WINDOW_DISCOVERY_LIMIT);
          const observed = requireFreshWindowTarget(windows, target.pid, target.nativeId);
          const trustedEntry = trustedWindowMatch(policy, target, observed);
          if (trustedEntry) {
            const expiry = Math.min(Date.now() + ttlMs, trustedEntry.expiresAt);
            if (expiry - Date.now() >= MIN_SESSION_TTL_MS &&
              await this.trustedPrompt.confirm({
                principal: ownerPrincipal, pid: target.pid, nativeId: target.nativeId,
                application: observed.application, title: observed.title, expiresAt: expiry,
              }) && this.trustedEntryStillActive(trustedEntry)) {
              const remainingMs = Math.min(ttlMs, trustedEntry.expiresAt - Date.now());
              if (remainingMs >= MIN_SESSION_TTL_MS) {
                trustedGrantId = this.consentManager.grantConsent({
                  sessionToken, ttlMs: remainingMs, grantedBy: "native-host-confirmation",
                });
                trustedTarget = trustedEntry;
              }
            }
          }
        } catch {
          // Missing OS inventory, a denied/failed dialog, or a stale window
          // must leave this session read-only; never trust client metadata.
        }
      }
    }
    const inputAllowed = inputRequested && this.consentManager.hasConsent(target, sessionToken);
    const consentDenied = inputRequested && !inputAllowed;
    let latestCapture: NativeCapture | null = null;
    const adapter: DesktopUiAdapter = {
      platform: baseAdapter.platform,
      probe: () => baseAdapter.probe(),
      capture: async (t) => {
        const cap = await baseAdapter.capture(t);
        latestCapture = cap;
        return cap;
      },
      inspectAccessibility: (t, c) => baseAdapter.inspectAccessibility(t, c),
      dispatch: (a) => baseAdapter.dispatch(a),
    };

    let vision = params.vision;
    if (!vision && params.enableVision === true) {
      vision = createHostAuthorizedVisionDetector(params.visionEndpoint);
    }

    const nativeSession = createDesktopUiSession({
      adapter,
      target,
      vision,
      allowInput: inputRequested,
    });

    const now = Date.now();
    const record: ActiveSessionRecord = {
      token: sessionToken,
      ownerPrincipal,
      target,
      session: nativeSession,
      createdAt: now,
      lastAccessedAt: now,
      expiresAt: now + ttlMs,
      ttlMs,
      inputRequested,
      inputAllowed,
      ...(trustedGrantId ? { trustedGrantId, trustedTarget } : {}),
      adapter,
      getLatestCapture: () => latestCapture,
    };
    this.sessions.set(sessionToken, record);

    const message = consentDenied
      ? "Session opened read-only for input. Host consent is required before this session can dispatch native input."
      : inputAllowed
        ? "Desktop UI session opened with scoped host consent for native input."
        : "Desktop UI session opened with native input disabled.";

    return {
      sessionToken,
      target: { pid: target.pid, nativeId: target.nativeId, title: target.title },
      expiresAt: record.expiresAt,
      ttlMs,
      inputAllowed,
      consentDenied,
      message,
    };
  }

  async snapshot(params: SnapshotParams): Promise<{
    schema: DesktopUiSchema;
    screenshotImage?: string;
    screenshotImageOmitted?: string;
  }> {
    if (!params.sessionToken || typeof params.sessionToken !== "string") {
      throw new DesktopUiError("INVALID_ACTION", "sessionToken is required for snapshot.");
    }

    const session = this.getSession(params.sessionToken, params.ownerPrincipal);
    if (!session) {
      throw new DesktopUiError("TARGET_NOT_FOUND", "Desktop UI session not found, expired, or owned by another principal.");
    }
    session.lastAccessedAt = Date.now();

    const maxBytes = params.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;
    if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > DEFAULT_MAX_IMAGE_BYTES) {
      throw new DesktopUiError(
        "INVALID_ACTION",
        `maxImageBytes must be an integer between 1 and ${DEFAULT_MAX_IMAGE_BYTES}.`,
      );
    }

    const schema = await session.session.snapshot();
    let screenshotImage: string | undefined;
    let screenshotImageOmitted: string | undefined;

    if (params.includeScreenshotImage === true) {
      const cap = session.getLatestCapture();
      if (cap?.image) {
        if (cap.image.byteLength <= maxBytes) {
          screenshotImage = Buffer.from(cap.image).toString("base64");
        } else {
          screenshotImageOmitted = `Screenshot image size (${cap.image.byteLength} bytes) exceeds bounded limit (${maxBytes} bytes).`;
        }
      }
    }

    return {
      schema,
      ...(screenshotImage ? { screenshotImage } : {}),
      ...(screenshotImageOmitted ? { screenshotImageOmitted } : {}),
    };
  }

  async action(params: ActionParams): Promise<DesktopActionReceipt> {
    if (
      params.x !== undefined
      || params.y !== undefined
      || params.point !== undefined
      || params.coordinates !== undefined
    ) {
      throw new DesktopUiError(
        "INVALID_ACTION",
        "Raw coordinates are forbidden. Desktop UI actions must use semantic elementId or a semantic key.",
      );
    }
    if (!params.sessionToken || typeof params.sessionToken !== "string") {
      throw new DesktopUiError("INVALID_ACTION", "sessionToken is required for action.");
    }

    const session = this.getSession(params.sessionToken, params.ownerPrincipal);
    if (!session) {
      throw new DesktopUiError("TARGET_NOT_FOUND", "Desktop UI session not found, expired, or owned by another principal.");
    }

    // Revoke takes effect on the very next input action, even while a
    // previously host-approved session remains open in the Core process.
    if (session.trustedGrantId && (!session.trustedTarget ||
      !this.trustedEntryStillActive(session.trustedTarget))) {
      this.consentManager.revokeConsent(session.trustedGrantId);
      throw new DesktopUiError("INPUT_DISABLED", "Trusted window approval has expired or was revoked.");
    }
    const hasConsent = this.consentManager.hasConsent(session.target, session.token);
    if (!session.inputRequested || !hasConsent) {
      throw new DesktopUiError(
        "INPUT_DISABLED",
        "Native desktop input requires both an input-enabled session and exact host consent for this session or pid/nativeId target.",
      );
    }
    session.lastAccessedAt = Date.now();

    if (!Number.isInteger(params.expectedRevision) || params.expectedRevision <= 0) {
      throw new DesktopUiError("INVALID_ACTION", "expectedRevision must be a positive integer.");
    }
    if (typeof params.expectedHash !== "string" || !/^[a-f0-9]{64}$/i.test(params.expectedHash.trim())) {
      throw new DesktopUiError("INVALID_ACTION", "expectedHash must be a 64-character SHA-256 hexadecimal digest.");
    }

    const expectedRevision = params.expectedRevision;
    const expectedHash = params.expectedHash.trim().toLowerCase();

    switch (params.action) {
      case "click": {
        if (typeof params.elementId !== "string" || !params.elementId.trim()) {
          throw new DesktopUiError("INVALID_ACTION", "elementId is required for click action.");
        }
        return session.session.click({ elementId: params.elementId.trim(), expectedRevision, expectedHash });
      }
      case "type": {
        if (typeof params.elementId !== "string" || !params.elementId.trim()) {
          throw new DesktopUiError("INVALID_ACTION", "elementId is required for type action.");
        }
        if (typeof params.text !== "string" || params.text.length > 32_768) {
          throw new DesktopUiError("INVALID_ACTION", "text must be a string no longer than 32768 characters.");
        }
        return session.session.type({
          elementId: params.elementId.trim(),
          text: params.text,
          expectedRevision,
          expectedHash,
        });
      }
      case "key": {
        if (!params.key || !VALID_DESKTOP_KEYS.has(params.key)) {
          throw new DesktopUiError("INVALID_ACTION", `Invalid key '${String(params.key)}'.`);
        }
        const modifiers = params.modifiers ?? [];
        if (
          !Array.isArray(modifiers)
          || modifiers.length > VALID_DESKTOP_MODIFIERS.size
          || modifiers.some((modifier) => !VALID_DESKTOP_MODIFIERS.has(modifier))
          || new Set(modifiers).size !== modifiers.length
        ) {
          throw new DesktopUiError("INVALID_ACTION", "modifiers must be unique supported desktop modifier keys.");
        }
        return session.session.key({ key: params.key, modifiers, expectedRevision, expectedHash });
      }
      case "scroll": {
        if (typeof params.elementId !== "string" || !params.elementId.trim()) {
          throw new DesktopUiError("INVALID_ACTION", "elementId is required for scroll action.");
        }
        const deltaX = params.deltaX ?? 0;
        const deltaY = params.deltaY ?? 0;
        if (
          !Number.isInteger(deltaX)
          || !Number.isInteger(deltaY)
          || Math.abs(deltaX) > 3
          || Math.abs(deltaY) > 3
          || (deltaX === 0 && deltaY === 0)
        ) {
          throw new DesktopUiError("INVALID_ACTION", "Scroll deltas must be integers from -3 to 3 and not both zero.");
        }
        return session.session.scroll({
          elementId: params.elementId.trim(),
          deltaX,
          deltaY,
          expectedRevision,
          expectedHash,
        });
      }
      default:
        throw new DesktopUiError(
          "INVALID_ACTION",
          `Unsupported action '${String(params.action)}'. Valid actions are: click, type, key, scroll.`,
        );
    }
  }

  closeSession(sessionToken: string, ownerPrincipal?: string): { closed: boolean } {
    if (!sessionToken || typeof sessionToken !== "string") {
      throw new DesktopUiError("INVALID_ACTION", "sessionToken is required to close session.");
    }
    const session = this.getSession(sessionToken, ownerPrincipal);
    if (!session) return { closed: false };
    if (session.trustedGrantId) this.consentManager.revokeConsent(session.trustedGrantId);
    return { closed: this.sessions.delete(sessionToken) };
  }

  clearAllSessions(): void {
    for (const session of this.sessions.values()) {
      if (session.trustedGrantId) this.consentManager.revokeConsent(session.trustedGrantId);
    }
    this.sessions.clear();
  }
}

export const desktopUiSessionManager = new DesktopUiSessionManager();

function sanitizeDesktopUiLogValue(value: unknown, key = ""): unknown {
  const normalizedKey = key.toLowerCase();
  if (typeof value === "string") {
    if (normalizedKey.includes("sessiontoken") || normalizedKey.includes("authorizationtoken")) {
      return "[REDACTED_TOKEN]";
    }
    if (["approvalrequestid", "invocationid", "operationdigest"].includes(normalizedKey)) return "[REDACTED_APPROVAL_BINDING]";
    if (["appid", "packageid", "version", "source"].includes(normalizedKey)) return "[REDACTED_APP_METADATA]";
    if (normalizedKey === "text") return "[REDACTED_TEXT]";
    if (["title", "application", "query"].includes(normalizedKey)) return "[REDACTED_WINDOW_METADATA]";
    if (
      normalizedKey.includes("screenshotimage")
      || normalizedKey.includes("image_base64")
      || normalizedKey.includes("imagebase64")
      || normalizedKey === "image"
    ) {
      return "[IMAGE_BYTES]";
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeDesktopUiLogValue(entry));
  }
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      output[childKey] = sanitizeDesktopUiLogValue(childValue, childKey);
    }
    return output;
  }
  return value;
}

export function sanitizeDesktopUiLogPayload<T extends Record<string, unknown>>(payload: T): T {
  return sanitizeDesktopUiLogValue(payload) as T;
}

export function sanitizeDesktopUiLogText(text?: string): string | undefined {
  if (!text) return text;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") {
      return JSON.stringify(sanitizeDesktopUiLogValue(parsed));
    }
  } catch {
    // Non-JSON errors are sanitized with bounded field patterns below.
  }
  return text
    .replace(/("sessionToken"\s*:\s*")[^"]*"/gi, '$1[REDACTED_TOKEN]"')
    .replace(/("authorizationToken"\s*:\s*")[^"]*"/gi, '$1[REDACTED_TOKEN]"')
    .replace(/("screenshotImage"\s*:\s*")[^"]*"/gi, '$1[IMAGE_BYTES]"')
    .replace(/("(?:image_base64|imageBase64|image)"\s*:\s*")[^"]*"/gi, '$1[IMAGE_BYTES]"')
    .replace(/("text"\s*:\s*")[^"]*"/gi, '$1[REDACTED_TEXT]"')
    .replace(/(sessionToken\s*[=:]\s*)\S+/gi, "$1[REDACTED_TOKEN]")
    .replace(/(authorizationToken\s*[=:]\s*)\S+/gi, "$1[REDACTED_TOKEN]");
}

/**
 * Native Desktop UI local agent tool definition.
 */
export const desktopUiTool: Tool = {
  name: "desktop_ui",
  description:
    "Perceive and automate native desktop application windows using bounded discovery and accessibility semantics. " +
    "Commands also expose installed-app inventory, verified Windows app lifecycle, guarded package planning/apply, and read-only security-prompt inspection. " +
    "The existing open command only creates a scoped window session; launch_app is the separate installed-app launcher. " +
    "Lifecycle mutation requires exact host consent; package mutation additionally requires separate host-operator approval bound to the exact operation.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      command: {
        type: "string",
        enum: ["probe", ...DESKTOP_UI_DISCOVERY_COMMANDS, ...DESKTOP_UI_APP_COMMANDS, "open", "snapshot", "action", "close"],
        description: "Desktop UI command to execute.",
      },
      action: {
        type: "string",
        enum: ["probe", ...DESKTOP_UI_DISCOVERY_COMMANDS, ...DESKTOP_UI_APP_COMMANDS, "open", "snapshot", "action", "close", "click", "type", "key", "scroll"],
        description: "Alternative command name or action kind. command='action' with action='click' is supported.",
      },
      subAction: {
        type: "string",
        enum: ["click", "type", "key", "scroll"],
        description: "Explicit action kind when command='action'.",
      },
      limit: { type: "integer", minimum: 1, maximum: MAX_WINDOW_DISCOVERY_LIMIT, description: "Bounded discovery result limit; default 50, hard cap 100." },
      query: { type: "string", minLength: 1, maxLength: 256, description: "Case-insensitive application/title query for find_window." },
      pid: { type: "integer", minimum: 1, description: "Exact process ID for open/inspect_window or optional find_window filter." },
      nativeId: { type: "string", minLength: 1, maxLength: 256, description: "Exact native window ID for open/inspect_window." },
      title: { type: "string", minLength: 1, maxLength: 512, description: "Window title metadata for 'open'; never used as authorization." },
      allowInput: {
        type: "boolean",
        description: "true requests input; false forces read-only. Omission auto-requests only an exact currently Trusted window, and still requires a fresh native host approval.",
      },
      enableVision: {
        type: "boolean",
        description: "Request local UI-DETR perception. Default false; host upload opt-in or local auth is required.",
      },
      visionEndpoint: { type: "string", maxLength: 2048, description: "Loopback UI-DETR endpoint." },
      ttlMs: {
        type: "integer",
        minimum: MIN_SESSION_TTL_MS,
        maximum: MAX_SESSION_TTL_MS,
        description: "Absolute session TTL; activity does not extend it.",
      },
      sessionToken: {
        type: "string",
        minLength: 64,
        maxLength: 64,
        pattern: "^[a-fA-F0-9]{64}$",
        description: "Opaque session token from 'open'.",
      },
      includeScreenshotImage: {
        type: "boolean",
        description: "Include bounded base64 target-window screenshot bytes. Default false.",
      },
      maxImageBytes: {
        type: "integer",
        minimum: 1,
        maximum: DEFAULT_MAX_IMAGE_BYTES,
        description: "Hard per-response screenshot byte cap.",
      },
      expectedRevision: { type: "integer", minimum: 1, description: "Exact prior perception revision." },
      expectedHash: {
        type: "string",
        pattern: "^[a-fA-F0-9]{64}$",
        description: "Exact prior screenshot SHA-256.",
      },
      elementId: {
        type: "string",
        minLength: 1,
        maxLength: 128,
        description: "Accessibility-backed semantic element ID. Raw coordinates are forbidden.",
      },
      text: { type: "string", maxLength: 32768, description: "Text for a semantic 'type' action." },
      key: {
        type: "string",
        enum: [
          "ENTER", "TAB", "ESCAPE", "BACKSPACE", "DELETE",
          "ARROW_UP", "ARROW_DOWN", "ARROW_LEFT", "ARROW_RIGHT",
          "HOME", "END", "PAGE_UP", "PAGE_DOWN", "SPACE",
        ],
      },
      modifiers: {
        type: "array",
        maxItems: 4,
        uniqueItems: true,
        items: { type: "string", enum: ["CTRL", "ALT", "SHIFT", "META"] },
      },
      deltaX: { type: "integer", minimum: -3, maximum: 3 },
      deltaY: { type: "integer", minimum: -3, maximum: 3 },
      appId: { type: "string", minLength: 1, maxLength: 512, description: "Exact installed application ID returned by list_installed_apps." },
      packageAction: { type: "string", enum: ["install", "uninstall", "reinstall", "update"] },
      packageId: { type: "string", minLength: 1, maxLength: 128 },
      source: { type: "string", minLength: 1, maxLength: 64 },
      version: { type: "string", minLength: 1, maxLength: 128 },
      approvalRequestId: { type: "string", minLength: 1, maxLength: 128 },
      operationDigest: { type: "string", pattern: "^[a-fA-F0-9]{64}$" },
      invocationId: { type: "string", minLength: 1, maxLength: 128 },
    },
  },
  execute: async (args: Record<string, unknown>, _cwd: string, _signal?: AbortSignal): Promise<string> => {
    try {
      assertNoDesktopUiRawCoordinates(args);
      let command = typeof args.command === "string" ? args.command.trim().toLowerCase() : "";
      const rawAction = typeof args.action === "string" ? args.action.trim().toLowerCase() : "";
      if (!command) {
        command = ["probe", ...DESKTOP_UI_DISCOVERY_COMMANDS, ...DESKTOP_UI_APP_COMMANDS, "open", "snapshot", "action", "close"].includes(rawAction as any)
          ? rawAction
          : ["click", "type", "key", "scroll"].includes(rawAction)
            ? "action"
            : "";
      }
      if (!command) {
        throw new DesktopUiError("INVALID_ACTION", "Missing desktop UI command.");
      }
      assertDesktopUiDiscoveryCommandFields(args, command);

      switch (command) {
        case "probe":
          return JSON.stringify({ success: true, capabilities: await desktopUiSessionManager.probe() }, null, 2);
        case "list_windows":
          return JSON.stringify({ success: true, ...(await desktopUiSessionManager.listWindows({ limit: typeof args.limit === "number" ? args.limit : undefined })) }, null, 2);
        case "get_active_window":
          return JSON.stringify({ success: true, window: await desktopUiSessionManager.getActiveWindow() }, null, 2);
        case "find_window":
          return JSON.stringify({ success: true, ...(await desktopUiSessionManager.findWindow({ query: args.query, pid: typeof args.pid === "number" ? args.pid : undefined, limit: typeof args.limit === "number" ? args.limit : undefined })) }, null, 2);
        case "inspect_window":
          return JSON.stringify({ success: true, ...(await desktopUiSessionManager.inspectWindow({ pid: Number(args.pid), nativeId: args.nativeId, ownerPrincipal: LOCAL_DESKTOP_UI_OWNER, includeScreenshotImage: args.includeScreenshotImage === true, maxImageBytes: typeof args.maxImageBytes === "number" ? args.maxImageBytes : undefined })) }, null, 2);
        case "list_installed_apps":
          return JSON.stringify({ success: true, ...(await desktopAppManager.listInstalledApps(typeof args.limit === "number" ? args.limit : 50)) }, null, 2);
        case "launch_app":
          return JSON.stringify({ success: true, ...(await desktopAppManager.launchApp(args.appId)) }, null, 2);
        case "focus_window":
          return JSON.stringify({ success: true, ...(await desktopAppManager.focusWindow({ pid: Number(args.pid), nativeId: String(args.nativeId ?? "") })) }, null, 2);
        case "close_app":
          return JSON.stringify({ success: true, ...(await desktopAppManager.closeApp({ pid: Number(args.pid), nativeId: String(args.nativeId ?? "") })) }, null, 2);
        case "restart_app":
          return JSON.stringify({ success: true, ...(await desktopAppManager.restartApp(args.appId, { pid: Number(args.pid), nativeId: String(args.nativeId ?? "") })) }, null, 2);
        case "plan_package_change":
          return JSON.stringify({ success: true, ...(await desktopAppManager.planPackageChange({ principalId: LOCAL_DESKTOP_UI_OWNER, packageAction: args.packageAction, packageId: args.packageId, source: args.source, version: args.version })) }, null, 2);
        case "apply_package_change":
          return JSON.stringify({ success: true, result: await desktopAppManager.applyPackageChange({ principalId: LOCAL_DESKTOP_UI_OWNER, approvalRequestId: args.approvalRequestId, operationDigest: args.operationDigest, invocationId: args.invocationId }) }, null, 2);
        case "inspect_security_prompts":
          return JSON.stringify({ success: true, report: await inspectSecurityPrompts() }, null, 2);
        case "open": {
          const session = await desktopUiSessionManager.openSession({
            pid: Number(args.pid),
            nativeId: String(args.nativeId ?? ""),
            title: String(args.title ?? ""),
            ownerPrincipal: LOCAL_DESKTOP_UI_OWNER,
            allowInput: args.allowInput === true ? true : args.allowInput === false ? false : undefined,
            enableVision: args.enableVision === true,
            visionEndpoint: typeof args.visionEndpoint === "string" ? args.visionEndpoint : undefined,
            ttlMs: typeof args.ttlMs === "number" ? args.ttlMs : undefined,
          });
          return JSON.stringify({ success: true, session }, null, 2);
        }
        case "snapshot": {
          const snapshot = await desktopUiSessionManager.snapshot({
            sessionToken: String(args.sessionToken ?? ""),
            ownerPrincipal: LOCAL_DESKTOP_UI_OWNER,
            includeScreenshotImage: args.includeScreenshotImage === true,
            maxImageBytes: typeof args.maxImageBytes === "number" ? args.maxImageBytes : undefined,
          });
          return JSON.stringify({ success: true, ...snapshot }, null, 2);
        }
        case "action": {
          const subAction = (
            ["click", "type", "key", "scroll"].includes(rawAction)
              ? rawAction
              : args.subAction
          ) as ActionParams["action"];
          const receipt = await desktopUiSessionManager.action({
            sessionToken: String(args.sessionToken ?? ""),
            ownerPrincipal: LOCAL_DESKTOP_UI_OWNER,
            action: subAction,
            expectedRevision: Number(args.expectedRevision),
            expectedHash: String(args.expectedHash ?? ""),
            elementId: typeof args.elementId === "string" ? args.elementId : undefined,
            text: typeof args.text === "string" ? args.text : undefined,
            key: args.key as DesktopKey | undefined,
            modifiers: Array.isArray(args.modifiers) ? (args.modifiers as DesktopModifier[]) : undefined,
            deltaX: typeof args.deltaX === "number" ? args.deltaX : undefined,
            deltaY: typeof args.deltaY === "number" ? args.deltaY : undefined,
          });
          return JSON.stringify({ success: true, receipt }, null, 2);
        }
        case "close":
          return JSON.stringify({
            success: true,
            ...desktopUiSessionManager.closeSession(String(args.sessionToken ?? ""), LOCAL_DESKTOP_UI_OWNER),
          }, null, 2);
        default:
          throw new DesktopUiError(
            "INVALID_ACTION",
            `Unknown desktop UI command '${command}'.`,
          );
      }
    } catch (error: any) {
      const code = error?.code || "DESKTOP_UI_ERROR";
      const message = sanitizeDesktopUiLogText(error?.message || String(error)) || "Desktop UI error";
      return JSON.stringify({ success: false, isError: true, code, error: message }, null, 2);
    }
  },
};
