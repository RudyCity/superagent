/**
 * Windows attended Desktop Live semantic adapter. Construct only inside the trusted
 * local host, with the EXACT frame returned by captureFresh for this action.
 *
 * Never expose this factory, frame callback, or native binding through MCP/HTTP.
 * The old Windows coordinate dispatcher is deliberately not used.
 */
import { semanticElementHash } from "../remoteInputGuard.js";
import { sha256 } from "../png.js";
import type { RemoteHostScope } from "../remoteControlAuthority.js";
import type {
  RemoteNativeSemanticAction, RemoteNativeSemanticAdapter, RemoteNativeVerifiedFrame,
} from "../remoteNativeInputDispatch.js";
import type { DesktopUiElement } from "../types.js";

export interface WindowsNativeSemanticElement {
  nativeRef: string;
  role: string;
  label: string | null;
  description: string | null;
  value: string | null;
  actionable: boolean;
  focused: boolean;
  bounds: { x: number; y: number; width: number; height: number };
  center: { x: number; y: number };
  patterns: { invoke: boolean; value: boolean; scroll: boolean };
}

/** Returns an opaque native-owned proof of the live UIA observation. */
export interface WindowsNativeSemanticObservation {
  readonly element: Readonly<WindowsNativeSemanticElement>;
  readonly proof: string;
}

/** Strictly synchronous, same-process native functions, never child processes. */
export interface WindowsNativeSemanticBinding {
  inspect(scope: Readonly<RemoteHostScope>, nativeRef: string): WindowsNativeSemanticObservation | null;
  act(
    scope: Readonly<RemoteHostScope>, nativeRef: string,
    kind: "click" | "type" | "scroll", proof: string,
    text: string, deltaX: number, deltaY: number,
    authorizeNow: () => void,
  ): boolean;
}

export interface WindowsRemoteSemanticDependencies {
  readonly native: WindowsNativeSemanticBinding;
  /** Exact trusted fresh frame from the current dispatcher capture, not viewer cache. */
  readonly currentVerifiedFrame: () => RemoteNativeVerifiedFrame | null;
  /** Production defaults to the real OS. Exposed for deterministic deny-path tests. */
  readonly hostPlatform?: NodeJS.Platform;
  readonly now?: () => number;
}

function deny(): never { throw new Error("WINDOWS_SEMANTIC_INPUT_DENIED"); }

function sameScope(a: RemoteHostScope, b: RemoteHostScope): boolean {
  return a.platform === b.platform && a.pid === b.pid && a.nativeId === b.nativeId &&
    a.processBirthId === b.processBirthId && a.osUserId === b.osUserId &&
    a.hostSessionId === b.hostSessionId && a.hostGeneration === b.hostGeneration &&
    a.viewSessionId === b.viewSessionId;
}

/** Native DLL accepts canonical OS identities only; never guess an HWND or session. */
function validScope(s: RemoteHostScope): boolean {
  return s.platform === "win32" && Number.isSafeInteger(s.pid) && s.pid > 0 &&
    /^\d{1,20}$/.test(s.nativeId) &&
    /^filetime:[1-9]\d{0,19}$/.test(s.processBirthId) &&
    /^S-1-\d+(?:-\d+){1,15}$/i.test(s.osUserId) &&
    /^session:(?:0|[1-9]\d{0,9})$/.test(s.hostSessionId) &&
    Number.isSafeInteger(s.hostGeneration) && s.hostGeneration > 0 &&
    typeof s.viewSessionId === "string" && s.viewSessionId.length > 0;
}

function validElement(e: WindowsNativeSemanticElement): boolean {
  if (!e || typeof e.nativeRef !== "string" || !/^automationId:[A-Za-z0-9_.-]{1,80}$/.test(e.nativeRef) ||
      typeof e.role !== "string" || e.role.length > 80 ||
      typeof e.actionable !== "boolean" || typeof e.focused !== "boolean" ||
      !e.patterns || typeof e.patterns.invoke !== "boolean" ||
      typeof e.patterns.value !== "boolean" || typeof e.patterns.scroll !== "boolean" ||
      ![e.label, e.description, e.value].every(v => v === null || (typeof v === "string" && v.length <= 4096))) {
    return false;
  }
  const b = e.bounds;
  const c = e.center;
  return !!b && !!c &&
    [b.x, b.y, b.width, b.height, c.x, c.y].every(Number.isFinite) &&
    b.width > 0 && b.height > 0 && b.width <= 8192 && b.height <= 8192 &&
    c.x === b.x + b.width / 2 && c.y === b.y + b.height / 2;
}

function within(e: WindowsNativeSemanticElement, w: { x: number; y: number; width: number; height: number }): boolean {
  return e.bounds.x >= w.x && e.bounds.y >= w.y &&
    e.bounds.x + e.bounds.width <= w.x + w.width &&
    e.bounds.y + e.bounds.height <= w.y + w.height;
}

