/**
 * M4 Narrow Native Desktop UI Mediator.
 *
 * Enforces strict data-class isolation before any window perception or input:
 * - Third-party application windows (browsers, PDFs, chats, editors, file
 *   pickers) are classified as `third_party_window` and DENIED under v2 until
 *   provable file/content provenance mediation exists.
 * - Only attested SuperAgent-owned surfaces (matched by OS-verified
 *   executable path + SHA-256 + live birth-pinned window identity, NEVER by
 *   user-mode window title alone) may expose sanitized allowlisted semantic
 *   controls. Raw screenshots remain disabled by default.
 */
import { listDiscoveredWindows, MAX_WINDOW_DISCOVERY_LIMIT, requireFreshWindowTarget } from "./discovery.js";
import { resolveNativeDesktopExecutable } from "./nativeExecutableIdentity.js";
import { readPermanentAccessRegistryStatus, type PermanentRegistryStatus } from "./permanentRegistryStore.js";
import {
  evaluatePersistentAccess,
  type DesktopOperation,
  type ExecutableIdentity,
  type PersistentAccessPolicy,
} from "./persistentAccessPolicy.js";
import type { DesktopDiscoveredWindow, DesktopUiAdapter, DesktopUiElement, DesktopUiSchema } from "./types.js";

export type DesktopSurfaceClass = "owned_superagent_surface" | "third_party_window";

export type DesktopMediatorDenyCode =
  | "POLICY_STORE_UNAVAILABLE"
  | "TARGET_IDENTITY_MISMATCH"
  | "THIRD_PARTY_CONTENT_DENIED"
  | "HOST_FILE_POLICY_UNCERTIFIED"
  | "NATIVE_CONSENT_REQUIRED"
  | "SCREENSHOT_MEDIATION_DISABLED"
  | "ELEMENT_NOT_MEDIATED";

export interface MediatedDesktopDecision {
  allowed: boolean;
  surfaceClass: DesktopSurfaceClass;
  code: DesktopMediatorDenyCode | "ALLOWED";
  reason: string;
  window?: DesktopDiscoveredWindow;
  identity?: ExecutableIdentity;
}

export interface DesktopNativeMediatorOptions {
  ownedIdentities: ReadonlyArray<ExecutableIdentity>;
  registryStatus?: () => PermanentRegistryStatus;
  executableIdentity?: (pid: number) => Promise<ExecutableIdentity | null>;
  adapter?: DesktopUiAdapter;
}

const SAFE_OWNED_ELEMENT_ROLES = new Set([
  "button", "tab", "checkbox", "radio", "link", "menuitem",
  "heading", "text", "status", "alert", "region", "list",
  "listitem", "edit", "textbox", "combobox", "switch",
]);

const SENSITIVE_FIELD_RE = /\b(password|passcode|token|secret|bearer|oauth|credential|api[_-]?key|cookie)\b/i;
const LOCAL_PATH_RE = /(?:[A-Za-z]:\\[^\s"'<>]+|\/(?:Users|home|etc|var|tmp|private|opt)\/[^\s"'<>]+|file:\/\/[^\s"'<>]+)/gi;

function sameExecutableIdentity(a: ExecutableIdentity, b: ExecutableIdentity): boolean {
  if (a.platform !== b.platform) return false;
  if (a.sha256.toLowerCase() !== b.sha256.toLowerCase()) return false;
  return a.platform === "win32"
    ? a.executablePath.toLowerCase() === b.executablePath.toLowerCase()
    : a.executablePath === b.executablePath;
}

export function classifyDesktopSurface(
  identity: ExecutableIdentity | null,
  ownedIdentities: ReadonlyArray<ExecutableIdentity>,
): DesktopSurfaceClass {
  if (!identity) return "third_party_window";
  return ownedIdentities.some((owned) => sameExecutableIdentity(identity, owned))
    ? "owned_superagent_surface"
    : "third_party_window";
}

function redactOwnedText(value: string | null): string | null {
  if (value === null) return null;
  const pathRedacted = value.replace(LOCAL_PATH_RE, "[REDACTED_PATH]");
  if (SENSITIVE_FIELD_RE.test(pathRedacted)) return "[REDACTED_SENSITIVE_FIELD]";
  return pathRedacted;
}

/**
 * Strip uncertified element roles and redact any sensitive text or host file
 * paths before returning semantic elements from an owned surface.
 */
export function sanitizeMediatedElements(
  elements: ReadonlyArray<DesktopUiElement>,
): DesktopUiElement[] {
  const sanitized: DesktopUiElement[] = [];
  for (const element of elements) {
    const role = element.role.trim().toLowerCase();
    if (!SAFE_OWNED_ELEMENT_ROLES.has(role)) continue;
    const isPassword = role === "password" || (element.label ? SENSITIVE_FIELD_RE.test(element.label) : false);
    sanitized.push({
      ...element,
      label: redactOwnedText(element.label),
      description: isPassword ? "[REDACTED_SENSITIVE_FIELD]" : redactOwnedText(element.description),
      value: isPassword ? "[REDACTED_SENSITIVE_FIELD]" : redactOwnedText(element.value),
    });
  }
  return sanitized;
}

export function sanitizeMediatedSchema(schema: DesktopUiSchema): DesktopUiSchema {
  return {
    ...schema,
    elements: sanitizeMediatedElements(schema.elements),
  };
}

