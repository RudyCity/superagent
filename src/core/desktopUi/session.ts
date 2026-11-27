import { DesktopUiError } from "./errors.js";
import {
  DEFAULT_MAX_FRAME_CHANGE_RATIO,
  framesEquivalent,
  frameChangeRatio,
  regionChangeRatio,
  type FrameRegion,
} from "./frames.js";
import { readPngSize, sha256 } from "./png.js";
import {
  recordCaptureFrame,
  recordCaptureSourceFallback,
  recordSnapshotSample,
} from "./desktopUiMetrics.js";
import type {
  AccessibilitySnapshot,
  DesktopActionReceipt,
  DesktopBounds,
  DesktopModifier,
  DesktopPoint,
  DesktopUiCapabilities,
  DesktopUiElement,
  DesktopUiSchema,
  DesktopUiSessionOptions,
  DesktopWindowCaptureSource,
  DesktopKey,
  DesktopScreenshotIdentity,
  DesktopWindowTarget,
  NativeCapture,
  NativeDesktopAction,
  VisionDetection,
} from "./types.js";

/**
 * Capability probing spawns a full OS helper process (~0.8-1.5 s on Windows).
 * Re-probing for every snapshot and every pre-action check tripled the time a
 * live window had to stay still, so a short memoization window is used while
 * availability is healthy. Failures are never cached.
 */
const CAPABILITIES_TTL_MS = 5_000;

function center(bounds: DesktopBounds): DesktopPoint {
  return {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2,
  };
}

function sameBounds(a: DesktopBounds, b: DesktopBounds): boolean {
  return a.x === b.x
    && a.y === b.y
    && a.width === b.width
    && a.height === b.height;
}

/**
 * Accessibility bounds may jitter by a device pixel between two UIA reads
 * without the control moving. Larger deltas mean layout/scroll/DOM changes and
 * are treated as a different control position.
 */
const ELEMENT_BOUNDS_TOLERANCE_PX = 2;

/**
 * Share of the selected control's own pixels allowed to change between
 * perception and dispatch. Accessibility already fences role/label/position;
 * this budget only rejects a visually replaced control (for example a
 * same-labelled element swapped for a different one at the same bounds).
 */
const ELEMENT_REGION_CHANGE_BUDGET = 0.35;

/**
 * Perception is assembled from ONE capture plus ONE accessibility read. A
 * second "confirmation" capture used to compare whole-window pixels before a
 * schema was returned; it doubled capture cost and still could not prove
 * anything about the frame a caller would act on. Stability is now enforced
 * where it actually protects input: the same-window identity fence between
 * capture and UIA, the element fence, and the pre-action frame/region checks in
 * prepareInput().
 *
 * The one caller that still needs the old pixel diagnostic is `wait_ready`,
 * which exists precisely to poll a settling window: it opts in with
 * `measureChangeRatio`, paying a single extra capture and keeping the visual
 * budget as a retry signal. Plain `snapshot` never pays that capture.
 */

function sameElementBounds(a: DesktopBounds, b: DesktopBounds): boolean {
  return Math.abs(a.x - b.x) <= ELEMENT_BOUNDS_TOLERANCE_PX
    && Math.abs(a.y - b.y) <= ELEMENT_BOUNDS_TOLERANCE_PX
    && Math.abs(a.width - b.width) <= ELEMENT_BOUNDS_TOLERANCE_PX
    && Math.abs(a.height - b.height) <= ELEMENT_BOUNDS_TOLERANCE_PX;
}

/**
 * Element-level fencing: identity fields plus a bounded position tolerance.
 * Varying text content (value) is intentionally excluded so live editors can
 * stream while a control stays at the same place.
 */
function sameElementIdentity(a: DesktopUiElement, b: DesktopUiElement): boolean {
  return a.role === b.role
    && a.label === b.label
    && a.description === b.description
    && a.nativeRef === b.nativeRef
    && sameElementBounds(a.bounds, b.bounds);
}

function containsActionableElement(elements: DesktopUiElement[], target: DesktopUiElement): boolean {
  return elements.some((candidate) => candidate.actionable && sameElementIdentity(candidate, target));
}

/**
 * Bounded pixel region of one control inside the captured frame, derived from
 * the accessibility screen bounds and the screenshot/window ratio.
 */
