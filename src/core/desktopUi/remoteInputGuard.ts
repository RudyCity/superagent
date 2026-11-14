/**
 * Strict semantic request validator for remote Desktop Live.
 * No input injection, network handler, raw coordinates or process selection.
 * Trusted host capture callback MUST freshly verify the exact native window,
 * screenshot pixels, accessibility tree and foreground status on every call.
 */
import { createHash } from "node:crypto";
import { DesktopUiError } from "./errors.js";
import type { DesktopUiElement, DesktopUiSchema, DesktopKey } from "./types.js";
import { RemoteControlAuthority, type RemoteActionLease,
  type RemoteHostScope, type RemoteInputKind, type RemotePrincipal } from "./remoteControlAuthority.js";

export const REMOTE_INPUT_MAX_CAPTURE_AGE_MS = 1_500;
export const REMOTE_INPUT_MAX_TEXT_LENGTH = 4_096;

export type RemoteInputRequest =
  | { kind: "click"; sequence: number; expectedRevision: number;
      expectedHash: string; elementId: string; expectedElementHash: string }
  | { kind: "type"; sequence: number; expectedRevision: number;
      expectedHash: string; elementId: string; expectedElementHash: string; text: string }
  | { kind: "key"; sequence: number; expectedRevision: number;
      expectedHash: string; elementId: string; expectedElementHash: string; key: DesktopKey }
  | { kind: "scroll"; sequence: number; expectedRevision: number;
      expectedHash: string; elementId: string; expectedElementHash: string;
      deltaX: number; deltaY: number };

export type VerifiedRemoteInput =
  | { kind: "click"; nativeRef: string; elementHash: string }
  | { kind: "type"; nativeRef: string; elementHash: string; text: string }
  | { kind: "key"; nativeRef: string; elementHash: string; key: DesktopKey }
  | { kind: "scroll"; nativeRef: string; elementHash: string; deltaX: number; deltaY: number };

export interface RemoteInputPermit {
  /** This carries only semantic identity, never an untrusted screen point. */
  readonly action: Readonly<VerifiedRemoteInput>;
  readonly signal: AbortSignal;
  assertLive(): void;
  /** One-shot, synchronous native-boundary check; must precede native dispatch. */
  consumeForNativeDispatch(): void;
  finish(): void;
}

const allowedKeys: readonly DesktopKey[] = [
  "ENTER", "TAB", "ESCAPE", "BACKSPACE", "DELETE", "ARROW_UP",
  "ARROW_DOWN", "ARROW_LEFT", "ARROW_RIGHT", "HOME", "END",
  "PAGE_UP", "PAGE_DOWN", "SPACE",
];

function invalid(message: string): never {
  throw new DesktopUiError("INVALID_ACTION", message);
}

function isRecord(raw: unknown): raw is Record<string, unknown> {
  return raw !== null && typeof raw === "object" && !Array.isArray(raw);
}

function exactKeys(body: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(body).length === allowed.length &&
    Object.keys(body).every(key => allowed.includes(key));
}