export class DesktopNativeMediator {
  private readonly ownedIdentities: ReadonlyArray<ExecutableIdentity>;
  private readonly registryStatus: () => PermanentRegistryStatus;
  private readonly executableIdentity: (pid: number) => Promise<ExecutableIdentity | null>;
  private readonly adapter?: DesktopUiAdapter;

  constructor(options: DesktopNativeMediatorOptions) {
    this.ownedIdentities = options.ownedIdentities;
    this.registryStatus = options.registryStatus ?? readPermanentAccessRegistryStatus;
    this.executableIdentity = options.executableIdentity ?? resolveNativeDesktopExecutable;
    this.adapter = options.adapter;
  }

  async verifyTarget(params: {
    pid: number;
    nativeId: string;
    expectedTitle: string;
    operation: DesktopOperation;
    requireActive?: boolean;
    includeScreenshotImage?: boolean;
    elementRole?: string;
    elementLabel?: string;
    pinnedIdentity?: ExecutableIdentity;
    adapter?: DesktopUiAdapter;
  }): Promise<MediatedDesktopDecision> {
    if (params.includeScreenshotImage === true) {
      return {
        allowed: false,
        surfaceClass: "third_party_window",
        code: "SCREENSHOT_MEDIATION_DISABLED",
        reason: "Raw desktop screenshots are disabled under M4 semantic-only mediation.",
      };
    }

    const reg = this.registryStatus();
    if (reg.status === "corrupt") {
      return {
        allowed: false,
        surfaceClass: "third_party_window",
        code: "POLICY_STORE_UNAVAILABLE",
        reason: "Permanent access registry is corrupt or unreadable; desktop mediation fails closed.",
      };
    }

    const activeAdapter = params.adapter ?? this.adapter;
    if (!activeAdapter || typeof activeAdapter.listWindows !== "function") {
      return {
        allowed: false,
        surfaceClass: "third_party_window",
        code: "TARGET_IDENTITY_MISMATCH",
        reason: "Native OS window discovery is required to verify live window identity.",
      };
    }

    let observed: DesktopDiscoveredWindow;
    try {
      const discovery = await listDiscoveredWindows(activeAdapter, MAX_WINDOW_DISCOVERY_LIMIT);
      observed = requireFreshWindowTarget(discovery, params.pid, params.nativeId);
    } catch {
      return {
        allowed: false,
        surfaceClass: "third_party_window",
        code: "TARGET_IDENTITY_MISMATCH",
        reason: "Target window is no longer present or nativeId changed.",
      };
    }

    if (observed.title !== params.expectedTitle) {
      return {
        allowed: false,
        surfaceClass: "third_party_window",
        code: "TARGET_IDENTITY_MISMATCH",
        reason: "Target window title changed after session binding.",
      };
    }
    if (params.requireActive && !observed.active) {
      return {
        allowed: false,
        surfaceClass: "third_party_window",
        code: "TARGET_IDENTITY_MISMATCH",
        reason: "Target window must be foreground/active for mediated input.",
      };
    }

    const identity = await this.executableIdentity(params.pid);
    if (!identity) {
      return {
        allowed: false,
        surfaceClass: "third_party_window",
        code: "TARGET_IDENTITY_MISMATCH",
        reason: "Unable to verify OS executable identity for target process.",
      };
    }
    if (params.pinnedIdentity && !sameExecutableIdentity(identity, params.pinnedIdentity)) {
      return {
        allowed: false,
        surfaceClass: "third_party_window",
        code: "TARGET_IDENTITY_MISMATCH",
        reason: "Process executable identity changed or PID was reused.",
      };
    }

    const surfaceClass = classifyDesktopSurface(identity, this.ownedIdentities);
    if (surfaceClass !== "owned_superagent_surface") {
      return {
        allowed: false,
        surfaceClass: "third_party_window",
        code: "THIRD_PARTY_CONTENT_DENIED",
        reason: "Third-party window content is denied under permanent file policy v2 until provenance mediation is established.",
      };
    }

    const policy: PersistentAccessPolicy | null = reg.policy;
    if (policy) {
      const access = evaluatePersistentAccess(policy, {
        kind: "desktop",
        app: identity,
        operation: params.operation,
        windowTitle: observed.title,
        ...(params.elementRole ? { elementRole: params.elementRole } : {}),
        ...(params.elementLabel ? { elementLabel: params.elementLabel } : {}),
      });
      if (access.effect !== "allow") {
        return {
          allowed: false,
          surfaceClass,
          code: "NATIVE_CONSENT_REQUIRED",
          reason: `Permanent host policy does not allow '${params.operation}' on this owned surface.`,
        };
      }
    } else if (params.operation === "input") {
      return {
        allowed: false,
        surfaceClass,
        code: "NATIVE_CONSENT_REQUIRED",
        reason: "Native host registration is required for mediated desktop input.",
      };
    }

    if (params.operation === "input" && params.elementRole &&
        !SAFE_OWNED_ELEMENT_ROLES.has(params.elementRole.trim().toLowerCase())) {
      return {
        allowed: false,
        surfaceClass,
        code: "ELEMENT_NOT_MEDIATED",
        reason: "Target UI element role is outside the mediated control allowlist.",
      };
    }

    return {
      allowed: true,
      surfaceClass,
      code: "ALLOWED",
      reason: "Verified owned SuperAgent surface and active host policy.",
      window: observed,
      identity,
    };
  }
}