function elementFrameRegion(schema: DesktopUiSchema, element: DesktopUiElement): FrameRegion | null {
  const window = schema.screenshot.targetWindow.bounds;
  const ratioX = schema.screenshot.pixelRatioX;
  const ratioY = schema.screenshot.pixelRatioY;
  if (!Number.isFinite(ratioX) || ratioX <= 0 || !Number.isFinite(ratioY) || ratioY <= 0) return null;
  const x = (element.bounds.x - window.x) * ratioX;
  const y = (element.bounds.y - window.y) * ratioY;
  const width = element.bounds.width * ratioX;
  const height = element.bounds.height * ratioY;
  if (![x, y, width, height].every(Number.isFinite) || width < 1 || height < 1) return null;
  return { x, y, width, height };
}

function sameWindowIdentity(
  a: { pid: number; nativeId: string; bounds: DesktopBounds },
  b: { pid: number; nativeId: string; bounds: DesktopBounds },
): boolean {
  return a.pid === b.pid
    && a.nativeId === b.nativeId
    && sameBounds(a.bounds, b.bounds);
}

function overlapRatio(a: DesktopBounds, b: DesktopBounds): number {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= left || bottom <= top) return 0;
  const intersection = (right - left) * (bottom - top);
  return intersection / Math.min(a.width * a.height, b.width * b.height);
}

function accessibilityElements(snapshot: AccessibilitySnapshot): DesktopUiElement[] {
  return snapshot.elements.map((element, index) => ({
    ...element,
    id: `a${index + 1}`,
    source: "accessibility" as const,
    confidence: 1,
  }));
}

function visionElements(
  detections: VisionDetection[],
  capture: NativeCapture,
  width: number,
  height: number,
  existing: DesktopUiElement[],
): DesktopUiElement[] {
  const window = capture.targetWindow;
  const scaleX = width / window.bounds.width;
  const scaleY = height / window.bounds.height;
  if (!Number.isFinite(scaleX) || scaleX <= 0 || !Number.isFinite(scaleY) || scaleY <= 0) {
    return [];
  }

  const output: DesktopUiElement[] = [];
  for (const detection of detections) {
    const [x1, y1, x2, y2] = detection.box;
    const bounds: DesktopBounds = {
      x: window.bounds.x + x1 / scaleX,
      y: window.bounds.y + y1 / scaleY,
      width: (x2 - x1) / scaleX,
      height: (y2 - y1) / scaleY,
    };
    if (
      bounds.x < window.bounds.x - 1
      || bounds.y < window.bounds.y - 1
      || bounds.x + bounds.width > window.bounds.x + window.bounds.width + 1
      || bounds.y + bounds.height > window.bounds.y + window.bounds.height + 1
    ) {
      continue;
    }
    if (existing.some((element) => overlapRatio(element.bounds, bounds) >= 0.5)) {
      continue;
    }
    output.push({
      id: `v${output.length + 1}`,
      role: detection.role,
      label: null,
      description: null,
      value: null,
      bounds,
      center: center(bounds),
      source: "vision",
      confidence: detection.score,
      actionable: false,
    });
  }
  return output;
}

export class DesktopUiSession {
  private readonly options: DesktopUiSessionOptions;
  private revision = 0;
  private current: { capture: NativeCapture; schema: DesktopUiSchema } | null = null;
  private pinnedTarget: DesktopWindowTarget | null = null;
  private operationTail: Promise<void> = Promise.resolve();
  private capabilities: { at: number; value: DesktopUiCapabilities } | null = null;
  private captureSource: DesktopWindowCaptureSource | null = null;
  private captureFallbackReason: string | null = null;

  constructor(options: DesktopUiSessionOptions) {
    this.options = {
      ...options,
      allowInput: options.allowInput === true,
    };
    this.captureSource = options.captureSource ?? null;
  }

  async probe() {
    return this.options.adapter.probe();
  }

  /**
   * Best-effort carrier warm-up used once by DesktopUiSessionManager.openSession:
   * one capability probe, one frame through the persistent capture worker and
   * one accessibility read through the persistent UIA carrier. The results are
   * discarded; the point is that the first real snapshot finds every helper
   * already running. This never decides authority and must never be treated as
   * a perception revision.
   */
  async warmCarriers(): Promise<void> {
    await this.runExclusive(async () => {
      // Probe is memoized for a few seconds; without this the first snapshot
      // would still pay a cold helper process for capabilities.
      await this.capabilitiesCached();
      const target = this.currentTarget();
      const capture = await this.captureFrame(target);
      await this.options.adapter.inspectAccessibility(target, capture);
    });
  }

