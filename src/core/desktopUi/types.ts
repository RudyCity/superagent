export type DesktopPlatform = "win32" | "darwin" | "linux";
export type DesktopElementSource = "accessibility" | "vision";

export interface DesktopPoint {
  x: number;
  y: number;
}

export interface DesktopBounds extends DesktopPoint {
  width: number;
  height: number;
}

export interface DesktopWindowTarget {
  pid: number;
  nativeId?: string;
  title?: string;
}

export interface DesktopWindow {
  pid: number;
  nativeId: string;
  title: string;
  bounds: DesktopBounds;
  active: boolean;
  scaleFactor?: number;
}

export interface DesktopDiscoveredWindow extends DesktopWindow {
  application: string;
}

export interface DesktopWindowDiscoveryResult {
  windows: DesktopDiscoveredWindow[];
  limit: number;
  truncated: boolean;
  skippedAmbiguous?: number;
}

export interface DesktopUiElement {
  id: string;
  role: string;
  label: string | null;
  description: string | null;
  value: string | null;
  bounds: DesktopBounds;
  center: DesktopPoint;
  source: DesktopElementSource;
  confidence: number;
  actionable: boolean;
  focused?: boolean;
  nativeRef?: string;
}

export interface DesktopScreenshotIdentity {
  revision: number;
  sha256: string;
  capturedAt: string;
  width: number;
  height: number;
  pixelRatioX: number;
  pixelRatioY: number;
  targetWindow: DesktopWindow;
}

export interface DesktopUiSchema {
  version: 1;
  platform: DesktopPlatform;
  screenshot: DesktopScreenshotIdentity;
  windows: DesktopWindow[];
  elements: DesktopUiElement[];
  warnings: string[];
}

export interface NativeCapture {
  image: Uint8Array;
  capturedAt: string;
  targetWindow: DesktopWindow;
}

export interface AccessibilitySnapshot {
  window: DesktopWindow;
  elements: Omit<DesktopUiElement, "id" | "source" | "confidence">[];
  warnings?: string[];
}

export interface DesktopUiCapabilities {
  platform: DesktopPlatform;
  available: boolean;
  screenshot: boolean;
  accessibility: boolean;
  input: boolean;
  scroll: boolean;
  sessionType?: string;
  prerequisites: string[];
  limitations: string[];
  errors: string[];
}

export type DesktopKey =
  | "ENTER"
  | "TAB"
  | "ESCAPE"
  | "BACKSPACE"
  | "DELETE"
  | "ARROW_UP"
  | "ARROW_DOWN"
  | "ARROW_LEFT"
  | "ARROW_RIGHT"
  | "HOME"
  | "END"
  | "PAGE_UP"
  | "PAGE_DOWN"
  | "SPACE";

export type DesktopModifier = "CTRL" | "ALT" | "SHIFT" | "META";

export type NativeDesktopAction =
  | {
      kind: "click";
      target: DesktopWindowTarget;
      point: DesktopPoint;
      element: DesktopUiElement;
    }
  | {
      kind: "type";
      target: DesktopWindowTarget;
      point: DesktopPoint;
      element: DesktopUiElement;
      text: string;
    }
  | {
      kind: "key";
      target: DesktopWindowTarget;
      key: DesktopKey;
      modifiers: DesktopModifier[];
    }
  | {
      kind: "scroll";
      target: DesktopWindowTarget;
      point: DesktopPoint;
      element: DesktopUiElement;
      deltaX: number;
      deltaY: number;
    };

/** A native capture source that enforces approved target identity inside
 * each OS-level capture operation; never usable for desktop input.
 */
export interface DesktopWindowCaptureSource {
  readonly backend: string;
  readonly verifiedInsideCapture: true;
  capture(): Promise<NativeCapture>;
  close(): void;
}

export interface DesktopUiAdapter {
  readonly platform: DesktopPlatform;
  probe(): Promise<DesktopUiCapabilities>;
  listWindows?(limit: number): Promise<DesktopWindowDiscoveryResult>;
  getActiveWindow?(): Promise<DesktopDiscoveredWindow | null>;
  capture(target: DesktopWindowTarget): Promise<NativeCapture>;
  /** Optional Windows native fast path; unimplemented backends retain
   * the full pre/post discovery checks in the session manager. */
  openVerifiedCapture?(window: DesktopDiscoveredWindow): Promise<DesktopWindowCaptureSource>;
  inspectAccessibility(target: DesktopWindowTarget, capture: NativeCapture): Promise<AccessibilitySnapshot>;
  dispatch(action: NativeDesktopAction): Promise<void>;
}

export interface VisionDetection {
  role: string;
  score: number;
  box: [number, number, number, number];
}

export interface DesktopVisionDetector {
  detect(image: Uint8Array): Promise<VisionDetection[]>;
}

export interface DesktopUiSessionOptions {
  adapter: DesktopUiAdapter;
  target: DesktopWindowTarget;
  vision?: DesktopVisionDetector;
  allowInput?: boolean;
}

export interface DesktopActionReceipt {
  dispatched: true;
  before: DesktopScreenshotIdentity;
  after: DesktopScreenshotIdentity;
  screenChanged: boolean;
  schema: DesktopUiSchema;
}
