"""Isolated ScreenCast protocol simulation: no display, DBus, or pixels required."""
import importlib.util
import os
from pathlib import Path
import unittest

SOURCE = Path(__file__).resolve().parents[2] / "native/desktop-live-wayland/portal_window_consent.py"
spec = importlib.util.spec_from_file_location("wayland_consent", SOURCE)
portal = importlib.util.module_from_spec(spec)
spec.loader.exec_module(portal)


class Variant:
    def __init__(self, signature, value):
        self.value = value

    def unpack(self):
        return self.value


class FakeGLib:
    Variant = Variant

    class VariantType:
        @staticmethod
        def new(_signature):
            return object()

    def __init__(self, bus):
        self.bus = bus

    def MainLoop(self):
        bus = self.bus

        class Loop:
            def run(self):
                bus.handler(None, None, None, None, None,
                            Variant("", (bus.response_code, bus.response_values)), None)

            def quit(self):
                pass

        return Loop()

    def timeout_add(self, _milliseconds, _callback):
        return 1

    def source_remove(self, _id):
        pass


class FakeGio:
    class DBusCallFlags:
        NONE = 0

    class DBusSignalFlags:
        NONE = 0


class FakeFdList:
    def __init__(self):
        self.original, writer = os.pipe()
        os.close(writer)
        self.stolen = False
        self.previous = None

    def get(self, index):
        if index != 0:
            raise ValueError("invalid fd index")
        return os.dup(self.original)

    def steal_fds(self):
        self.stolen = True
        fd = self.original
        self.previous = fd
        self.original = -1
        return [fd]


class FakeBus:
    def __init__(self):
        self.owner = ":1.42"
        self.changed_after = None
        self.owner_checks = 0
        self.response_code = 0
        self.response_values = {}
        self.handler = None
        self.session = None
        self.closed = False
        self.close_fails = False
        self.remote_opened = False
        self.fdlist = None
        self.calls = []

    def get_unique_name(self):
        return ":1.77"

    def signal_subscribe(self, owner, interface, member, path, *_args):
        assert owner == ":1.42"
        assert interface == portal.REQUEST and member == "Response"
        # Gio signal_subscribe callback is the third trailing argument.
        self.handler = _args[2]
        return 1

    def signal_unsubscribe(self, _subscription):
        self.handler = None

    def call_sync(self, dest, path, _iface, method, args, *_other):
        self.calls.append((dest, method))
        if method == "GetNameOwner":
            self.owner_checks += 1
            owner = ":1.55" if (self.changed_after is not None
                                 and self.owner_checks >= self.changed_after) else self.owner
            return Variant("", (owner,))
        if method == "Close":
            if self.close_fails:
                raise RuntimeError("simulated close failure")
            if _iface == portal.SESSION:
                self.closed = True
            return Variant("", ())
        if dest != self.owner:
            raise RuntimeError("unexpected destination: must pin portal owner")
        if method == "CreateSession":
            options = args.unpack()[0]
            session_token = options["session_handle_token"].unpack()
            self.session = ("/org/freedesktop/portal/desktop/session/1_77/" + session_token)
            self.response_values = {"session_handle": Variant("o", self.session)}
        elif method == "SelectSources":
            opts = args.unpack()[-1]
            assert opts["types"].unpack() == 2
            assert opts["multiple"].unpack() is False
            assert opts["cursor_mode"].unpack() == 1
            assert opts["persist_mode"].unpack() == 0
            self.response_values = {}
        elif method == "Start":
            self.response_values = {"streams": Variant("", [
                (22, {"source_type": Variant("u", 2),
                      "pipewire-serial": Variant("t", 987654321)})
            ])}
        else:
            raise RuntimeError("unexpected call " + method)
        token = args.unpack()[-1]["handle_token"].unpack()
        request = "/org/freedesktop/portal/desktop/request/1_77/" + token
        return Variant("", (request,))

    def call_with_unix_fd_list_sync(self, dest, path, _iface, method, args, *_rest):
        assert dest == self.owner
        assert path == portal.OBJECT and method == "OpenPipeWireRemote"
        assert args.unpack()[0] == self.session
        self.remote_opened = True
        self.fdlist = FakeFdList()
        return Variant("", (0,)), self.fdlist