  /**
   * Perceive the scoped window once. `measureChangeRatio` is an internal
   * wait_ready-only diagnostic; see the stability comment above.
   */
  async snapshot(options: { measureChangeRatio?: boolean } = {}): Promise<DesktopUiSchema> {
    return this.runExclusive(async () => {
      const startedAt = performance.now();
      let changeRatio: number | null = null;
      try {
        const schema = await this.snapshotUnlocked(options.measureChangeRatio === true);
        changeRatio = schema.screenshot.changeRatio ?? null;
        recordSnapshotSample({
          latencyMs: performance.now() - startedAt,
          ok: true,
          changeRatio,
        });
        return schema;
      } catch (error) {
        recordSnapshotSample({
          latencyMs: performance.now() - startedAt,
          ok: false,
          changeRatio: null,
        });
        throw error;
      }
    });
  }

  private async capabilitiesCached(): Promise<DesktopUiCapabilities> {
    const now = Date.now();
    if (this.capabilities && now - this.capabilities.at < CAPABILITIES_TTL_MS) {
      return this.capabilities.value;
    }
    const value = await this.options.adapter.probe();
    this.capabilities = value.available ? { at: now, value } : null;
    return value;
  }

  /**
   * Prefer the persistent, identity-verified capture source (one helper process
   * per session, HWND/PID/title/bounds re-verified per frame). Any refusal
   * permanently falls back to the one-shot adapter capture for this session and
   * is surfaced as a warning; it never weakens the identity checks that follow.
   */
  private async captureFrame(target: DesktopWindowTarget): Promise<NativeCapture> {
    const source = this.captureSource;
    if (source) {
      try {
        const capture = await source.capture();
        recordCaptureFrame("persistent");
        return capture;
      } catch {
        this.captureSource = null;
        recordCaptureSourceFallback();
        try { source.close(); } catch { /* ignore */ }
        this.captureFallbackReason = "Native capture source refused; using one-shot capture for this session.";
      }
    }
    recordCaptureFrame("one-shot");
    return this.options.adapter.capture(target);
  }

  /** Release the persistent capture source; safe to call more than once. */
  close(): void {
    const source = this.captureSource;
    this.captureSource = null;
    if (source) {
      try { source.close(); } catch { /* ignore */ }
    }
    this.current = null;
  }

