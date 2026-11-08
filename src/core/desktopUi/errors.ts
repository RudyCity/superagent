export type DesktopUiErrorCode =
  | "DESKTOP_UI_UNAVAILABLE"
  | "SCREENSHOT_UNAVAILABLE"
  | "ACCESSIBILITY_UNAVAILABLE"
  | "INPUT_DISABLED"
  | "INPUT_UNAVAILABLE"
  | "TARGET_NOT_FOUND"
  | "TARGET_NOT_ACTIVE"
  | "STALE_SCREENSHOT"
  | "DISPATCH_UNVERIFIED"
  | "ELEMENT_NOT_FOUND"
  | "ELEMENT_NOT_ACTIONABLE"
  | "INVALID_ACTION"
  | "PLATFORM_UNSUPPORTED"
  | "WAYLAND_INPUT_UNAVAILABLE"
  | "OS_PERMISSION_REQUIRED"
  | "DEPENDENCY_REQUIRED"
  | "PROCESS_FAILED"
  | "VISION_UNAVAILABLE";

export class DesktopUiError extends Error {
  readonly code: DesktopUiErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: DesktopUiErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "DesktopUiError";
    this.code = code;
    this.details = details;
  }
}

export function asDesktopUiError(
  error: unknown,
  fallbackCode: DesktopUiErrorCode,
  fallbackMessage: string,
): DesktopUiError {
  if (error instanceof DesktopUiError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new DesktopUiError(fallbackCode, `${fallbackMessage}: ${message}`);
}
