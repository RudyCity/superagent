import { describe, expect, it, vi } from "vitest";
import {
  WINDOW_ONLY_PORTAL_SELECTION,
  PYTHON_PORTAL_READINESS_SCRIPT,
  parseLinuxPortalReadiness,
  assessLinuxPortalWindowProtocol,
  parsePortalSelectedWindowStream,
  requireExactPortalWindowBinding,
} from "../../src/core/desktopUi/adapters/linuxPortalPolicy.js";
import { createLinuxDesktopUiAdapter } from "../../src/core/desktopUi/adapters/linux.js";
import type { DesktopProcessRunner } from "../../src/core/desktopUi/processRunner.js";
import type { DesktopDiscoveredWindow } from "../../src/core/desktopUi/types.js";

const target: DesktopDiscoveredWindow = {
  pid: 512, nativeId: "atspi:512:Editor", title: "Editor",
  application: "Example", active: true,
  bounds: { x: 50, y: 80, width: 640, height: 480 },
};

describe("Linux XDG Portal ScreenCast / PipeWire privacy policy", () => {
  it("requests only one nonpersistent WINDOW with hidden cursor", () => {
    expect(WINDOW_ONLY_PORTAL_SELECTION).toEqual({
      types: 2, multiple: false, cursor_mode: 1, persist_mode: 0,
    });
    expect(PYTHON_PORTAL_READINESS_SCRIPT).toContain("org.freedesktop.portal.ScreenCast");
    expect(PYTHON_PORTAL_READINESS_SCRIPT).toContain("AvailableSourceTypes");
    expect(PYTHON_PORTAL_READINESS_SCRIPT).not.toContain("SelectSources");
    expect(PYTHON_PORTAL_READINESS_SCRIPT).not.toContain("Start(");
  });

  it("rejects monitor, multiple streams, zero or reused-unsafe node-id-only metadata", () => {
    expect(() => parsePortalSelectedWindowStream([])).toThrow(/exactly one/);
    expect(() => parsePortalSelectedWindowStream([
      { source_type: 2, "pipewire-serial": "19" },
      { source_type: 2, "pipewire-serial": "20" },
    ])).toThrow(/exactly one/);
    expect(() => parsePortalSelectedWindowStream([
      { source_type: 1, "pipewire-serial": "19" },
    ])).toThrow(/WINDOW/);
    expect(() => parsePortalSelectedWindowStream([
      { source_type: 2, nodeId: 33 },
    ])).toThrow(/serial/);
    for (const bad of ["0", "-1", "01", "18446744073709551616", 19, "abc"]) {
      expect(() => parsePortalSelectedWindowStream([
        { source_type: 2, "pipewire-serial": bad },
      ])).toThrow();
    }
  });

  it("has an explicitly separate consent identity without PID or AT-SPI claims", () => {
    const identity = parsePortalSelectedWindowStream([
      { source_type: 2, "pipewire-serial": "18446744073709551615", nodeId: 1,
        title: "Untrusted", pid: 512, nativeId: target.nativeId },
    ]);
    expect(identity).toEqual({
      kind: "portal-user-selected-window",
      sourceType: 2, pipewireSerial: "18446744073709551615", atspiBound: false,
    });
    expect(identity).not.toHaveProperty("nodeId");
    expect(identity).not.toHaveProperty("pid");
    expect(identity).not.toHaveProperty("nativeId");

    const inventedAttestation = {
      sourceType: 2, pipewireSerial: "345", pid: target.pid,
      nativeId: target.nativeId, title: target.title,
      application: target.application, bounds: target.bounds,
    };
    expect(() => requireExactPortalWindowBinding([inventedAttestation], target))
      .toThrow(/cannot attest/);
  });

  it("strictly validates read-only portal capability status", () => {
    const ready = {
      available: true, supportsWindow: true, hiddenCursor: true,
      pipewireReader: true, version: 6,
    };
    expect(parseLinuxPortalReadiness(ready)).toEqual(ready);
    expect(() => parseLinuxPortalReadiness({ ...ready, version: "6" })).toThrow();
    expect(() => parseLinuxPortalReadiness({ available: true })).toThrow();
    expect(() => parseLinuxPortalReadiness(null)).toThrow();
  });

  it("recognizes positive WINDOW-only protocol without granting exact-target capture", () => {
    const ready = {
      available: true, version: 6, supportsWindow: true,
      hiddenCursor: true, pipewireReader: true,
    };
    expect(assessLinuxPortalWindowProtocol(parseLinuxPortalReadiness(ready))).toEqual({
      status: "window-only-protocol", captureAllowed: false, reason: "unbound-target-identity",
    });
    for (const [patch, expected] of [
      [{ available: false, version: 0, supportsWindow: false, hiddenCursor: false, pipewireReader: false }, "portal-unavailable"],
      [{ version: 5 }, "portal-version-unsupported"],
      [{ supportsWindow: false }, "window-source-unsupported"],
      [{ hiddenCursor: false }, "hidden-cursor-unsupported"],
      [{ pipewireReader: false }, "pipewire-reader-unavailable"],
    ] as const) {
      const state = parseLinuxPortalReadiness({ ...ready, ...patch });
      expect(assessLinuxPortalWindowProtocol(state)).toEqual({
        status: "denied", captureAllowed: false, reason: expected,
      });
    }
    expect(() => parseLinuxPortalReadiness({
      ...ready, available: false,
    })).toThrow("Invalid");
  });

  it("an explicitly requested X11 worker cannot silently revert to legacy screenshot tools", async () => {
    const session = process.env.XDG_SESSION_TYPE;
    const optIn = process.env.SUPERAGENT_DESKTOP_LIVE_X11;
    process.env.XDG_SESSION_TYPE = "x11";
    process.env.SUPERAGENT_DESKTOP_LIVE_X11 = "1";
    const called: string[] = [];
    const runner: DesktopProcessRunner = {
      run: vi.fn(async request => {
        called.push(request.executable);
        return { stdout: '{"ok":true}', stderr: "", exitCode: 0 };
      }),
    };
    try {
      const adapter = createLinuxDesktopUiAdapter(runner);
      const capability = await adapter.probe();
      if (process.platform !== "linux") {
        expect(capability.screenshot).toBe(false);
        expect(capability.errors.join(" ")).toContain("checksum-pinned");
      }
      expect(called).not.toContain("/usr/bin/gnome-screenshot");
      expect(called).not.toContain("/usr/bin/scrot");
    } finally {
      if (session === undefined) delete process.env.XDG_SESSION_TYPE;
      else process.env.XDG_SESSION_TYPE = session;
      if (optIn === undefined) delete process.env.SUPERAGENT_DESKTOP_LIVE_X11;
      else process.env.SUPERAGENT_DESKTOP_LIVE_X11 = optIn;
    }
  });

  it("Wayland adapter refuses target-bound capture without invoking screenshot tools", async () => {
    const previous = process.env.XDG_SESSION_TYPE;
    process.env.XDG_SESSION_TYPE = "wayland";
    const called: string[] = [];
    const runner: DesktopProcessRunner = {
      run: vi.fn(async request => {
        called.push(request.executable);
        if (request.args[1]?.includes("Atspi")) {
          return { stdout: '{"ok":true}', stderr: "", exitCode: 0 };
        }
        return { stdout: JSON.stringify({
          available: true, supportsWindow: true, hiddenCursor: true,
          pipewireReader: true, version: 6,
        }), stderr: "", exitCode: 0 };
      }),
    };
    try {
      const adapter = createLinuxDesktopUiAdapter(runner);
      const capability = await adapter.probe();
      expect(capability.screenshot).toBe(false);
      expect(capability.available).toBe(false);
      expect(capability.errors.join(" ")).toContain("AT-SPI PID/native-ID");
      await expect(adapter.capture({
        pid: target.pid, nativeId: target.nativeId, title: target.title,
      })).rejects.toMatchObject({ code: "OS_PERMISSION_REQUIRED" });
      expect(called.every(executable => executable === "/usr/bin/python3")).toBe(true);
      expect(runner.run).toHaveBeenCalledTimes(2);
    } finally {
      if (previous === undefined) delete process.env.XDG_SESSION_TYPE;
      else process.env.XDG_SESSION_TYPE = previous;
    }
  });
});
