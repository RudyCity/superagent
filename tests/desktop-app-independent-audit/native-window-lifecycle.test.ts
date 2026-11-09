import { describe, expect, it, vi } from "vitest";
import { createLinuxWindowLifecycle } from "../../src/core/desktopApp/linuxWindow.js";
import { createMacWindowLifecycle } from "../../src/core/desktopApp/macWindow.js";
import type { DesktopProcessRunner } from "../../src/core/desktopUi/processRunner.js";

describe("exact native window lifecycle boundaries", () => {
  it("macOS matches CG window ID, owner PID, bounds and AX window before focus/close", async () => {
    const calls: any[] = [];
    const runner: DesktopProcessRunner = {
      run: vi.fn(async (req) => {
        calls.push(req);
        const operation = JSON.parse(req.env!.SUPERAGENT_DESKTOP_APP_WINDOW);
        const receipt = operation.action === "focus"
          ? { focused: true } : operation.action === "close"
            ? { closeRequested: true } : { exists: true };
        return { stdout: JSON.stringify(receipt), stderr: "", exitCode: 0 };
      }),
    };
    const native = createMacWindowLifecycle({ runner });
    await expect(native.focusExact({ pid: 44, nativeId: "cg:12345" })).resolves.toMatchObject({ focused: true });
    await expect(native.closeExact({ pid: 44, nativeId: "cg:12345" })).resolves.toMatchObject({ closeRequested: true });
    const script = calls[0].args.at(-1);
    expect(script).toContain("kCGWindowOwnerPID");
    expect(script).toContain("kCGWindowNumber");
    expect(script).toContain("matching.length!==1");
    expect(script).toContain("AXRaise");
    expect(script).toContain("AXCloseButton");
    await expect(native.closeExact({ pid: 44, nativeId: "cg:0" })).rejects.toMatchObject({ code: "INVALID_ACTION" });
    await expect(native.closeExact({ pid: 44, nativeId: "cg:../../" })).rejects.toMatchObject({ code: "INVALID_ACTION" });
    expect(calls).toHaveLength(2);
  });

  it("Linux enforces PID/title and confirmed X11 before any window action", async () => {
    const calls: any[] = [];
    const runner: DesktopProcessRunner = {
      run: vi.fn(async (req) => {
        calls.push(req);
        const operation = JSON.parse(req.env!.SUPERAGENT_DESKTOP_APP_WINDOW);
        const response = operation.action === "focus"
          ? { focused: true } : operation.action === "close"
            ? { closeRequested: true } : { exists: true };
        return { stdout: JSON.stringify(response), stderr: "", exitCode: 0 };
      }),
    };
    const native = createLinuxWindowLifecycle({ runner, sessionType: "x11" });
    await expect(native.focusExact({ pid: 77, nativeId: "atspi:77:Editor" })).resolves.toMatchObject({ focused: true });
    await expect(native.closeExact({ pid: 77, nativeId: "atspi:77:Editor" })).resolves.toMatchObject({ closeRequested: true });
    expect(calls[0].args[1]).toContain("grab_focus()");
    expect(calls[1].args[1]).toContain('lower()=="close"');
    await expect(native.closeExact({ pid: 78, nativeId: "atspi:77:Editor" })).rejects.toMatchObject({ code: "TARGET_NOT_FOUND" });
    const wayland = createLinuxWindowLifecycle({ runner, sessionType: "wayland" });
    await expect(wayland.focusExact({ pid: 77, nativeId: "atspi:77:Editor" })).rejects.toMatchObject({ code: "OS_PERMISSION_REQUIRED" });
    expect(calls).toHaveLength(2);
  });

  it("does not restart macOS/Linux apps while the original process still exists", async () => {
    const macAlive = createMacWindowLifecycle({ isProcessAlive: () => true });
    const macGone = createMacWindowLifecycle({ isProcessAlive: () => false });
    const linuxAlive = createLinuxWindowLifecycle({ sessionType: "x11", isProcessAlive: () => true });
    const linuxGone = createLinuxWindowLifecycle({ sessionType: "x11", isProcessAlive: () => false });
    await expect(macAlive.waitUntilClosed({ pid: 41, nativeId: "cg:1" }, 100)).resolves.toBe(false);
    await expect(macGone.waitUntilClosed({ pid: 41, nativeId: "cg:1" }, 100)).resolves.toBe(true);
    await expect(linuxAlive.waitUntilClosed({ pid: 41, nativeId: "atspi:41:Editor" }, 100)).resolves.toBe(false);
    await expect(linuxGone.waitUntilClosed({ pid: 41, nativeId: "atspi:41:Editor" }, 100)).resolves.toBe(true);
  });

});
