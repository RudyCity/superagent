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
  type DesktopMonitorDiscoveryResult,
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
import { resolveWindowsStartAppExecutable } from "../desktopApp/windows.js";
import { inspectSecurityPrompts } from "../desktopSecurity/index.js";
import {readTrustedInputPolicy,trustedWindowMatch,
  type TrustedInputPolicy,type TrustedInputTarget} from "./desktopTrustedInput.js";
import {createTrustedInputPrompt,type TrustedInputPrompt} from "../desktopUi/trustedInputPrompt.js";
import {readPermanentAccessRegistry} from "../desktopUi/permanentRegistryStore.js";
import {evaluatePersistentAccess,hasRegisteredDesktopInputCandidate,
  type ExecutableIdentity,type PersistentAccessPolicy}
  from "../desktopUi/persistentAccessPolicy.js";
import {resolveNativeDesktopExecutable} from "../desktopUi/nativeExecutableIdentity.js";
import { desktopUiSessionAccessRequests, type DesktopUiSessionAccessRequest } from "../desktopUi/desktopUiSessionAccessRequests.js";

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
  "list_monitors",
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

export const DISCOVERY_COMMAND_FIELDS: Record<string, ReadonlySet<string>> = {
  list_windows: new Set(["command", "action", "limit"]),
  get_active_window: new Set(["command", "action"]),
  find_window: new Set(["command", "action", "query", "pid", "limit"]),
  list_monitors: new Set(["command", "action"]),
  inspect_window: new Set(["command", "action", "pid", "nativeId", "includeScreenshotImage", "maxImageBytes", "approvalRequestId", "reason", "ttlMs"]),
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
  permanentConsentVerifier: async (target) => {
    const permanent = readPermanentAccessRegistry();
    if (!permanent || !Number.isInteger(target.pid) || target.pid <= 0 || typeof target.nativeId !== "string" || !target.nativeId) {
      return false;
    }
    try {
      const discovery = await desktopUiSessionManager.listWindows({ limit: MAX_WINDOW_DISCOVERY_LIMIT });
      const observed = requireFreshWindowTarget(discovery, target.pid, target.nativeId);
      const identity = await resolveNativeDesktopExecutable(target.pid);
      if (!identity || !hasRegisteredDesktopInputCandidate(permanent, identity, observed.title)) {
        return false;
      }
      const fresh = readPermanentAccessRegistry();
      return Boolean(fresh && hasRegisteredDesktopInputCandidate(fresh, identity, observed.title));
    } catch {
      return false;
    }
  },
  launchConsentVerifier: async (appId) => {
    const permanent = readPermanentAccessRegistry();
    if (!permanent) return true;
    const identity = await resolveWindowsStartAppExecutable(appId);
    if (!identity || !hasRegisteredDesktopInputCandidate(permanent, identity, appId)) {
      return false;
    }
    const fresh = readPermanentAccessRegistry();
    return Boolean(fresh && hasRegisteredDesktopInputCandidate(fresh, identity, appId));
  },
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
  sessionApprovalGrantId?: string;
  registeredGrantId?: string;
  registeredIdentity?: ExecutableIdentity;
  registeredViewIdentity?: ExecutableIdentity;
  adapter: DesktopUiAdapter;
  getLatestCapture: () => NativeCapture | null;
}

export interface OpenSessionParams {
  pid: number;
  nativeId: string;
  title: string;
  ownerPrincipal?: string;
  allowInput?: boolean;
  oneShotHostApproval?: boolean;
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
  private readonly permanentRegistry: () => PersistentAccessPolicy | null;
  private readonly executableIdentity: (pid: number) => Promise<ExecutableIdentity | null>;