function hash(value: unknown): boolean {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

/** A stable digest of EXACT accessibility semantics, not vision guesses. */
export function semanticElementHash(element: DesktopUiElement): string {
  return createHash("sha256").update(JSON.stringify({
    id: element.id,
    source: element.source,
    nativeRef: element.nativeRef ?? null,
    role: element.role,
    label: element.label,
    description: element.description,
    value: element.value,
    actionable: element.actionable,
    focused: element.focused ?? null,
    bounds: {
      x: element.bounds.x, y: element.bounds.y,
      width: element.bounds.width, height: element.bounds.height,
    },
    center: { x: element.center.x, y: element.center.y },
  })).digest("hex");
}

/** Parses a wire payload without coerce/truncation, unsafe extra keys or points. */
export function parseRemoteInputRequest(raw: unknown): RemoteInputRequest {
  if (!isRecord(raw)) invalid("Remote input must be an object.");
  const kind = raw.kind;
  if (typeof kind !== "string" || !["click", "type", "key", "scroll"].includes(kind)) {
    invalid("Unsupported remote input action.");
  }
  const common = ["kind", "sequence", "expectedRevision", "expectedHash",
    "elementId", "expectedElementHash"];
  const names = kind === "type" ? [...common, "text"] :
    kind === "key" ? [...common, "key"] :
    kind === "scroll" ? [...common, "deltaX", "deltaY"] : common;
  if (!exactKeys(raw, names) ||
      !Number.isSafeInteger(raw.sequence) || Number(raw.sequence) < 1 ||
      !Number.isSafeInteger(raw.expectedRevision) || Number(raw.expectedRevision) < 1 ||
      !hash(raw.expectedHash) || !hash(raw.expectedElementHash) ||
      typeof raw.elementId !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/i.test(raw.elementId)) {
    invalid("Malformed, unscoped or non-semantic remote input request.");
  }
  const base = {
    sequence: raw.sequence as number,
    expectedRevision: raw.expectedRevision as number,
    expectedHash: raw.expectedHash as string,
    elementId: raw.elementId as string,
    expectedElementHash: raw.expectedElementHash as string,
  };
  if (kind === "type") {
    if (typeof raw.text !== "string" || raw.text.length < 1 ||
        raw.text.length > REMOTE_INPUT_MAX_TEXT_LENGTH ||
        /[\u0000-\u001f\u007f]/.test(raw.text)) invalid("Unsafe remote text payload.");
    return { ...base, kind, text: raw.text };
  }
  if (kind === "key") {
    if (!allowedKeys.includes(raw.key as DesktopKey)) invalid("Unsupported remote key or shortcut.");
    return { ...base, kind, key: raw.key as DesktopKey };
  }
  if (kind === "scroll") {
    if (!Number.isInteger(raw.deltaX) || !Number.isInteger(raw.deltaY) ||
        Math.abs(raw.deltaX as number) > 3 || Math.abs(raw.deltaY as number) > 3 ||
        (raw.deltaX === 0 && raw.deltaY === 0)) invalid("Invalid remote scroll delta.");
    return { ...base, kind, deltaX: raw.deltaX as number, deltaY: raw.deltaY as number };
  }
  return { ...base, kind: "click" };
}

function assertFresh(
  schema: DesktopUiSchema | null,
  request: RemoteInputRequest,
  scope: RemoteHostScope,
  now: number,
): asserts schema is DesktopUiSchema {
  if (!schema || schema.version !== 1 || schema.platform !== scope.platform ||
      schema.screenshot.revision !== request.expectedRevision ||
      schema.screenshot.sha256 !== request.expectedHash ||
      !hash(schema.screenshot.sha256)) {
    throw new DesktopUiError("STALE_SCREENSHOT", "Fresh verified screenshot identity does not match.");
  }
  const capture = schema.screenshot;
  const window = capture.targetWindow;
  const at = Date.parse(capture.capturedAt);
  if (!Number.isFinite(at) || at > now + 100 || now - at > REMOTE_INPUT_MAX_CAPTURE_AGE_MS ||
      !Number.isSafeInteger(capture.revision) || capture.revision < 1 ||
      !Number.isSafeInteger(window.pid) || window.pid !== scope.pid ||
      window.nativeId !== scope.nativeId || window.active !== true ||
      !Number.isFinite(capture.width) || !Number.isFinite(capture.height) ||
      capture.width <= 0 || capture.height <= 0 ||
      !Number.isFinite(window.bounds.width) || !Number.isFinite(window.bounds.height) ||
      window.bounds.width <= 0 || window.bounds.height <= 0) {
    throw new DesktopUiError("STALE_SCREENSHOT", "Capture is stale, unfocused, or from another native window.");
  }
}

function resolveSemanticElement(schema: DesktopUiSchema, request: RemoteInputRequest): DesktopUiElement {
  const candidates = schema.elements.filter(e => e.id === request.elementId);
  if (candidates.length !== 1) {
    throw new DesktopUiError("ELEMENT_NOT_FOUND", "Remote element is missing or ambiguous.");
  }
  const element = candidates[0];
  if (element.source !== "accessibility" || element.actionable !== true ||
      typeof element.nativeRef !== "string" || element.nativeRef.length < 1 ||
      element.nativeRef.length > 256 || /[\u0000-\u001f\u007f]/.test(element.nativeRef) ||
      schema.elements.filter(e => e.nativeRef === element.nativeRef).length !== 1 ||
      semanticElementHash(element) !== request.expectedElementHash) {
    throw new DesktopUiError("ELEMENT_NOT_ACTIONABLE",
      "A unique, actionable, hash-matched native accessibility element is required.");
  }
  const b = element.bounds;
  const w = schema.screenshot.targetWindow.bounds;
  if (![b.x, b.y, b.width, b.height, element.center.x, element.center.y,
        w.x, w.y, w.width, w.height].every(Number.isFinite) ||
      b.width <= 0 || b.height <= 0 || w.width <= 0 || w.height <= 0 ||
      b.x < w.x || b.y < w.y || b.x + b.width > w.x + w.width ||
      b.y + b.height > w.y + w.height ||
      element.center.x < b.x || element.center.x >= b.x + b.width ||
      element.center.y < b.y || element.center.y >= b.y + b.height) {
    throw new DesktopUiError("ELEMENT_NOT_ACTIONABLE", "Native element is outside the exact window.");
  }
  if (request.kind === "type" &&
      !/^(edit|editable text|text field|textbox|search box|search field|input)$/i.test(element.role)) {
    throw new DesktopUiError("ELEMENT_NOT_ACTIONABLE", "Remote typing requires an exact editable accessibility control.");
  }
  if ((request.kind === "type" || request.kind === "key") && element.focused !== true) {
    throw new DesktopUiError("ELEMENT_NOT_ACTIONABLE", "Remote typing/keys require an exact focused accessibility control.");
  }
  return element;
}

/**
 * The host verifier must perform a NEW capture and accessibility comparison
 * inside its native window session; cached viewer frames are insufficient.
 * No permit invokes adapter.dispatch or exposes a coordinate fallback.
 */
export class RemoteInputGuard {
  constructor(
    private readonly control: RemoteControlAuthority,
    private readonly getFreshVerifiedSchema: (scope: Readonly<RemoteHostScope>) => Promise<DesktopUiSchema | null>,
    private readonly now: () => number = Date.now,
  ) {}

  async prepare(
    caller: RemotePrincipal, token: unknown, raw: unknown,
  ): Promise<RemoteInputPermit> {
    const request = parseRemoteInputRequest(raw);
    const lease: RemoteActionLease =
      this.control.beginAction(caller, token, request.kind as RemoteInputKind, request.sequence);
    try {
      const schema = await this.getFreshVerifiedSchema(lease.scope);
      lease.assertLive(); // Host may revoke/take over while awaiting native capture.
      assertFresh(schema, request, lease.scope, this.now());
      const element = resolveSemanticElement(schema, request);
      lease.assertLive();
      let action: VerifiedRemoteInput;
      switch (request.kind) {
        case "click":
          action = { kind: "click", nativeRef: element.nativeRef!, elementHash: request.expectedElementHash };
          break;
        case "type":
          action = { kind: "type", nativeRef: element.nativeRef!, elementHash: request.expectedElementHash, text: request.text };
          break;
        case "key":
          action = { kind: "key", nativeRef: element.nativeRef!, elementHash: request.expectedElementHash, key: request.key };
          break;
        case "scroll":
          action = { kind: "scroll", nativeRef: element.nativeRef!, elementHash: request.expectedElementHash,
            deltaX: request.deltaX, deltaY: request.deltaY };
          break;
      }
      return {
        action: Object.freeze(action),
        signal: lease.signal,
        assertLive: lease.assertLive,
        consumeForNativeDispatch: lease.consumeForNativeDispatch,
        finish: lease.finish,
      };
    } catch (error) {
      lease.finish();
      throw error;
    }
  }
}
