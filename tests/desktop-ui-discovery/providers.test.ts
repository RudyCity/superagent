import { describe, expect, it, vi } from "vitest";
import { createWindowsDesktopUiAdapter } from "../../src/core/desktopUi/adapters/windows.js";
import { createMacOsDesktopUiAdapter } from "../../src/core/desktopUi/adapters/macos.js";
import { createLinuxDesktopUiAdapter } from "../../src/core/desktopUi/adapters/linux.js";
import type { DesktopProcessRunner } from "../../src/core/desktopUi/processRunner.js";

const baseWindow = {
  pid: 88,
  title: "Fixture",
  application: "FixtureApp",
  active: true,
  bounds: { x: 10, y: 20, width: 300, height: 200 },
};

function runnerWith(handler: (request: Parameters<DesktopProcessRunner["run"]>[0]) => string): DesktopProcessRunner {
  return {
    run: vi.fn(async (request) => ({ stdout: handler(request), stderr: "", exitCode: 0 })),
  };
}

describe("platform window discovery providers", () => {
  it("Windows discovery uses EnumWindows/GetForegroundWindow with physical DPI and never MainWindowHandle", async () => {
    let script = "";
    const runner = runnerWith((request) => {
      script = Buffer.from(request.args.at(-1)!, "base64").toString("utf16le");
      expect(JSON.parse(request.env!.SUPERAGENT_DESKTOP_UI_PAYLOAD)).toEqual({ limit: 7 });
      return JSON.stringify({ windows: [{ ...baseWindow, nativeId: "12345", scaleFactor: 1.5 }], limit: 7, truncated: false });
    });
    const result = await createWindowsDesktopUiAdapter(runner).listWindows!(7);
    expect(result.windows[0]).toMatchObject({ nativeId: "12345", application: "FixtureApp", active: true });
    expect(script).toContain("EnumWindows");
    expect(script).toContain("GetForegroundWindow");
    expect(script).toContain("GetDpiForWindow");
    expect(script).toContain("GetWindowDisplayAffinity");
    expect(script).not.toContain("MainWindowHandle");
  });

  it("macOS discovery requires AX and maps windows to stable CoreGraphics IDs", async () => {
    let script = "";
    const runner = runnerWith((request) => {
      script = request.args.at(-1)!;
      return JSON.stringify({ windows: [{ ...baseWindow, nativeId: "cg:991" }], limit: 4, truncated: false, skippedAmbiguous: 1 });
    });
    const result = await createMacOsDesktopUiAdapter(runner).listWindows!(4);
    expect(result.windows[0].nativeId).toBe("cg:991");
    expect(result.skippedAmbiguous).toBe(1);
    expect(script).toContain("UIElementsEnabled");
    expect(script).toContain("CGWindowListCopyWindowInfo");
    expect(script).toContain("kCGWindowNumber");
  });

  it("Linux discovery uses AT-SPI and rejects duplicate pid/title identities", async () => {
    let script = "";
    const runner = runnerWith((request) => {
      script = request.args[1];
      return JSON.stringify({
        windows: [
          { ...baseWindow, nativeId: "atspi:88:Fixture" },
          { ...baseWindow, nativeId: "atspi:88:Fixture" },
        ],
        limit: 10,
        truncated: false,
      });
    });
    await expect(createLinuxDesktopUiAdapter(runner).listWindows!(10)).rejects.toMatchObject({ code: "PROCESS_FAILED" });
    expect(script).toContain("Atspi.get_desktop");
    expect(script).toContain("ambiguous");
    expect(script).not.toContain("xdotool");
  });
});
