import { afterEach, describe, expect, it } from "vitest";
import { DesktopUiError } from "../../src/core/desktopUi/errors.js";
import { createLinuxDesktopUiAdapter } from "../../src/core/desktopUi/adapters/linux.js";
import { createMacOsDesktopUiAdapter } from "../../src/core/desktopUi/adapters/macos.js";
import { createWindowsDesktopUiAdapter } from "../../src/core/desktopUi/adapters/windows.js";
import { createNativeDesktopUiAdapter } from "../../src/core/desktopUi/nativeAdapter.js";
import {
  createRestrictedProcessRunner,
  type DesktopProcessRunner,
  type SafeProcessRequest,
} from "../../src/core/desktopUi/processRunner.js";

afterEach(() => {
  delete process.env.XDG_SESSION_TYPE;
});

const keyAction = {
  kind: "key" as const,
  target: { pid: 42, nativeId: "atspi:42:Fixture", title: "Fixture" },
  key: "ENTER" as const,
  modifiers: [],
};

describe("native adapter capability policy", () => {
  it("reports Windows support only after its fixed dependency and DPI probe succeeds", async () => {
    const runner: DesktopProcessRunner = {
      run: async () => ({ stdout: '{"available":true,"dpiAware":true}', stderr: "", exitCode: 0 }),
    };
    const capabilities = await createWindowsDesktopUiAdapter(runner).probe();
    expect(capabilities).toMatchObject({
      platform: "win32",
      available: true,
      screenshot: true,
      accessibility: true,
      input: true,
      scroll: true,
    });
    expect(capabilities.limitations.join(" ")).toContain("root HWND");
    expect(capabilities.limitations.join(" ")).toContain("PrintWindow");
  });

  it("fails Windows capabilities closed when physical DPI context is not proven", async () => {
    const runner: DesktopProcessRunner = {
      run: async () => ({ stdout: '{"available":true,"dpiAware":false}', stderr: "", exitCode: 0 }),
    };
    const capabilities = await createWindowsDesktopUiAdapter(runner).probe();
    expect(capabilities.available).toBe(false);
    expect(capabilities.screenshot).toBe(false);
    expect(capabilities.input).toBe(false);
  });

  it("does not report macOS screenshot support when Screen Recording permission is absent", async () => {
    const runner: DesktopProcessRunner = {
      run: async () => ({ stdout: '{"accessibility":true,"screenRecording":false}', stderr: "", exitCode: 0 }),
    };
    const capabilities = await createMacOsDesktopUiAdapter(runner).probe();
    expect(capabilities.available).toBe(false);
    expect(capabilities.screenshot).toBe(false);
    expect(capabilities.accessibility).toBe(true);
    expect(capabilities.errors.join(" ")).toContain("Screen Recording");
  });

  it("default-denies Linux input on Wayland at both capability and dispatch boundaries", async () => {
    process.env.XDG_SESSION_TYPE = "wayland";
    const runner: DesktopProcessRunner = {
      run: async (request: SafeProcessRequest) => {
        if (request.executable.endsWith("gnome-screenshot")) {
          return { stdout: "gnome-screenshot 41.0", stderr: "", exitCode: 0 };
        }
        return { stdout: '{"ok":true}', stderr: "", exitCode: 0 };
      },
    };
    const adapter = createLinuxDesktopUiAdapter(runner);
    const capabilities = await adapter.probe();
    expect(capabilities).toMatchObject({
      platform: "linux",
      screenshot: true,
      accessibility: true,
      input: false,
      scroll: false,
      sessionType: "wayland",
    });
    expect(capabilities.errors.join(" ")).toContain("Wayland");
    await expect(adapter.dispatch(keyAction)).rejects.toMatchObject({ code: "WAYLAND_INPUT_UNAVAILABLE" });
  });

  it("default-denies Linux input when the session type is empty or unknown", async () => {
    const runner: DesktopProcessRunner = {
      run: async (request: SafeProcessRequest) => {
        if (request.executable.endsWith("gnome-screenshot")) {
          return { stdout: "gnome-screenshot 41.0", stderr: "", exitCode: 0 };
        }
        return { stdout: '{"ok":true}', stderr: "", exitCode: 0 };
      },
    };
    const adapter = createLinuxDesktopUiAdapter(runner);
    const capabilities = await adapter.probe();
    expect(capabilities).toMatchObject({
      screenshot: true,
      input: false,
      scroll: false,
      sessionType: "unknown",
    });
    expect(capabilities.errors.join(" ")).toContain("explicitly and positively identified as x11");
    await expect(adapter.dispatch(keyAction)).rejects.toMatchObject({ code: "INPUT_UNAVAILABLE" });
  });

  it("enables Linux input only for a positively identified X11 session", async () => {
    process.env.XDG_SESSION_TYPE = "x11";
    const runner: DesktopProcessRunner = {
      run: async (request: SafeProcessRequest) => {
        if (request.executable.endsWith("gnome-screenshot")) {
          return { stdout: "gnome-screenshot 41.0", stderr: "", exitCode: 0 };
        }
        return { stdout: '{"ok":true}', stderr: "", exitCode: 0 };
      },
    };
    const capabilities = await createLinuxDesktopUiAdapter(runner).probe();
    expect(capabilities.input).toBe(true);
    expect(capabilities.scroll).toBe(true);
  });

  it("rejects platforms without an explicit native adapter", () => {
    expect(() => createNativeDesktopUiAdapter({ platform: "freebsd" })).toThrowError(DesktopUiError);
  });

  it("never executes a command outside the exact per-adapter executable allowlist", async () => {
    const runner = createRestrictedProcessRunner(["C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"]);

    await expect(runner.run({
      executable: "cmd.exe",
      args: ["/c", "echo should-not-run"],
    })).rejects.toMatchObject({ code: "PROCESS_FAILED" });

    await expect(runner.run({
      executable: "C:/attacker/powershell.exe",
      args: ["-NoProfile"],
    })).rejects.toMatchObject({ code: "PROCESS_FAILED" });
  });
});
