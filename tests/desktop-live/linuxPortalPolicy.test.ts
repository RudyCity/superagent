import { describe, expect, it, vi } from "vitest";
import {
  WINDOW_ONLY_PORTAL_SELECTION,
  PYTHON_PORTAL_READINESS_SCRIPT,
  parseLinuxPortalReadiness,
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
  it("only authorizes a single nonpersistent WINDOW with hidden cursor", () => {
    expect(WINDOW_ONLY_PORTAL_SELECTION).toEqual({
      types: 2, multiple: false, cursor_mode: 1, persist_mode: 0,
    });
    expect(PYTHON_PORTAL_READINESS_SCRIPT).toContain("org.freedesktop.portal.ScreenCast");
    expect(PYTHON_PORTAL_READINESS_SCRIPT).toContain("AvailableSourceTypes");
    expect(PYTHON_PORTAL_READINESS_SCRIPT).toContain("pipewiresrc");
    expect(PYTHON_PORTAL_READINESS_SCRIPT).not.toContain("SelectSources");
    expect(PYTHON_PORTAL_READINESS_SCRIPT).not.toContain("Start(");
  });

  it("denies standard opaque portal node stream without PID and AT-SPI identity", () => {
    const ordinary = [{
      sourceType: 2, pipewireSerial: "124",
      size: [640,480], id: "compositor-opaque-window",
    }];
    expect(() => requireExactPortalWindowBinding(ordinary,target)).toThrow(/attestation/);
    expect(() => requireExactPortalWindowBinding([
      {...ordinary[0],pid:512,nativeId:target.nativeId,title:target.title,
        application:target.application,bounds:target.bounds},
      ordinary[0],
    ],target)).toThrow(/exactly one/);
    expect(() => requireExactPortalWindowBinding([{
      sourceType: 1, pipewireSerial: "124", ...target,
    }],target)).toThrow(/attestation/);
  });

  it("accepts only a compositor-attested exact window and unique serial", () => {
    const fullyAttested = {
      sourceType:2,pipewireSerial:"123456",
      pid:target.pid,nativeId:target.nativeId,title:target.title,
      application:target.application,bounds:{...target.bounds},
    };
    expect(requireExactPortalWindowBinding([fullyAttested],target)).toBe("123456");
    for (const altered of [
      {...fullyAttested,pid:target.pid+1},
      {...fullyAttested,title:"Other"},
      {...fullyAttested,pipewireSerial:"0"},
      {...fullyAttested,bounds:{...target.bounds,width:1280}},
    ]) {
      expect(() => requireExactPortalWindowBinding([altered],target)).toThrow();
    }
  });

  it("strictly validates read-only portal capability status", () => {
    const ready = {
      available:true,supportsWindow:true,hiddenCursor:true,
      pipewireReader:true,version:6,
    };
    expect(parseLinuxPortalReadiness(ready)).toEqual(ready);
    expect(() => parseLinuxPortalReadiness({...ready,version:"6"})).toThrow();
    expect(() => parseLinuxPortalReadiness({available:true})).toThrow();
    expect(() => parseLinuxPortalReadiness(null)).toThrow();
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
        return {stdout:'{"ok":true}',stderr:"",exitCode:0};
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

  it("Wayland adapter refuses screen capture before invoking any screenshot command", async () => {
    const previous = process.env.XDG_SESSION_TYPE;
    process.env.XDG_SESSION_TYPE="wayland";
    const called: string[] = [];
    const runner: DesktopProcessRunner = {
      run: vi.fn(async request => {
        called.push(request.executable);
        if (request.args[1]?.includes("Atspi")) {
          return {stdout:'{"ok":true}',stderr:"",exitCode:0};
        }
        return {stdout:JSON.stringify({
          available:true,supportsWindow:true,hiddenCursor:true,
          pipewireReader:true,version:6,
        }),stderr:"",exitCode:0};
      }),
    };
    try {
      const adapter = createLinuxDesktopUiAdapter(runner);
      const capability = await adapter.probe();
      expect(capability.screenshot).toBe(false);
      expect(capability.available).toBe(false);
      expect(capability.errors.join(" ")).toContain("AT-SPI PID/native-ID");
      await expect(adapter.capture({
        pid:target.pid,nativeId:target.nativeId,title:target.title,
      })).rejects.toMatchObject({code:"OS_PERMISSION_REQUIRED"});
      expect(called.every(executable => executable==="/usr/bin/python3")).toBe(true);
      expect(runner.run).toHaveBeenCalledTimes(2);
    } finally {
      if (previous===undefined) delete process.env.XDG_SESSION_TYPE;
      else process.env.XDG_SESSION_TYPE=previous;
    }
  });
});