  private async snapshotUnlocked(measureChangeRatio = false): Promise<DesktopUiSchema> {
    const capabilities = await this.capabilitiesCached();
    if (!capabilities.available || !capabilities.screenshot) {
      throw new DesktopUiError(
        "SCREENSHOT_UNAVAILABLE",
        capabilities.errors.join("; ") || "Native screenshot capture is unavailable.",
      );
    }
    if (!capabilities.accessibility) {
      throw new DesktopUiError(
        "ACCESSIBILITY_UNAVAILABLE",
        capabilities.errors.join("; ") || "Native accessibility inspection is unavailable.",
      );
    }

    const capture = await this.captureFrame(this.currentTarget());
    const candidateTarget = this.pinnedTarget ?? {
      ...this.options.target,
      nativeId: capture.targetWindow.nativeId,
      title: capture.targetWindow.title,
    };

    const size = readPngSize(capture.image);
    const hash = sha256(capture.image);
    const accessibility = await this.options.adapter.inspectAccessibility(candidateTarget, capture);
    if (!sameWindowIdentity(capture.targetWindow, accessibility.window)) {
      throw new DesktopUiError(
        "STALE_SCREENSHOT",
        "Target window identity or bounds changed between screenshot capture and accessibility inspection.",
      );
    }

    // Single-capture assembly. Identity between the frame and the UIA read is
    // still fail-closed above; visual stability is enforced before dispatch.
    // wait_ready opts into the legacy settle check below, because its whole
    // purpose is to wait out animation and it needs the changeRatio diagnostic.
    let assembledChangeRatio: number | null = null;
    if (measureChangeRatio) {
      const settled = await this.captureFrame(candidateTarget);
      if (!sameWindowIdentity(capture.targetWindow, settled.targetWindow)) {
        throw new DesktopUiError(
          "STALE_SCREENSHOT",
          "Target window identity or bounds changed while the screenshot schema was being assembled.",
        );
      }
      assembledChangeRatio = frameChangeRatio(capture.image, settled.image);
      const settledStable = assembledChangeRatio === null
        ? sha256(settled.image) === hash
        : assembledChangeRatio <= DEFAULT_MAX_FRAME_CHANGE_RATIO;
      if (!settledStable) {
        throw new DesktopUiError(
          "STALE_SCREENSHOT",
          "Target window changed beyond the allowed visual budget while the screenshot schema was being assembled.",
        );
      }
    }

    const elements = accessibilityElements(accessibility);
    const warnings = [...(accessibility.warnings ?? [])];
    if (this.captureFallbackReason) warnings.push(this.captureFallbackReason);
    if (assembledChangeRatio !== null && assembledChangeRatio > 0) {
      warnings.push(
        `Perception assembled while ${(assembledChangeRatio * 100).toFixed(1)}% of sampled pixels changed (within budget).`,
      );
    }

    if (this.options.vision) {
      try {
        const detections = await this.options.vision.detect(capture.image);
        elements.push(...visionElements(detections, capture, size.width, size.height, elements));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        warnings.push(`Vision fallback unavailable: ${message}`);
      }
    }

    this.revision += 1;
    const screenshot: DesktopScreenshotIdentity = {
      revision: this.revision,
      sha256: hash,
      capturedAt: capture.capturedAt,
      width: size.width,
      height: size.height,
      pixelRatioX: size.width / capture.targetWindow.bounds.width,
      pixelRatioY: size.height / capture.targetWindow.bounds.height,
      targetWindow: accessibility.window,
      ...(assembledChangeRatio !== null ? { changeRatio: assembledChangeRatio } : {}),
    };
    const schema: DesktopUiSchema = {
      version: 1,
      platform: this.options.adapter.platform,
      screenshot,
      windows: [accessibility.window],
      elements,
      warnings,
    };
    this.current = { capture, schema };
    if (!this.pinnedTarget) this.pinnedTarget = candidateTarget;
    return schema;
  }

  async click(input: { elementId: string; expectedRevision: number; expectedHash: string }): Promise<DesktopActionReceipt> {
    return this.runExclusive(async () => {
      const element = this.resolveElement(this.requireCurrentSchema(), input.elementId);
      const state = await this.prepareInput(input.expectedRevision, input.expectedHash, element);
      return this.dispatchAndVerify({
        kind: "click",
        target: this.currentTarget(),
        point: element.center,
        element,
      }, state.schema.screenshot);
    });
  }

  async type(input: {
    elementId: string;
    text: string;
    expectedRevision: number;
    expectedHash: string;
  }): Promise<DesktopActionReceipt> {
    return this.runExclusive(async () => {
      if (typeof input.text !== "string" || input.text.length > 32_768) {
        throw new DesktopUiError("INVALID_ACTION", "Text input must be a string no longer than 32768 characters.");
      }
      const element = this.resolveElement(this.requireCurrentSchema(), input.elementId);
      const state = await this.prepareInput(input.expectedRevision, input.expectedHash, element);
      return this.dispatchAndVerify({
        kind: "type",
        target: this.currentTarget(),
        point: element.center,
        element,
        text: input.text,
      }, state.schema.screenshot);
    });
  }

  async key(input: {
    key: DesktopKey;
    modifiers?: DesktopModifier[];
    expectedRevision: number;
    expectedHash: string;
  }): Promise<DesktopActionReceipt> {
    return this.runExclusive(async () => {
      const state = await this.prepareInput(input.expectedRevision, input.expectedHash);
      const navigationKeys: ReadonlySet<DesktopKey> = new Set([
        "TAB", "ESCAPE", "ARROW_UP", "ARROW_DOWN", "ARROW_LEFT", "ARROW_RIGHT",
        "HOME", "END", "PAGE_UP", "PAGE_DOWN",
      ]);
      if (!navigationKeys.has(input.key) || (input.modifiers?.length ?? 0) > 0) {
        const focused = state.schema.elements.filter(
          (element) => element.source === "accessibility" && element.focused === true,
        );
        if (focused.length !== 1 || !focused[0].actionable) {
          throw new DesktopUiError(
            "ELEMENT_NOT_ACTIONABLE",
            "Mutating key input requires exactly one verified focused accessibility control.",
          );
        }
      }
      return this.dispatchAndVerify({
        kind: "key",
        target: this.currentTarget(),
        key: input.key,
        modifiers: input.modifiers ?? [],
      }, state.schema.screenshot);
    });
  }

