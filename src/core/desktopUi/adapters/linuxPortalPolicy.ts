/**
 * XDG ScreenCast/PipeWire policy: portal consent is NOT AT-SPI identity.
 *
 * ScreenCast selects exactly one user-selected WINDOW source (types=2,
 * multiple=false, hidden cursor, no persistence). Portal stream metadata
 * does not contain an authenticated PID/nativeId/window-title binding.
 * Never adapt portal consent into DesktopWindow or NativeCapture.
 *
 * Protocol: https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.ScreenCast.html
 */
import { DesktopUiError } from "../errors.js";
import type { DesktopDiscoveredWindow } from "../types.js";

export const XDG_PORTAL_WINDOW_TYPE = 2;
export const XDG_PORTAL_HIDDEN_CURSOR = 1;

export interface LinuxPortalReadiness {
  available: boolean;
  supportsWindow: boolean;
  hiddenCursor: boolean;
  pipewireReader: boolean;
  version: number;
}

/** Protocol readiness never authorizes a compositor-unbound target capture. */
export type LinuxPortalProtocolAssessment =
  | { readonly status: "window-only-protocol"; readonly captureAllowed: false; readonly reason: "unbound-target-identity" }
  | { readonly status: "denied"; readonly captureAllowed: false; readonly reason:
      "portal-unavailable" | "window-source-unsupported" | "hidden-cursor-unsupported" |
      "pipewire-reader-unavailable" | "portal-version-unsupported" };

export function assessLinuxPortalWindowProtocol(state: LinuxPortalReadiness): LinuxPortalProtocolAssessment {
  if (!state.available) return Object.freeze({ status: "denied", captureAllowed: false, reason: "portal-unavailable" });
  if (state.version < 6) return Object.freeze({ status: "denied", captureAllowed: false, reason: "portal-version-unsupported" });
  if (!state.supportsWindow) return Object.freeze({ status: "denied", captureAllowed: false, reason: "window-source-unsupported" });
  if (!state.hiddenCursor) return Object.freeze({ status: "denied", captureAllowed: false, reason: "hidden-cursor-unsupported" });
  if (!state.pipewireReader) return Object.freeze({ status: "denied", captureAllowed: false, reason: "pipewire-reader-unavailable" });
  return Object.freeze({ status: "window-only-protocol", captureAllowed: false, reason: "unbound-target-identity" });
}

export const WINDOW_ONLY_PORTAL_SELECTION = Object.freeze({
  types: XDG_PORTAL_WINDOW_TYPE,
  multiple: false,
  cursor_mode: XDG_PORTAL_HIDDEN_CURSOR,
  persist_mode: 0,
});

export interface PortalSelectedWindowIdentity {
  readonly kind: "portal-user-selected-window";
  readonly sourceType: 2;
  readonly pipewireSerial: string;
  /** This is never a PID/nativeId attestation. */
  readonly atspiBound: false;
}

const MAX_UINT64 = 18446744073709551615n;

/**
 * This validator accepts only metadata from the native ScreenCast.Start
 * response, after the trusted same-process D-Bus request/response has been
 * verified. It ignores the recyclable PipeWire node ID entirely. Validation
 * is NOT proof of its provenance when called with arbitrary JavaScript data.
 */
export function parsePortalSelectedWindowStream(value: unknown): PortalSelectedWindowIdentity {
  if (!Array.isArray(value) || value.length !== 1) {
    throw new DesktopUiError("OS_PERMISSION_REQUIRED",
      "ScreenCast must approve exactly one user-selected WINDOW stream.");
  }
  const stream: unknown = value[0];
  if (!stream || typeof stream !== "object" || Array.isArray(stream)) {
    throw new DesktopUiError("OS_PERMISSION_REQUIRED", "Malformed ScreenCast WINDOW stream.");
  }
  const props = stream as Record<string, unknown>;
  if (props.source_type !== XDG_PORTAL_WINDOW_TYPE) {
    throw new DesktopUiError("OS_PERMISSION_REQUIRED", "ScreenCast source was not WINDOW.");
  }
  const serial = props["pipewire-serial"];
  if (typeof serial !== "string" || !/^[1-9]\d{0,19}$/.test(serial) ||
      BigInt(serial) > MAX_UINT64) {
    throw new DesktopUiError("OS_PERMISSION_REQUIRED",
      "ScreenCast requires a valid unique PipeWire serial (portal v6).");
  }
  return Object.freeze({
    kind: "portal-user-selected-window",
    sourceType: XDG_PORTAL_WINDOW_TYPE,
    pipewireSerial: serial,
    atspiBound: false,
  });
}

/**
 * Deprecated target-identity API. Even a synthetic object claiming exact
 * PID, nativeId, bounds and title is untrusted: the public ScreenCast API
 * supplies no such attestation. It must NEVER unlock Desktop Live capture.
 */
export function requireExactPortalWindowBinding(
  _selectedStreams: unknown,
  _target: DesktopDiscoveredWindow,
): never {
  throw new DesktopUiError("OS_PERMISSION_REQUIRED",
    "Portal WINDOW consent cannot attest an exact AT-SPI PID/native-ID target.");
}

// Read-only capability check; does not call SelectSources/Start or prompt.
export const PYTHON_PORTAL_READINESS_SCRIPT = String.raw`
import json
try:
    import gi
    gi.require_version("Gio", "2.0")
    gi.require_version("Gst", "1.0")
    from gi.repository import Gio, GLib, Gst
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    target = "org.freedesktop.portal.Desktop"
    object_path = "/org/freedesktop/portal/desktop"
    def get_property(name):
        value = bus.call_sync(target, object_path,
            "org.freedesktop.DBus.Properties", "Get",
            GLib.Variant("(ss)", ("org.freedesktop.portal.ScreenCast", name)),
            GLib.VariantType.new("(v)"), Gio.DBusCallFlags.NONE, 3000,
            None)
        return value.unpack()[0].unpack()
    source_types = int(get_property("AvailableSourceTypes"))
    cursor_modes = int(get_property("AvailableCursorModes"))
    version = int(get_property("version"))
    Gst.init(None)
    reader = Gst.ElementFactory.find("pipewiresrc") is not None
    print(json.dumps({
      "available": True, "supportsWindow": bool(source_types & 2),
      "hiddenCursor": bool(cursor_modes & 1),
      "pipewireReader": bool(reader), "version": version
    }))
except Exception:
    print(json.dumps({
      "available": False, "supportsWindow": False,
      "hiddenCursor": False, "pipewireReader": False, "version": 0
    }))
`;

export function parseLinuxPortalReadiness(raw: unknown): LinuxPortalReadiness {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new DesktopUiError("SCREENSHOT_UNAVAILABLE", "Malformed Linux portal capability response.");
  }
  const state = raw as Record<string, unknown>;
  if (typeof state.available !== "boolean" ||
      typeof state.supportsWindow !== "boolean" ||
      typeof state.hiddenCursor !== "boolean" ||
      typeof state.pipewireReader !== "boolean" ||
      !Number.isInteger(state.version) || Number(state.version) < 0 || Number(state.version) > 100 ||
      (state.available === false &&
        (state.supportsWindow === true || state.hiddenCursor === true ||
         state.pipewireReader === true || state.version !== 0))) {
    throw new DesktopUiError("SCREENSHOT_UNAVAILABLE", "Invalid Linux portal capability fields.");
  }
  return {
    available: state.available, supportsWindow: state.supportsWindow,
    hiddenCursor: state.hiddenCursor, pipewireReader: state.pipewireReader,
    version: Number(state.version),
  };
}
