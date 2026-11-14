/**
 * Linux Wayland ScreenCast/PipeWire capability and source policy.
 *
 * The desktop portal can grant exactly one window stream (WINDOW=2,
 * multiple=false, cursor=hidden, no persistence). HOWEVER, the standard
 * StreamCast stream properties do not attest the selected window's PID,
 * AX title, or exact AT-SPI native ID. We must not present that stream
 * under another window's identity. Until the compositor can provide a
 * verifiable binding, never return its pixels to Desktop Live.
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

export const WINDOW_ONLY_PORTAL_SELECTION = Object.freeze({
  types: XDG_PORTAL_WINDOW_TYPE,
  multiple: false,
  cursor_mode: XDG_PORTAL_HIDDEN_CURSOR,
  persist_mode: 0,
});

/**
 * Validate compositor identity attestation strictly, should a future
 * portal expose it. Ordinary standard ScreenCast tuples are intentionally
 * rejected rather than being treated as exact-window capabilities.
 */
export function requireExactPortalWindowBinding(
  selectedStreams: unknown,
  target: DesktopDiscoveredWindow,
): string {
  if (!Array.isArray(selectedStreams) || selectedStreams.length !== 1 ||
      !Number.isSafeInteger(target.pid) || target.pid <= 0 ||
      !target.title || !target.application) {
    throw new DesktopUiError("OS_PERMISSION_REQUIRED", "Portal must approve exactly one pinned application window.");
  }
  const stream = selectedStreams[0];
  if (!stream || typeof stream !== "object" || Array.isArray(stream)) {
    throw new DesktopUiError("OS_PERMISSION_REQUIRED", "Portal window identity was not attested.");
  }
  const record = stream as Record<string, unknown>;
  const bounds = record.bounds;
  const original = target.bounds;
  const dims = bounds && typeof bounds === "object" && !Array.isArray(bounds)
    ? bounds as Record<string, unknown> : null;
  const serial = record.pipewireSerial;
  if (record.sourceType !== XDG_PORTAL_WINDOW_TYPE || record.pid !== target.pid ||
      record.nativeId !== target.nativeId || record.title !== target.title ||
      record.application !== target.application ||
      !dims || !["x", "y", "width", "height"].every(key =>
        dims[key] === original[key as keyof typeof original]) ||
      typeof serial !== "string" || !/^[1-9][0-9]{0,19}$/.test(serial)) {
    throw new DesktopUiError("OS_PERMISSION_REQUIRED",
      "PipeWire portal stream lacks an exact target PID/native-ID attestation.");
  }
  return serial;
}

// Queries only portal availability and GStreamer PipeWire plugin presence;
// never initiates a ScreenCast Start/SelectSources request or OS permission UI.
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
      !Number.isInteger(state.version) || Number(state.version) < 0 || Number(state.version) > 100) {
    throw new DesktopUiError("SCREENSHOT_UNAVAILABLE", "Invalid Linux portal capability fields.");
  }
  return {
    available: state.available, supportsWindow: state.supportsWindow,
    hiddenCursor: state.hiddenCursor, pipewireReader: state.pipewireReader,
    version: Number(state.version),
  };
}
