#!/usr/bin/env python3
"""Bounded one-shot XDG ScreenCast WINDOW consent verifier.

This helper intentionally NEVER reads pixels, uses a PipeWire node ID,
injects input, exports a PipeWire fd, or associates a portal source with
AT-SPI/PID/nativeId. It only verifies an attended portal selection, opens
the portal-scoped remote, closes the fd and session, and reports a
NON-REUSABLE consent receipt. No monitor fallback exists.
"""
import json
import os
import secrets
import sys

PORTAL = "org.freedesktop.portal.Desktop"
OBJECT = "/org/freedesktop/portal/desktop"
SCREENCAST = "org.freedesktop.portal.ScreenCast"
REQUEST = "org.freedesktop.portal.Request"
SESSION = "org.freedesktop.portal.Session"
WINDOW = 2
HIDDEN_CURSOR = 1
MAX_UINT64 = 18446744073709551615


class Denied(Exception):
    pass


def safe_response(reason):
    return {"ok": False, "reason": reason}


def ensure_wayland():
    if os.environ.get("XDG_SESSION_TYPE", "").lower() != "wayland":
        raise Denied("not-wayland")
    if not os.environ.get("WAYLAND_DISPLAY") or not os.environ.get("DBUS_SESSION_BUS_ADDRESS"):
        raise Denied("missing-session-bus")


def dbus_setup():
    try:
        import gi
        gi.require_version("Gio", "2.0")
        from gi.repository import Gio, GLib
        return Gio, GLib
    except (ImportError, ValueError):
        raise Denied("missing-pygobject") from None


def get_portal_capabilities(bus, Gio, GLib):
    def read(name):
        result = bus.call_sync(
            PORTAL, OBJECT, "org.freedesktop.DBus.Properties", "Get",
            GLib.Variant("(ss)", (SCREENCAST, name)),
            GLib.VariantType.new("(v)"), Gio.DBusCallFlags.NONE, 3000, None
        )
        return result.unpack()[0].unpack()

    version = read("version")
    sources = read("AvailableSourceTypes")
    cursors = read("AvailableCursorModes")
    if (type(version) is not int or not 0 <= version <= 100 or
            type(sources) is not int or sources < 0 or
            type(cursors) is not int or cursors < 0):
        raise Denied("invalid-portal-properties")
    return {
        "available": True,
        "version": version,
        "supports_window": bool(sources & WINDOW),
        "hidden_cursor": bool(cursors & HIDDEN_CURSOR),
    }


def verify_streams(streams):
    # ScreenCast.Start: a(ua{sv}). The uint32 node ID is deliberately ignored.
    if not isinstance(streams, (list, tuple)) or len(streams) != 1:
        raise Denied("not-exactly-one-stream")
    entry = streams[0]
    if not isinstance(entry, (list, tuple)) or len(entry) != 2:
        raise Denied("invalid-stream")
    _discarded_node_id, properties = entry
    if type(_discarded_node_id) is not int or not 0 <= _discarded_node_id <= 0xFFFFFFFF:
        raise Denied("invalid-stream-node")
    if not isinstance(properties, dict):
        raise Denied("invalid-stream-properties")

    def unbox(value):
        return value.unpack() if hasattr(value, "unpack") else value

    source = unbox(properties.get("source_type"))
    serial = unbox(properties.get("pipewire-serial"))
    if type(source) is not int or source != WINDOW:
        raise Denied("not-a-window")
    if type(serial) is not int or serial < 1 or serial > MAX_UINT64:
        raise Denied("missing-unique-serial")
    return str(serial)


