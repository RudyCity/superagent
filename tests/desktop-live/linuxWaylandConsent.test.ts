import { describe, expect, it } from "vitest";
import {
  loadVerifiedWaylandConsentScript,
  parseWaylandPortalCapabilities,
  parseClosedWaylandConsentReceipt,
  parseWaylandPortalHelperResponse,
  verifyUserSelectedWaylandWindow,
} from "../../src/core/desktopUi/adapters/linuxWaylandConsent.js";

const approved = {
  status: "verified-and-closed",
  identity_kind: "portal-user-selected-window",
  source_type: 2,
  stream_count: 1,
  pipewire_serial: "123456789",
  remote_opened: true,
  session_closed: true,
  atspi_bound: false,
};

describe("Wayland ScreenCast one-shot user-consent boundary", () => {
  it("loads a checksum-pinned native client without executing any shell", async () => {
    const source = await loadVerifiedWaylandConsentScript();
    expect(source).toContain('requests.call_request("CreateSession"');
    expect(source).toContain('requests.call_request("SelectSources"');
    expect(source).toContain('requests.call_request("Start"');
    expect(source).toContain("OpenPipeWireRemote");
    expect(source).toContain('"types": GLib.Variant("u", WINDOW)');
    expect(source).toContain('"multiple": GLib.Variant("b", False)');
    expect(source).toContain('"persist_mode": GLib.Variant("u", 0)');
    expect(source).toContain("os.close(fd)");
    expect(source).toContain("source != WINDOW");
    expect(source).not.toContain("subprocess");
    expect(source).not.toContain("pw_context_connect_fd(");
  });

  it("validates read-only capability bits without mistaking version for permission", () => {
    expect(parseWaylandPortalCapabilities({
      available: true, version: 6, supports_window: false, hidden_cursor: true,
    })).toEqual({
      available: true, version: 6, supportsWindow: false, hiddenCursor: true,
    });
    for (const malformed of [
      null, {}, { available: false, version: 6, supports_window: true, hidden_cursor: true },
      { available: true, version: "6", supports_window: true, hidden_cursor: true },
    ]) {
      expect(() => parseWaylandPortalCapabilities(malformed)).toThrow();
    }
  });

  it("ensures consent has its OWN identity, is already closed and is unusable for Desktop Live", () => {
    expect(parseClosedWaylandConsentReceipt(approved)).toEqual({
      status: "verified-and-closed",
      identity: {
        kind: "portal-user-selected-window",
        sourceType: 2,
        pipewireSerial: "123456789",
        atspiBound: false,
      },
      permissionScope: "one-window-one-shot",
      sessionClosed: true,
      usableForDesktopLive: false,
    });
    const receipt = parseClosedWaylandConsentReceipt({
      ...approved, pid: 512, title: "Fake Editor", nodeId: 777,
    });
    expect(receipt).not.toHaveProperty("pid");
    expect(receipt.identity).not.toHaveProperty("nodeId");
    for (const changed of [
      { source_type: 1 },
      { stream_count: 2 },
      { remote_opened: false },
      { session_closed: false },
      { atspi_bound: true },
      { pipewire_serial: "0" },
      { pipewire_serial: "18446744073709551616" },
      { identity_kind: "atspi-window" },
    ]) {
      expect(() => parseClosedWaylandConsentReceipt({ ...approved, ...changed }))
        .toThrow();
    }
  });

  it("preserves bounded deny reasons but never reflects arbitrary helper content", () => {
    for (const reason of [
      "not-wayland", "portal-cancelled-or-denied", "consent-timeout",
      "portal-owner-changed", "session-close-unconfirmed",
      "unsupported-window-portal",
    ]) {
      expect(() => parseWaylandPortalHelperResponse(JSON.stringify({ ok: false, reason })))
        .toThrow(reason);
    }
    expect(() => parseWaylandPortalHelperResponse(JSON.stringify({
      ok: false, reason: "private window title / user home",
    }))).toThrow("portal-runtime-unavailable");
    expect(() => parseWaylandPortalHelperResponse(JSON.stringify({
      ok: false, reason: "missing-pygobject",
    }))).toThrowError(expect.objectContaining({ code: "DEPENDENCY_REQUIRED" }));
    for (const value of [
      "not-json", "[]", "null", '{"ok":true}', '{"status":"verified-and-closed","reason":"fake"}',
    ]) {
      expect(() => parseWaylandPortalHelperResponse(value)).toThrow();
    }
    expect(parseWaylandPortalHelperResponse(JSON.stringify({
      status: "verified-and-closed", session_closed: true,
    }))).toMatchObject({ session_closed: true });
  });

  it("requires a confirmed close before accepting a one-shot receipt", () => {
    expect(() => parseClosedWaylandConsentReceipt({
      ...approved, session_closed: false,
    })).toThrow("close");
  });

  it("never invokes a permission dialog without a positive attended action", async () => {
    const runner = { run: async () => {
      throw new Error("a process should never be invoked");
    } };
    await expect(verifyUserSelectedWaylandWindow(
      { userInitiated: false } as never, runner,
    )).rejects.toMatchObject({ code: "OS_PERMISSION_REQUIRED" });
  });
});