  async scroll(input: {
    elementId: string;
    deltaX?: number;
    deltaY?: number;
    expectedRevision: number;
    expectedHash: string;
  }): Promise<DesktopActionReceipt> {
    return this.runExclusive(async () => {
      const deltaX = Math.trunc(input.deltaX ?? 0);
      const deltaY = Math.trunc(input.deltaY ?? 0);
      if (
        (deltaX === 0 && deltaY === 0)
        || Math.abs(deltaX) > 3
        || Math.abs(deltaY) > 3
      ) {
        throw new DesktopUiError("INVALID_ACTION", "Scroll deltas must be integers between -3 and 3 and not both zero.");
      }
      const element = this.resolveElement(this.requireCurrentSchema(), input.elementId);
      const state = await this.prepareInput(input.expectedRevision, input.expectedHash, element);
      return this.dispatchAndVerify({
        kind: "scroll",
        target: this.currentTarget(),
        point: element.center,
        element,
        deltaX,
        deltaY,
      }, state.schema.screenshot);
    });
  }

  private resolveElement(schema: DesktopUiSchema, elementId: string): DesktopUiElement {
    const element = schema.elements.find((candidate) => candidate.id === elementId);
    if (!element) {
      throw new DesktopUiError("ELEMENT_NOT_FOUND", `Element '${elementId}' is not present in the current screenshot schema.`);
    }
    if (!element.actionable || element.source !== "accessibility") {
      throw new DesktopUiError(
        "ELEMENT_NOT_ACTIONABLE",
        element.source === "vision"
          ? `Element '${elementId}' is vision-only and cannot receive native input without accessibility confirmation.`
          : `Element '${elementId}' is not actionable.`,
      );
    }
    const rect = schema.screenshot.targetWindow.bounds;
    const { x, y } = element.center;
    if (
      ![x, y, element.bounds.x, element.bounds.y, element.bounds.width, element.bounds.height].every(Number.isFinite)
      || element.bounds.width <= 0
      || element.bounds.height <= 0
      || x < rect.x || x >= rect.x + rect.width
      || y < rect.y || y >= rect.y + rect.height
    ) {
      throw new DesktopUiError("ELEMENT_NOT_ACTIONABLE", "Actionable element center must remain inside the scoped window.");
    }
    return element;
  }

  private requireCurrentSchema(): DesktopUiSchema {
    if (!this.current) {
      throw new DesktopUiError("STALE_SCREENSHOT", "Capture a screenshot schema before sending native input.");
    }
    return this.current.schema;
  }