class PortalRequests:
    def __init__(self, bus, Gio, GLib):
        self.bus, self.Gio, self.GLib = bus, Gio, GLib
        self.sender = bus.get_unique_name().lstrip(":").replace(".", "_")
        if not self.sender:
            raise Denied("unknown-dbus-sender")
        owner_result = bus.call_sync(
            "org.freedesktop.DBus", "/org/freedesktop/DBus",
            "org.freedesktop.DBus", "GetNameOwner",
            GLib.Variant("(s)", (PORTAL,)),
            GLib.VariantType.new("(s)"), Gio.DBusCallFlags.NONE, 3000, None
        )
        self.owner = owner_result.unpack()[0]
        if not isinstance(self.owner, str) or not self.owner.startswith(":"):
            raise Denied("unknown-portal-owner")

    def check_owner(self):
        # A replacement portal process must never inherit old session consent.
        try:
            result = self.bus.call_sync(
                "org.freedesktop.DBus", "/org/freedesktop/DBus",
                "org.freedesktop.DBus", "GetNameOwner",
                self.GLib.Variant("(s)", (PORTAL,)),
                self.GLib.VariantType.new("(s)"),
                self.Gio.DBusCallFlags.NONE, 3000, None
            )
            if result.unpack()[0] != self.owner:
                raise Denied("portal-owner-changed")
        except Denied:
            raise
        except Exception:
            raise Denied("portal-owner-unavailable") from None

    def call_request(self, method, signature, args, max_wait_ms):
        self.check_owner()
        token = "sa_" + secrets.token_hex(16)
        expected = "/org/freedesktop/portal/desktop/request/" + self.sender + "/" + token
        result = {}
        loop = self.GLib.MainLoop()

        def on_response(_bus, _sender, _path, _iface, _signal, params, _data):
            if "response" in result:
                return
            unpacked = params.unpack()
            if not isinstance(unpacked, (list, tuple)) or len(unpacked) != 2:
                result["malformed"] = True
                loop.quit()
                return
            code, values = unpacked
            if type(code) is not int:
                result["malformed"] = True
                loop.quit()
                return
            result["response"] = code
            result["values"] = values
            loop.quit()

        subscription = self.bus.signal_subscribe(
            self.owner, REQUEST, "Response", expected, None,
            self.Gio.DBusSignalFlags.NONE, on_response, None,
        )
        request_created = False

        def on_timeout():
            result["timeout"] = True
            loop.quit()
            return False

        timer = None
        try:
            options = args[-1]
            options["handle_token"] = self.GLib.Variant("s", token)
            response = self.bus.call_sync(
                self.owner, OBJECT, SCREENCAST, method,
                self.GLib.Variant(signature, args),
                self.GLib.VariantType.new("(o)"),
                self.Gio.DBusCallFlags.NONE, 5000, None,
            )
            handle = response.unpack()[0]
            if handle != expected:
                raise Denied("request-handle-mismatch")
            request_created = True
            timer = self.GLib.timeout_add(max_wait_ms, on_timeout)
            if "response" not in result:
                loop.run()
            if result.get("timeout"):
                raise Denied("consent-timeout")
            if result.get("malformed"):
                raise Denied("malformed-portal-response")
            if result.get("response") != 0:
                raise Denied("portal-cancelled-or-denied")
            if not isinstance(result.get("values"), dict):
                raise Denied("malformed-portal-response")
            self.check_owner()
            return result["values"]
        finally:
            if timer is not None and not result.get("timeout"):
                self.GLib.source_remove(timer)
            self.bus.signal_unsubscribe(subscription)
            if request_created and ("response" not in result):
                try:
                    self.bus.call_sync(
                        self.owner, expected, REQUEST, "Close", None, None,
                        self.Gio.DBusCallFlags.NONE, 2000, None,
                    )
                except Exception:
                    pass