  constructor(consentManager = desktopUiConsentManager, trusted: {
    policy?: () => TrustedInputPolicy | null;
    prompt?: TrustedInputPrompt;
    permanentRegistry?: () => PersistentAccessPolicy | null;
    executableIdentity?: (pid: number) => Promise<ExecutableIdentity | null>;
  } = {}) {
    this.consentManager = consentManager;
    this.trustedPolicy = trusted.policy ?? readTrustedInputPolicy;
    this.trustedPrompt = trusted.prompt ?? createTrustedInputPrompt();
    this.permanentRegistry = trusted.permanentRegistry ?? readPermanentAccessRegistry;
    this.executableIdentity = trusted.executableIdentity ?? resolveNativeDesktopExecutable;
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
        if (session.sessionApprovalGrantId) this.consentManager.revokeConsent(session.sessionApprovalGrantId);
        if (session.registeredGrantId) this.consentManager.revokeConsent(session.registeredGrantId);
        this.sessions.delete(token);
      }
    }
  }

  /** Operator projection has no bearer, session capability, or screenshot. */
  listOperatorSessions(): Array<{ pid: number; nativeId: string; owner: string; expiresAt: number }> {
    this.pruneExpiredSessions();
    return [...this.sessions.values()].map(s => ({
      pid: s.target.pid, nativeId: s.target.nativeId,
      owner: s.ownerPrincipal, expiresAt: s.expiresAt,
    }));
  }
  /** Revoke only exact window session capabilities, not the application. */
  revokeOperatorWindowSessions(pid: number, nativeId: string): number {
    this.pruneExpiredSessions();
    let closed = 0;
    for (const [token, s] of this.sessions) {
      if (s.target.pid !== pid || s.target.nativeId !== nativeId) continue;
      if (s.trustedGrantId) this.consentManager.revokeConsent(s.trustedGrantId);
      if (s.sessionApprovalGrantId) this.consentManager.revokeConsent(s.sessionApprovalGrantId);
      if ("registeredGrantId" in s && typeof s.registeredGrantId === "string") {
        this.consentManager.revokeConsent(s.registeredGrantId);
      }
      if (this.sessions.delete(token)) closed++;
    }
    return closed;
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

  async listMonitors(adapter?: DesktopUiAdapter): Promise<DesktopMonitorDiscoveryResult> {
    const activeAdapter = adapter ?? createNativeDesktopUiAdapter();
    if (typeof activeAdapter.listMonitors !== "function") {
      throw new DesktopUiError("DESKTOP_UI_UNAVAILABLE", "Monitor discovery is not supported on this platform adapter.");
    }
    return activeAdapter.listMonitors();
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
    let permanent: PersistentAccessPolicy | null = null;
    try { permanent = this.permanentRegistry(); } catch { permanent = null; }
    // V2 takes precedence over old short-lived window trust when installed.
    const registeredCandidate = Boolean(permanent?.rules.some(rule =>
      rule.kind === "desktop" && rule.effect === "allow" &&
      rule.operations.includes("input")));
    const trustedCandidate = !permanent && policy?.mode === "trusted" &&
      policy.targets.some(entry => entry.pid === target.pid &&
        entry.nativeId === target.nativeId && entry.title === target.title &&
        entry.expiresAt > Date.now());
    const inputRequested = params.allowInput === true ||
      (params.allowInput === undefined && (registeredCandidate || trustedCandidate));
    const baseAdapter = params.adapter ?? createNativeDesktopUiAdapter();
    let registeredViewIdentity: ExecutableIdentity | undefined;
    if (permanent) {
      // A registered application must be explicitly approved for observation.
      // Window listing remains available so the owner can enroll a target.
      if (typeof baseAdapter.listWindows !== "function") {
        throw new DesktopUiError("INPUT_DISABLED", "Registered desktop view requires native OS window discovery.");
      }
      try {
        const discovery = await listDiscoveredWindows(baseAdapter, MAX_WINDOW_DISCOVERY_LIMIT);
        const observed = requireFreshWindowTarget(discovery, target.pid, target.nativeId);
        if (!observed.active || observed.title !== target.title) throw Error("Window is not foreground");
        const identity = await this.executableIdentity(target.pid);
        if (!identity || evaluatePersistentAccess(permanent, {
          kind: "desktop", app: identity, operation: "view", windowTitle: observed.title,
        }).effect !== "allow") throw Error("Application not authorized for viewing");
        const fresh = this.permanentRegistry();
        if (!fresh || evaluatePersistentAccess(fresh, {
          kind: "desktop", app: identity, operation: "view", windowTitle: observed.title,
        }).effect !== "allow") throw Error("Viewing revoked during identity verification");
        registeredViewIdentity = identity;
      } catch {
        throw new DesktopUiError("INPUT_DISABLED", "Application viewing not registered or OS identity changed.");
      }
    }
    let trustedGrantId: string | undefined;
    let trustedTarget: TrustedInputTarget | undefined;
    let sessionApprovalGrantId: string | undefined;
    let registeredGrantId: string | undefined;
    let registeredIdentity: ExecutableIdentity | undefined;

    // Registered native app rules have no policy expiry. The actual session
    // still has a bounded token; native enrollment already required host approval.
    if (inputRequested && permanent && typeof baseAdapter.listWindows === "function") {
      try {
        const windows = await listDiscoveredWindows(baseAdapter, MAX_WINDOW_DISCOVERY_LIMIT);
        const observed = requireFreshWindowTarget(windows, target.pid, target.nativeId);
        if (observed.active && observed.title === target.title) {
          const executable = await this.executableIdentity(target.pid);
          if (executable &&
              hasRegisteredDesktopInputCandidate(permanent, executable, observed.title)) {
            // Re-read after the potentially slow binary hash to detect revocation.
            const current = this.permanentRegistry();
            if (current && hasRegisteredDesktopInputCandidate(current, executable, observed.title)) {
              registeredGrantId = this.consentManager.grantConsent({
                sessionToken, ttlMs, grantedBy: "native-permanent-host-registration",
              });
              registeredIdentity = executable;
            }
          }
        }
      } catch {
        // OS process identity unavailable, app replaced, or denied: no input.
      }
    }

    // A Request Center decision is a one-shot approval for this exact session.
    // A live permanent registry remains authoritative and cannot be bypassed.
    if (inputRequested && params.oneShotHostApproval === true && !permanent) {
      sessionApprovalGrantId = this.consentManager.grantConsent({
        sessionToken, ttlMs, grantedBy: "native-request-center-approval",
      });
    }

    // Trusted means allow a native approval REQUEST, not an automatic grant.
    // The OS identity is re-discovered, the host sees the exact target, and
    // the persisted trust entry is re-read after the dialog to prevent races.
    if (inputRequested && !this.consentManager.hasConsent(target, sessionToken)) {
      if (!permanent && policy?.mode === "trusted" && typeof baseAdapter.listWindows === "function") {
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
    // Older env/global consent must NEVER bypass an installed v2 deny rule.
    const inputAllowed = inputRequested &&
      (permanent ? Boolean(registeredGrantId) : true) &&
      this.consentManager.hasConsent(target, sessionToken);
    const consentDenied = inputRequested && !inputAllowed;
    let latestCapture: NativeCapture | null = null;
    const adapter: DesktopUiAdapter = {
      platform: baseAdapter.platform,
      probe: () => baseAdapter.probe(),
      ...(baseAdapter.listWindows ? { listWindows: (limit?: number) => baseAdapter.listWindows!(limit ?? MAX_WINDOW_DISCOVERY_LIMIT) } : {}),
      capture: async (t) => {
        const cap = await baseAdapter.capture(t);
        latestCapture = cap;
        return cap;
      },
      inspectAccessibility: (t, c) => baseAdapter.inspectAccessibility(t, c),
      dispatch: async (a) => {
        if (registeredGrantId) {
          // Dispatch-side guard, after semantic screenshot/accessibility validation.
          // The target OS adapter still checks the exact native foreground HWND.
          const latest = this.permanentRegistry();
          const identity = await this.executableIdentity(target.pid);
          const element = "element" in a ? a.element : undefined;
          if (!identity || !registeredIdentity || !latest ||
              identity.sha256.toLowerCase() !== registeredIdentity.sha256.toLowerCase() ||
              identity.executablePath.toLowerCase() !== registeredIdentity.executablePath.toLowerCase() ||
              evaluatePersistentAccess(latest, {
                kind: "desktop", app: identity, operation: "input",
                windowTitle: target.title, elementRole: element?.role,
                elementLabel: element?.label ?? undefined,
              }).effect !== "allow") {
            throw new DesktopUiError("INPUT_DISABLED",
              "This native control is blocked by the exact registered application/element policy.");
          }
        }
        return baseAdapter.dispatch(a);
      },
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
      ...(sessionApprovalGrantId ? { sessionApprovalGrantId } : {}),
      ...(registeredGrantId ? { registeredGrantId, registeredIdentity } : {}),
      ...(registeredViewIdentity ? { registeredViewIdentity } : {}),
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
    const currentViewRegistry = this.permanentRegistry();
    if (currentViewRegistry && !session.registeredViewIdentity) {
      throw new DesktopUiError("INPUT_DISABLED", "Application viewing now requires permanent registration.");
    }
    if (session.registeredViewIdentity) {
      if (typeof session.adapter.listWindows !== "function") {
        throw new DesktopUiError("INPUT_DISABLED", "Native OS window discovery is required for registered viewing.");
      }
      let observedTitle = "";
      try {
        const discovery = await listDiscoveredWindows(session.adapter, MAX_WINDOW_DISCOVERY_LIMIT);
        const observed = requireFreshWindowTarget(discovery, session.target.pid, session.target.nativeId);
        observedTitle = observed.title;
      } catch {
        throw new DesktopUiError("TARGET_NOT_FOUND", "Target window disappeared or native identity changed.");
      }
      if (observedTitle !== session.target.title) {
        throw new DesktopUiError("INPUT_DISABLED", "Window title changed after session binding; viewing denied.");
      }
      const currentRegistry = currentViewRegistry;
      const currentIdentity = await this.executableIdentity(session.target.pid);
      if (!currentRegistry || !currentIdentity ||
          evaluatePersistentAccess(currentRegistry, {
            kind: "desktop", app: currentIdentity, operation: "view",
            windowTitle: observedTitle,
          }).effect !== "allow" ||
          currentIdentity.sha256.toLowerCase() !== session.registeredViewIdentity.sha256.toLowerCase() ||
          currentIdentity.executablePath.toLowerCase() !== session.registeredViewIdentity.executablePath.toLowerCase()) {
        throw new DesktopUiError("INPUT_DISABLED", "Permanent application viewing was revoked.");
      }
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

    // V2 registry overrides ALL legacy input grants, including environment
    // allowlists and previously opened v1 sessions.
    const installed = this.permanentRegistry();
    if (installed && !session.registeredGrantId) {
      throw new DesktopUiError("INPUT_DISABLED", "Native input is not registered for this application.");
    }
    // Revoke takes effect on the very next input action, even while a
    // previously host-approved session remains open in the Core process.
    if (session.trustedGrantId && (!session.trustedTarget ||
      !this.trustedEntryStillActive(session.trustedTarget))) {
      this.consentManager.revokeConsent(session.trustedGrantId);
      throw new DesktopUiError("INPUT_DISABLED", "Trusted window approval has expired or was revoked.");
    }
    if (session.registeredGrantId) {
      if (typeof session.adapter.listWindows !== "function") {
        this.consentManager.revokeConsent(session.registeredGrantId);
        throw new DesktopUiError("INPUT_DISABLED", "Native OS window discovery is required for registered input.");
      }
      let observedTitle = "";
      let observedActive = false;
      try {
        const discovery = await listDiscoveredWindows(session.adapter, MAX_WINDOW_DISCOVERY_LIMIT);
        const observed = requireFreshWindowTarget(discovery, session.target.pid, session.target.nativeId);
        observedTitle = observed.title;
        observedActive = observed.active;
      } catch {
        this.consentManager.revokeConsent(session.registeredGrantId);
        throw new DesktopUiError("INPUT_DISABLED", "Target window disappeared or native identity changed.");
      }
      if (!observedActive || observedTitle !== session.target.title) {
        this.consentManager.revokeConsent(session.registeredGrantId);
        throw new DesktopUiError("INPUT_DISABLED", "Window title or foreground focus changed; input denied.");
      }
      // Revocation and executable replacement must prevent the *next* input.
      const currentRegistry = this.permanentRegistry();
      const currentIdentity = await this.executableIdentity(session.target.pid);
      if (!session.registeredIdentity || !currentIdentity ||
          currentIdentity.executablePath.toLowerCase() !== session.registeredIdentity.executablePath.toLowerCase() ||
          currentIdentity.sha256.toLowerCase() !== session.registeredIdentity.sha256.toLowerCase() ||
          !currentRegistry || !hasRegisteredDesktopInputCandidate(
            currentRegistry, currentIdentity, observedTitle)) {
        this.consentManager.revokeConsent(session.registeredGrantId);
        throw new DesktopUiError("INPUT_DISABLED", "Permanent app access was revoked or executable changed.");
      }
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
    if (session.sessionApprovalGrantId) this.consentManager.revokeConsent(session.sessionApprovalGrantId);
    if (session.registeredGrantId) this.consentManager.revokeConsent(session.registeredGrantId);
    return { closed: this.sessions.delete(sessionToken) };
  }

  clearAllSessions(): void {
    for (const session of this.sessions.values()) {
      if (session.trustedGrantId) this.consentManager.revokeConsent(session.trustedGrantId);
      if (session.sessionApprovalGrantId) this.consentManager.revokeConsent(session.sessionApprovalGrantId);
      if (session.registeredGrantId) this.consentManager.revokeConsent(session.registeredGrantId);
    }
    this.sessions.clear();
  }
}

export const desktopUiSessionManager = new DesktopUiSessionManager();

async function createDesktopUiSessionAccessRequest(input: {
  pid: unknown;
  nativeId: unknown;
  accessMode: "view" | "input";
  ttlMs?: number;
  reason?: unknown;
}): Promise<DesktopUiSessionAccessRequest> {
  const pid = Number(input.pid);
  const nativeId = typeof input.nativeId === "string" ? input.nativeId : "";
  const ttlMs = requireBoundedTtl(input.ttlMs);
  const discovery = await desktopUiSessionManager.listWindows();
  const matches = discovery.windows.filter(window =>
    window.pid === pid && window.nativeId === nativeId);
  if (matches.length !== 1) {
    throw new DesktopUiError("TARGET_NOT_FOUND", "The exact native window is missing or ambiguous.");
  }
  const target = matches[0];
  if (input.accessMode === "input" && !target.active) {
    throw new DesktopUiError("INPUT_DISABLED", "Native input requests require the exact target window to be foreground.");
  }
  return desktopUiSessionAccessRequests.create({
    principalId: LOCAL_DESKTOP_UI_OWNER,
    pid: target.pid,
    nativeId: target.nativeId,
    title: target.title,
    application: target.application,
    accessMode: input.accessMode,
    ttlMs,
    ...(typeof input.reason === "string" && input.reason.trim()
      ? { reason: input.reason.trim() } : {}),
  });
}



function sanitizeDesktopUiLogValue(value: unknown, key = ""): unknown {
  const normalizedKey = key.toLowerCase();
  if (typeof value === "string") {
    if (normalizedKey.includes("sessiontoken") || normalizedKey.includes("leasetoken") || normalizedKey.includes("authorizationtoken")) {
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
    .replace(/("leaseToken"\s*:\s*")[^"]*"/gi, '$1[REDACTED_TOKEN]"')
    .replace(/("authorizationToken"\s*:\s*")[^"]*"/gi, '$1[REDACTED_TOKEN]"')
    .replace(/("screenshotImage"\s*:\s*")[^"]*"/gi, '$1[IMAGE_BYTES]"')
    .replace(/("(?:image_base64|imageBase64|image)"\s*:\s*")[^"]*"/gi, '$1[IMAGE_BYTES]"')
    .replace(/("text"\s*:\s*")[^"]*"/gi, '$1[REDACTED_TEXT]"')
    .replace(/(sessionToken\s*[=:]\s*)\S+/gi, "$1[REDACTED_TOKEN]")
    .replace(/(leaseToken\s*[=:]\s*)\S+/gi, "$1[REDACTED_TOKEN]")
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
    "The open and inspect_window commands first create an exact-target one-shot session request in Tray Request Center; retry with approvalRequestId after native operator approval. " +
    "This does not bypass Host File Policy or permanent host ACL. Lifecycle mutation requires exact host consent; package mutation additionally requires separate host-operator approval bound to the exact operation.",
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
        description: "true requests one-session native input; false requests view-only. A Request Center native approval is required before session creation.",
      },
      approvalRequestId: {
        type: "string",
        minLength: 1,
        maxLength: 96,
        description: "Retry token returned with approvalPending after the operator approves this exact one-shot request in Tray > Request Center.",
      },
      reason: {
        type: "string",
        minLength: 1,
        maxLength: 240,
        description: "Human-readable reason shown to the operator in Request Center; never authority.",
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
        case "list_monitors":
          return JSON.stringify({ success: true, ...(await desktopUiSessionManager.listMonitors()) }, null, 2);
        case "get_active_window":
          return JSON.stringify({ success: true, window: await desktopUiSessionManager.getActiveWindow() }, null, 2);
        case "find_window":
          return JSON.stringify({ success: true, ...(await desktopUiSessionManager.findWindow({ query: args.query, pid: typeof args.pid === "number" ? args.pid : undefined, limit: typeof args.limit === "number" ? args.limit : undefined })) }, null, 2);
        case "inspect_window": {
          const approvalRequestId = typeof args.approvalRequestId === "string" ? args.approvalRequestId : "";
          if (!approvalRequestId) {
            const request = await createDesktopUiSessionAccessRequest({
              pid: args.pid,
              nativeId: args.nativeId,
              accessMode: "view",
              ttlMs: typeof args.ttlMs === "number" ? args.ttlMs : MIN_SESSION_TTL_MS,
              reason: args.reason,
            });
            return JSON.stringify({ success: true, approvalPending: true, request }, null, 2);
          }
          const approved = desktopUiSessionAccessRequests.consumeApproved(
            approvalRequestId, LOCAL_DESKTOP_UI_OWNER, {
              pid: Number(args.pid), nativeId: String(args.nativeId ?? ""), accessMode: "view",
            },
          );
          const snapshot = await desktopUiSessionManager.inspectWindow({
            pid: approved.pid,
            nativeId: approved.nativeId,
            ownerPrincipal: approved.principalId,
            includeScreenshotImage: args.includeScreenshotImage === true,
            maxImageBytes: typeof args.maxImageBytes === "number" ? args.maxImageBytes : undefined,
          });
          return JSON.stringify({ success: true, approvalConsumed: true, ...snapshot }, null, 2);
        }
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
          if (args.enableVision === true) {
            throw new DesktopUiError("INPUT_DISABLED",
              "Vision upload requires a separate host configuration and consent flow; it is not part of a Desktop UI session request.");
          }
          const approvalRequestId = typeof args.approvalRequestId === "string" ? args.approvalRequestId : "";
          if (!approvalRequestId) {
            const request = await createDesktopUiSessionAccessRequest({
              pid: args.pid,
              nativeId: args.nativeId,
              accessMode: args.allowInput === true ? "input" : "view",
              ttlMs: typeof args.ttlMs === "number" ? args.ttlMs : undefined,
              reason: args.reason,
            });
            return JSON.stringify({ success: true, approvalPending: true, request }, null, 2);
          }
          const approved = desktopUiSessionAccessRequests.consumeApproved(
            approvalRequestId, LOCAL_DESKTOP_UI_OWNER, {
              pid: Number(args.pid), nativeId: String(args.nativeId ?? ""),
              accessMode: args.allowInput === true ? "input" : "view",
            },
          );
          const session = await desktopUiSessionManager.openSession({
            pid: approved.pid,
            nativeId: approved.nativeId,
            title: approved.title,
            ownerPrincipal: approved.principalId,
            allowInput: approved.accessMode === "input",
            oneShotHostApproval: approved.accessMode === "input",
            enableVision: false,
            ttlMs: approved.ttlMs,
          });
          if (approved.accessMode === "input" && !session.inputAllowed) {
            desktopUiSessionManager.closeSession(session.sessionToken, approved.principalId);
            throw new DesktopUiError("INPUT_DISABLED",
              "The permanent host policy does not allow input for this exact application and window.");
          }
          return JSON.stringify({ success: true, approvalConsumed: true, session }, null, 2);
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