  private async prepareInput(expectedRevision: number, expectedHash: string, target?: DesktopUiElement) {
    if (!this.options.allowInput) {
      throw new DesktopUiError(
        "INPUT_DISABLED",
        "Native desktop input is disabled. The integrator must opt in for the active session.",
      );
    }
    const capabilities = await this.capabilitiesCached();
    if (!capabilities.input) {
      throw new DesktopUiError(
        "INPUT_UNAVAILABLE",
        capabilities.errors.join("; ") || "Native desktop input is unavailable.",
      );
    }
    if (!this.current) {
      throw new DesktopUiError("STALE_SCREENSHOT", "Capture a screenshot schema before sending native input.");
    }

    const { capture, schema } = this.current;
    if (
      schema.screenshot.revision !== expectedRevision
      || schema.screenshot.sha256 !== expectedHash
    ) {
      throw new DesktopUiError(
        "STALE_SCREENSHOT",
        "The requested screenshot revision/hash is no longer current.",
      );
    }

    // Fresh frame must stay inside the visual budget: identical for static
    // targets, tolerant for live apps, still fail-closed for gross changes.
    const freshCapture = await this.captureFrame(this.currentTarget());
    if (
      !sameWindowIdentity(schema.screenshot.targetWindow, freshCapture.targetWindow)
      || !framesEquivalent(capture.image, freshCapture.image)
    ) {
      throw new DesktopUiError(
        "STALE_SCREENSHOT",
        "The target window changed after perception; capture a new schema before sending input.",
      );
    }
    if (!freshCapture.targetWindow.active) {
      throw new DesktopUiError("TARGET_NOT_ACTIVE", "The scoped window must be foreground before native input.");
    }

    const latestAccessibility = await this.options.adapter.inspectAccessibility(this.currentTarget(), freshCapture);
    if (!sameWindowIdentity(schema.screenshot.targetWindow, latestAccessibility.window)) {
      throw new DesktopUiError("STALE_SCREENSHOT", "Target window identity changed during pre-action accessibility verification.");
    }
    const latestElements = accessibilityElements(latestAccessibility);
    if (target) {
      // Element-level fence: the exact control the caller selected must still
      // exist at the same place. Unrelated regions of a live app may change.
      if (!containsActionableElement(latestElements, target)) {
        throw new DesktopUiError(
          "STALE_SCREENSHOT",
          "The target control moved, was replaced, or is no longer actionable; capture a new schema before sending input.",
        );
      }
      // Pixel fence for that control only. Unmeasurable frames skip this
      // supplementary check; identity, bounds and policy checks still apply.
      const region = elementFrameRegion(schema, target);
      const controlChangeRatio = region
        ? regionChangeRatio(capture.image, freshCapture.image, region)
        : null;
      if (controlChangeRatio !== null && controlChangeRatio > ELEMENT_REGION_CHANGE_BUDGET) {
        throw new DesktopUiError(
          "STALE_SCREENSHOT",
          "The selected control's pixels changed beyond the element budget; capture a new schema before sending input.",
        );
      }
    } else {
      const expectedFocused = schema.elements.filter(
        (element) => element.source === "accessibility" && element.focused === true,
      );
      const latestFocused = latestElements.filter((element) => element.focused === true);
      if (
        expectedFocused.length !== latestFocused.length
        || expectedFocused.some((original, index) => !sameElementIdentity(original, latestFocused[index]))
      ) {
        throw new DesktopUiError(
          "STALE_SCREENSHOT",
          "The focused control changed after the screenshot schema was captured.",
        );
      }
    }

    const confirmation = await this.captureFrame(this.currentTarget());
    if (
      !sameWindowIdentity(schema.screenshot.targetWindow, confirmation.targetWindow)
      || !framesEquivalent(capture.image, confirmation.image)
    ) {
      throw new DesktopUiError("STALE_SCREENSHOT", "Target pixels or window identity changed during pre-action verification.");
    }
    if (!confirmation.targetWindow.active) {
      throw new DesktopUiError("TARGET_NOT_ACTIVE", "The scoped window lost foreground focus during pre-action verification.");
    }
    return this.current;
  }

  private currentTarget(): DesktopWindowTarget {
    return this.pinnedTarget ?? this.options.target;
  }

  private async dispatchAndVerify(
    action: NativeDesktopAction,
    before: DesktopScreenshotIdentity,
  ): Promise<DesktopActionReceipt> {
    try {
      await this.options.adapter.dispatch(action);
    } catch (error) {
      this.current = null;
      const failure = error instanceof DesktopUiError ? error.code : "PROCESS_FAILED";
      throw new DesktopUiError(
        "DISPATCH_UNVERIFIED",
        "Native input dispatch returned an error. The OS may have received some events. Never automatically replay this action.",
        { dispatched: "unknown", dispatchErrorCode: failure, previousRevision: before.revision },
      );
    }
    return this.verifyDispatched(before);
  }

  private async verifyDispatched(before: DesktopScreenshotIdentity): Promise<DesktopActionReceipt> {
    try {
      return await this.verifyAfter(before);
    } catch (error) {
      this.current = null;
      const failure = error instanceof DesktopUiError ? error.code : "PROCESS_FAILED";
      throw new DesktopUiError(
        "DISPATCH_UNVERIFIED",
        "Native input was dispatched, but post-action verification failed. Never automatically replay this action.",
        { dispatched: true, verificationErrorCode: failure, previousRevision: before.revision },
      );
    }
  }

  private async verifyAfter(before: DesktopScreenshotIdentity): Promise<DesktopActionReceipt> {
    const schema = await this.snapshotUnlocked();
    return {
      dispatched: true,
      before,
      after: schema.screenshot,
      screenChanged: schema.screenshot.sha256 !== before.sha256,
      schema,
    };
  }

  private async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.operationTail;
    this.operationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

export function createDesktopUiSession(options: DesktopUiSessionOptions): DesktopUiSession {
  return new DesktopUiSession(options);
}