def open_remote_and_close_fd(bus, Gio, GLib, handle, owner):
    # The PipeWire remote grants access ONLY to portal-approved sources.
    # The fd is closed without creating any pw_core or reading a frame.
    response, fd_list = bus.call_with_unix_fd_list_sync(
        owner, OBJECT, SCREENCAST, "OpenPipeWireRemote",
        GLib.Variant("(oa{sv})", (handle, {})),
        GLib.VariantType.new("(h)"),
        Gio.DBusCallFlags.NONE, 5000, None, None,
    )
    index = response.unpack()[0]
    if type(index) is not int or index < 0 or fd_list is None:
        raise Denied("pipewire-remote-unavailable")
    try:
        fd = fd_list.get(index)
        if type(fd) is not int or fd < 0:
            raise Denied("invalid-pipewire-fd")
        os.close(fd)
    finally:
        # UnixFDList retains the originals independently of get()'s duplicate.
        for original in fd_list.steal_fds():
            os.close(original)
    return True


def one_shot_consent(bus, Gio, GLib, capabilities):
    if capabilities["version"] < 6 or not capabilities["supports_window"] or not capabilities["hidden_cursor"]:
        raise Denied("unsupported-window-portal")
    requests = PortalRequests(bus, Gio, GLib)
    session_path = None
    try:
        session_token = "sa_" + secrets.token_hex(16)
        creation = requests.call_request("CreateSession", "(a{sv})", ({
            "session_handle_token": GLib.Variant("s", session_token),
        },), 10000)
        returned_session = creation.get("session_handle")
        if hasattr(returned_session, "unpack"):
            returned_session = returned_session.unpack()
        expected_session = "/org/freedesktop/portal/desktop/session/" + requests.sender + "/" + session_token
        if returned_session != expected_session:
            raise Denied("session-handle-mismatch")
        session_path = returned_session
        requests.call_request("SelectSources", "(oa{sv})", (session_path, {
            "types": GLib.Variant("u", WINDOW),
            "multiple": GLib.Variant("b", False),
            "cursor_mode": GLib.Variant("u", HIDDEN_CURSOR),
            "persist_mode": GLib.Variant("u", 0),
        }), 10000)
        started = requests.call_request("Start", "(osa{sv})", (session_path, "", {}), 60000)
        streams = started.get("streams")
        if hasattr(streams, "unpack"):
            streams = streams.unpack()
        serial = verify_streams(streams)
        requests.check_owner()
        open_remote_and_close_fd(bus, Gio, GLib, session_path, requests.owner)
        requests.check_owner()
        receipt = {
            "status": "verified-and-closed",
            "identity_kind": "portal-user-selected-window",
            "source_type": WINDOW,
            "stream_count": 1,
            "pipewire_serial": serial,
            "remote_opened": True,
            "session_closed": False,
            "atspi_bound": False,
        }
    finally:
        if session_path is not None:
            try:
                bus.call_sync(
                    requests.owner, session_path, SESSION, "Close", None, None,
                    Gio.DBusCallFlags.NONE, 3000, None,
                )
            except Exception:
                raise Denied("session-close-unconfirmed") from None
    # Never advertise a closed/revoked session before the Close RPC succeeds.
    receipt["session_closed"] = True
    return receipt


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in ("--capabilities", "--consent-once"):
        raise Denied("invalid-mode")
    if sys.argv[1] == "--consent-once" and (
        len(sys.argv) != 3 or sys.argv[2] != "--user-initiated"
    ):
        raise Denied("explicit-user-action-required")
    if sys.argv[1] == "--capabilities" and len(sys.argv) != 2:
        raise Denied("invalid-mode")
    ensure_wayland()
    Gio, GLib = dbus_setup()
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    capabilities = get_portal_capabilities(bus, Gio, GLib)
    if sys.argv[1] == "--capabilities":
        print(json.dumps(capabilities, separators=(",", ":")))
        return
    print(json.dumps(one_shot_consent(bus, Gio, GLib, capabilities), separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except Denied as error:
        # A normal denial is a structured result, not a failed transport.
        print(json.dumps(safe_response(str(error)), separators=(",", ":")))
    except Exception:
        # Do not leak DBus paths, window labels or environment in diagnostics.
        print(json.dumps(safe_response("portal-runtime-unavailable"), separators=(",", ":")))
        sys.exit(3)
