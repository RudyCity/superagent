/**
 * Independent Wayland portal consent boundary. NEVER used by DesktopUiAdapter
 * capture(), which requires AT-SPI target identity the portal cannot attest.
 *
 * This CLI invokes a checksum-pinned Python Gio ScreenCast client with
 * fixed arguments and NO shell, monitors, restores, pixels or exported fds.
 * An explicit attended user action is required to show a consent dialog.
 */
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { DesktopUiError } from "../errors.js";
import { createRestrictedProcessRunner, type DesktopProcessRunner } from "../processRunner.js";
import {
  parsePortalSelectedWindowStream, type PortalSelectedWindowIdentity,
} from "./linuxPortalPolicy.js";

const PYTHON3 = "/usr/bin/python3";
const SCRIPT = new URL("../../../../native/desktop-live-wayland/portal_window_consent.py", import.meta.url);
const SCRIPT_SHA256 = "367a6e8dda97b776647aaaa36970d1266b6fed8ead8cd3ebfa4cc5ba118f73d8";

export interface WaylandPortalConsentReceipt {
  readonly status: "verified-and-closed";
  readonly identity: PortalSelectedWindowIdentity;
  readonly permissionScope: "one-window-one-shot";
  readonly sessionClosed: true;
  /** This is not a stream handle and cannot be converted to NativeCapture. */
  readonly usableForDesktopLive: false;
}

export interface WaylandPortalCapabilities {
  readonly available: boolean;
  readonly version: number;
  readonly supportsWindow: boolean;
  readonly hiddenCursor: boolean;
}

function requireNativeWayland(): void {
  if (process.platform !== "linux" || process.env.XDG_SESSION_TYPE !== "wayland" ||
      !process.env.WAYLAND_DISPLAY || !process.env.DBUS_SESSION_BUS_ADDRESS) {
    throw new DesktopUiError("OS_PERMISSION_REQUIRED",
      "Native Wayland ScreenCast requires a verified local Wayland user session and session bus.");
  }
}

export async function loadVerifiedWaylandConsentScript(): Promise<string> {
  const scriptPath = fileURLToPath(SCRIPT);
  try {
    const stat = await lstat(scriptPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > 32_000) {
      throw new Error("not a bounded regular file");
    }
    const bytes = await readFile(scriptPath);
    if (createHash("sha256").update(bytes).digest("hex") !== SCRIPT_SHA256) {
      throw new Error("native consent source checksum mismatch");
    }
    return bytes.toString("utf8");
  } catch {
    throw new DesktopUiError("DEPENDENCY_REQUIRED",
      "Checksum-pinned Wayland ScreenCast consent helper is missing or altered.");
  }
}

function parseResponse(stdout: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new DesktopUiError("PROCESS_FAILED", "Wayland consent helper returned invalid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DesktopUiError("PROCESS_FAILED", "Malformed Wayland consent helper response.");
  }
  const record = value as Record<string, unknown>;
  if (record.ok === false) {
    throw new DesktopUiError("OS_PERMISSION_REQUIRED", "Wayland portal consent was denied or unavailable.");
  }
  return record;
}

export function parseWaylandPortalCapabilities(output: unknown): WaylandPortalCapabilities {
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    throw new DesktopUiError("PROCESS_FAILED", "Malformed Wayland portal properties.");
  }
  const value = output as Record<string, unknown>;
  if (value.available !== true || !Number.isInteger(value.version) ||
      Number(value.version) < 0 || Number(value.version) > 100 ||
      typeof value.supports_window !== "boolean" ||
      typeof value.hidden_cursor !== "boolean") {
    throw new DesktopUiError("PROCESS_FAILED", "Invalid ScreenCast portal capabilities.");
  }
  return Object.freeze({
    available: true,
    version: Number(value.version),
    supportsWindow: value.supports_window,
    hiddenCursor: value.hidden_cursor,
  });
}

export function parseClosedWaylandConsentReceipt(output: unknown): WaylandPortalConsentReceipt {
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    throw new DesktopUiError("OS_PERMISSION_REQUIRED", "Invalid portal consent receipt.");
  }
  const value = output as Record<string, unknown>;
  if (value.status !== "verified-and-closed" ||
      value.identity_kind !== "portal-user-selected-window" ||
      value.stream_count !== 1 || value.source_type !== 2 ||
      value.remote_opened !== true || value.session_closed !== true ||
      value.atspi_bound !== false) {
    throw new DesktopUiError("OS_PERMISSION_REQUIRED",
      "Portal did not verify and close exactly one consented WINDOW stream.");
  }
  const identity = parsePortalSelectedWindowStream([{
    source_type: value.source_type, "pipewire-serial": value.pipewire_serial,
  }]);
  return Object.freeze({
    status: "verified-and-closed",
    identity,
    permissionScope: "one-window-one-shot",
    sessionClosed: true,
    usableForDesktopLive: false,
  });
}

export async function probeWaylandWindowPortal(
  runner: DesktopProcessRunner = createRestrictedProcessRunner([PYTHON3]),
): Promise<WaylandPortalCapabilities> {
  requireNativeWayland();
  const script = await loadVerifiedWaylandConsentScript();
  const result = await runner.run({
    executable: PYTHON3, args: ["-I", "-c", script, "--capabilities"], timeoutMs: 8_000,
  });
  return parseWaylandPortalCapabilities(parseResponse(result.stdout));
}

/**
 * Explicit one-shot permission verification ONLY. A successful invocation
 * closes the PipeWire fd and portal session BEFORE returning any result.
 * Do not call this from probe(), capture(), a timer, or a network handler.
 */
export async function verifyUserSelectedWaylandWindow(
  options: { readonly userInitiated: true },
  runner: DesktopProcessRunner = createRestrictedProcessRunner([PYTHON3]),
): Promise<WaylandPortalConsentReceipt> {
  if (options?.userInitiated !== true) {
    throw new DesktopUiError("OS_PERMISSION_REQUIRED",
      "An explicit attended user action is required for ScreenCast consent.");
  }
  requireNativeWayland();
  const script = await loadVerifiedWaylandConsentScript();
  const result = await runner.run({
    executable: PYTHON3,
    args: ["-I", "-c", script, "--consent-once", "--user-initiated"],
    timeoutMs: 90_000,
  });
  return parseClosedWaylandConsentReceipt(parseResponse(result.stdout));
}