class TestPortalBoundary(unittest.TestCase):
    def setUp(self):
        self.bus = FakeBus()
        self.glib = FakeGLib(self.bus)
        self.capabilities = {"available": True, "version": 6,
                             "supports_window": True, "hidden_cursor": True}

    def run_consent(self):
        return portal.one_shot_consent(self.bus, FakeGio, self.glib, self.capabilities)

    def test_success_proves_only_closed_window_protocol(self):
        receipt = self.run_consent()
        self.assertEqual(receipt["status"], "verified-and-closed")
        self.assertEqual(receipt["pipewire_serial"], "987654321")
        self.assertTrue(receipt["session_closed"])
        self.assertFalse(receipt["atspi_bound"])
        self.assertTrue(self.bus.remote_opened)
        self.assertTrue(self.bus.closed)
        self.assertTrue(self.bus.fdlist.stolen)
        with self.assertRaises(OSError):
            os.fstat(self.bus.fdlist.previous)

    def test_cancel_after_session_creation_revokes_session(self):
        # Cancel SelectSources after CreateSession; still require Session.Close.
        original = self.bus.call_sync

        def cancelled(*args):
            result = original(*args)
            if args[3] == "SelectSources":
                self.bus.response_code = 1
            return result

        self.bus.call_sync = cancelled
        with self.assertRaisesRegex(portal.Denied, "portal-cancelled-or-denied"):
            self.run_consent()
        self.assertTrue(self.bus.closed)
        self.assertFalse(self.bus.remote_opened)

    def test_close_failure_never_issues_verified_receipt(self):
        self.bus.close_fails = True
        with self.assertRaisesRegex(portal.Denied, "session-close-unconfirmed"):
            self.run_consent()
        self.assertTrue(self.bus.remote_opened)
        self.assertFalse(self.bus.closed)

    def test_owner_rotation_prevents_live_remote_open(self):
        self.bus.changed_after = 5
        with self.assertRaisesRegex(portal.Denied, "portal-owner-changed"):
            self.run_consent()
        self.assertFalse(self.bus.remote_opened)

    def test_start_monitor_denied_and_session_revoked(self):
        original = self.bus.call_sync

        def monitor(*args):
            result = original(*args)
            if args[3] == "Start":
                self.bus.response_values = {"streams": Variant("", [
                    (22, {"source_type": Variant("u", 1),
                          "pipewire-serial": Variant("t", 987654321)})
                ])}
            return result

        self.bus.call_sync = monitor
        with self.assertRaisesRegex(portal.Denied, "not-a-window"):
            self.run_consent()
        self.assertTrue(self.bus.closed)
        self.assertFalse(self.bus.remote_opened)

    def test_owner_rotation_after_remote_open_is_not_authorization(self):
        # Owner check after OpenPipeWireRemote detects a replaced portal.
        self.bus.changed_after = 9
        with self.assertRaisesRegex(portal.Denied, "portal-owner-changed"):
            self.run_consent()
        self.assertTrue(self.bus.remote_opened)
        self.assertTrue(self.bus.closed)
        self.assertTrue(self.bus.fdlist.stolen)

    def test_monitor_and_multiple_streams_fail_closed(self):
        for streams in [[(5, {"source_type": Variant("u", 1),
                              "pipewire-serial": Variant("t", 9)})],
                        [(5, {"source_type": Variant("u", 2),
                              "pipewire-serial": Variant("t", 9)}),
                         (6, {"source_type": Variant("u", 2),
                              "pipewire-serial": Variant("t", 10)})]]:
            with self.assertRaises(portal.Denied):
                portal.verify_streams(streams)

    def test_unsupported_portal_never_prompts(self):
        for key, value in [("version", 5), ("supports_window", False),
                           ("hidden_cursor", False)]:
            state = dict(self.capabilities)
            state[key] = value
            with self.assertRaisesRegex(portal.Denied, "unsupported-window-portal"):
                portal.one_shot_consent(self.bus, FakeGio, self.glib, state)
            self.assertEqual(self.bus.calls, [])


if __name__ == "__main__":
    unittest.main()
