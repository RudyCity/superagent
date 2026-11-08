import { DesktopUiError } from "./errors.js";
import type {
  DesktopDiscoveredWindow,
  DesktopUiAdapter,
  DesktopWindowDiscoveryResult,
} from "./types.js";

export const DEFAULT_WINDOW_DISCOVERY_LIMIT = 50;
export const MAX_WINDOW_DISCOVERY_LIMIT = 100;
export const MAX_WINDOW_QUERY_LENGTH = 256;

export function requireWindowDiscoveryLimit(limit?: number): number {
  const value = limit ?? DEFAULT_WINDOW_DISCOVERY_LIMIT;
  if (!Number.isInteger(value) || value < 1 || value > MAX_WINDOW_DISCOVERY_LIMIT) {
    throw new DesktopUiError(
      "INVALID_ACTION",
      `Window discovery limit must be an integer between 1 and ${MAX_WINDOW_DISCOVERY_LIMIT}.`,
    );
  }
  return value;
}

export function requireWindowQuery(query: unknown): string {
  if (typeof query !== "string") {
    throw new DesktopUiError("INVALID_ACTION", "find_window query must be a string.");
  }
  const value = query.trim();
  if (!value || value.length > MAX_WINDOW_QUERY_LENGTH) {
    throw new DesktopUiError(
      "INVALID_ACTION",
      `find_window query must contain 1-${MAX_WINDOW_QUERY_LENGTH} characters after trimming.`,
    );
  }
  return value;
}

function validateWindow(window: DesktopDiscoveredWindow): void {
  const bounds = window?.bounds;
  if (
    !window
    || !Number.isInteger(window.pid)
    || window.pid <= 0
    || typeof window.nativeId !== "string"
    || !window.nativeId
    || window.nativeId.length > 256
    || typeof window.title !== "string"
    || !window.title
    || window.title.length > 512
    || typeof window.application !== "string"
    || !window.application
    || window.application.length > 256
    || typeof window.active !== "boolean"
    || !bounds
    || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)
    || bounds.width <= 0
    || bounds.height <= 0
    || (window.scaleFactor !== undefined && (!Number.isFinite(window.scaleFactor) || window.scaleFactor <= 0))
  ) {
    throw new DesktopUiError("PROCESS_FAILED", "Desktop window discovery returned an invalid window descriptor.");
  }
}

export function validateWindowDiscoveryResult(
  result: DesktopWindowDiscoveryResult,
  requestedLimit: number,
): DesktopWindowDiscoveryResult {
  if (
    !result
    || !Array.isArray(result.windows)
    || result.limit !== requestedLimit
    || typeof result.truncated !== "boolean"
    || result.windows.length > requestedLimit
  ) {
    throw new DesktopUiError("PROCESS_FAILED", "Desktop window discovery returned an invalid bounded result.");
  }
  const identities = new Set<string>();
  for (const window of result.windows) {
    validateWindow(window);
    const identity = `${window.pid}\0${window.nativeId}`;
    if (identities.has(identity)) {
      throw new DesktopUiError("PROCESS_FAILED", "Desktop window discovery returned a duplicate native identity.");
    }
    identities.add(identity);
  }
  if (
    result.skippedAmbiguous !== undefined
    && (!Number.isInteger(result.skippedAmbiguous) || result.skippedAmbiguous < 0)
  ) {
    throw new DesktopUiError("PROCESS_FAILED", "Desktop window discovery returned an invalid ambiguity count.");
  }
  return result;
}

export async function listDiscoveredWindows(
  adapter: DesktopUiAdapter,
  limit?: number,
): Promise<DesktopWindowDiscoveryResult> {
  if (typeof adapter.listWindows !== "function") {
    throw new DesktopUiError("DESKTOP_UI_UNAVAILABLE", "This desktop adapter does not support window discovery.");
  }
  const boundedLimit = requireWindowDiscoveryLimit(limit);
  return validateWindowDiscoveryResult(await adapter.listWindows(boundedLimit), boundedLimit);
}

export async function getDiscoveredActiveWindow(
  adapter: DesktopUiAdapter,
): Promise<DesktopDiscoveredWindow | null> {
  if (typeof adapter.getActiveWindow === "function") {
    const active = await adapter.getActiveWindow();
    if (active === null) return null;
    validateWindow(active);
    if (!active.active) {
      throw new DesktopUiError("PROCESS_FAILED", "Desktop adapter returned a non-active window as foreground.");
    }
    return active;
  }
  const discovery = await listDiscoveredWindows(adapter, MAX_WINDOW_DISCOVERY_LIMIT);
  const active = discovery.windows.filter((window) => window.active);
  return active.length === 1 ? active[0] : null;
}

export function findDiscoveredWindows(
  discovery: DesktopWindowDiscoveryResult,
  query: unknown,
  pid?: number,
): DesktopDiscoveredWindow[] {
  const needle = requireWindowQuery(query).toLocaleLowerCase("en-US");
  if (pid !== undefined && (!Number.isInteger(pid) || pid <= 0)) {
    throw new DesktopUiError("INVALID_ACTION", "find_window pid must be a positive integer when provided.");
  }
  return discovery.windows.filter((window) => {
    if (pid !== undefined && window.pid !== pid) return false;
    return window.title.toLocaleLowerCase("en-US").includes(needle)
      || window.application.toLocaleLowerCase("en-US").includes(needle);
  });
}

export function requireFreshWindowTarget(
  discovery: DesktopWindowDiscoveryResult,
  pid: number,
  nativeId: unknown,
): DesktopDiscoveredWindow {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new DesktopUiError("INVALID_ACTION", "inspect_window pid must be a positive integer.");
  }
  if (typeof nativeId !== "string" || !nativeId.trim() || nativeId.length > 256) {
    throw new DesktopUiError("INVALID_ACTION", "inspect_window nativeId must be a non-empty string no longer than 256 characters.");
  }
  const matches = discovery.windows.filter(
    (window) => window.pid === pid && window.nativeId === nativeId.trim(),
  );
  if (matches.length !== 1) {
    throw new DesktopUiError(
      "TARGET_NOT_FOUND",
      "Requested pid/nativeId was not present exactly once in fresh bounded window discovery.",
    );
  }
  return matches[0];
}