function requireExactFrame(input: RemoteNativeSemanticAction, frame: RemoteNativeVerifiedFrame | null, now: number): DesktopUiElement {
  if (!frame || frame.verifiedInsideCapture !== true || !sameScope(frame.hostScope, input.scope) ||
      frame.schema.version !== 1 || frame.schema.platform !== "win32" ||
      frame.schema.screenshot.revision !== input.screenshotRevision ||
      frame.schema.screenshot.sha256 !== input.screenshotSha256 ||
      sha256(frame.png) !== input.screenshotSha256 ||
      frame.schema.screenshot.targetWindow.pid !== input.scope.pid ||
      frame.schema.screenshot.targetWindow.nativeId !== input.scope.nativeId ||
      frame.schema.screenshot.targetWindow.active !== true) deny();
  const at = Date.parse(frame.schema.screenshot.capturedAt);
  if (!Number.isFinite(at) || at > now + 100 || now - at > 1500) deny();
  const matching = frame.schema.elements.filter(e =>
    e.nativeRef === input.action.nativeRef && e.source === "accessibility");
  if (matching.length !== 1 || frame.schema.elements.filter(e =>
      e.nativeRef === input.action.nativeRef).length !== 1) deny();
  const element = matching[0];
  if (element.actionable !== true || semanticElementHash(element) !== input.action.elementHash) deny();
  return element;
}

/**
 * This adapter does not install any input listener or route. The Authority owns
 * the one-shot approval and takeover epoch; the native binding rechecks HWND,
 * PID, birth, SID, OS session, focused element and UIA semantics in both calls.
 */
export function createWindowsRemoteSemanticAdapter(deps: WindowsRemoteSemanticDependencies): RemoteNativeSemanticAdapter {
  return {
    platform: "win32",
    nativeRefOnly: true,
    async dispatchVerifiedNativeRef(input, authorizeNow): Promise<void> {
      // Everything through act() is synchronous: no await, spawn or callback gap.
      if ((deps.hostPlatform ?? process.platform) !== "win32" || !validScope(input.scope) ||
          !deps.native || typeof deps.native.inspect !== "function" ||
          typeof deps.native.act !== "function" ||
          !/^automationId:[A-Za-z0-9_.-]{1,80}$/.test(input.action.nativeRef)) deny();

      const element = requireExactFrame(input, deps.currentVerifiedFrame(), (deps.now ?? Date.now)());
      const observation = deps.native.inspect(input.scope, input.action.nativeRef);
      if (!observation || typeof observation.proof !== "string" ||
          observation.proof.length < 16 || observation.proof.length > 16384 ||
          !validElement(observation.element) ||
          observation.element.nativeRef !== input.action.nativeRef ||
          !within(observation.element, deps.currentVerifiedFrame()!.schema.screenshot.targetWindow.bounds)) deny();

      const fresh: DesktopUiElement = {
        id: element.id, source: "accessibility", confidence: 1,
        role: observation.element.role, label: observation.element.label,
        description: observation.element.description, value: observation.element.value,
        actionable: observation.element.actionable, focused: observation.element.focused,
        nativeRef: observation.element.nativeRef, bounds: observation.element.bounds,
        center: observation.element.center,
      };
      if (semanticElementHash(fresh) !== input.action.elementHash ||
          !observation.element.actionable) deny();

      const action = input.action;
      if (action.kind === "key") deny(); // UIA has no generic semantic key pattern.
      if (action.kind === "click" && !observation.element.patterns.invoke) deny();
      if (action.kind === "type" &&
          (!observation.element.patterns.value || !observation.element.focused ||
           !/^(edit|editable text|text field|textbox|search box|search field|input)$/i.test(fresh.role))) deny();
      if (action.kind === "scroll" &&
          (!observation.element.patterns.scroll ||
           (action.deltaX === 0 && action.deltaY === 0))) deny();

      // Recheck the local frame after the native resolver; no external await.
      if (requireExactFrame(input, deps.currentVerifiedFrame(), (deps.now ?? Date.now)()) !== element) deny();
      // Native rechecks the HWND and UIA proof, then invokes the one-shot
      // authorization on the same stack immediately before the OS action.
      // Never authorize before a potentially slow native UIA resolution.
      if (!deps.native.act(input.scope, action.nativeRef, action.kind,
          observation.proof, action.kind === "type" ? action.text : "",
          action.kind === "scroll" ? action.deltaX : 0,
          action.kind === "scroll" ? action.deltaY : 0, authorizeNow)) {
        deny(); // Dispatcher marks post-checkpoint failure as UNCERTAIN and revokes.
      }
    },
  };
}
