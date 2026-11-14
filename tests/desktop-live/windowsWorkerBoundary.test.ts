import { describe, expect, it } from "vitest";
import { openWindowsVerifiedCapture } from "../../src/core/desktopUi/adapters/windowsPreviewWorker.js";
import type { DesktopDiscoveredWindow } from "../../src/core/desktopUi/types.js";

const approved: DesktopDiscoveredWindow = {
  pid: 4102, nativeId: "425912", title: "Approved fixture",
  application: "powershell", active: true,
  bounds: { x: 50, y: 70, width: 500, height: 300 },
};

describe("persistent Windows exact-window capture input policy", () => {
  it("refuses a nonnumeric handle before launching any process", async () => {
    for (const id of ["0;Start-Process calc", "hwnd:425912", "", "-55", "425912\nexit"]) {
      await expect(openWindowsVerifiedCapture({ ...approved, nativeId: id })).rejects.toThrow(/verified Windows HWND/);
    }
  });
  it("rejects invalid PID and bounds before any native process is started", async () => {
    await expect(openWindowsVerifiedCapture({ ...approved, pid: 0 })).rejects.toThrow(/verified Windows HWND/);
    await expect(openWindowsVerifiedCapture({ ...approved, pid: Number.NaN })).rejects.toThrow(/verified Windows HWND/);
    await expect(openWindowsVerifiedCapture({ ...approved, bounds:{...approved.bounds,width:0.5} }))
      .rejects.toThrow(/verified Windows HWND/);
  });
  it.skipIf(process.platform === "win32")("rejects Windows capture activation on other operating systems", async () => {
    await expect(openWindowsVerifiedCapture(approved)).rejects.toThrow(/verified Windows HWND/);
  });
});
