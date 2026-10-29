/**
 * Browser Runtime Windows Regression & Tool Integration Tests (Milestone M1)
 *
 * Verifies that Windows headed behavior, isolated profiles, and process spawn policies
 * suffer no regressions, and that virtual-display mode fails fast across all platforms.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  launchChromeProfileTool,
  browserRuntimeStatusTool,
  stopBrowserRuntimeTool,
} from "../src/core/tools/chromeBrowserTools.js";
import { ensureCdpRunning } from "../src/core/tools/chromeCommon.js";
import { resetBrowserProcessManagerForTest } from "../src/core/browserRuntime/browserProcessManager.js";
import { applyProcessIntent } from "../src/core/process/processSpawnPolicy.js";

describe("Browser Runtime Windows Regression & Tool Policy", () => {
  beforeEach(() => {
    resetBrowserProcessManagerForTest();
  });

  afterEach(() => {
    resetBrowserProcessManagerForTest();
  });

  it("fails fast with clear error when virtual-display mode is invoked on Windows", async () => {
    const res = await launchChromeProfileTool.execute({
      mode: "virtual-display",
      profileName: "Default",
    });

    expect(typeof res).toBe("string");
    expect(res).toContain("Virtual display mode");
    expect(res).toContain("only supported on Linux");
  });

  it("launches with profile and isolated directory without throwing", async () => {
    // Testing non-CDP launch command formatting (without remoteDebuggingPort)
    const res = await launchChromeProfileTool.execute({
      profileName: "Profile 1",
      url: "https://example.com",
    });

    expect(typeof res).toBe("string");
    expect(res).toContain("Profile 1");
    expect(res).toContain("https://example.com");
  });

  it("browserRuntimeStatusTool renders clean Markdown report for stopped browser", async () => {
    const res = await browserRuntimeStatusTool.execute({ port: 18999 });
    expect(typeof res).toBe("string");
    expect(res).toContain("### Browser Runtime Health (Port 18999)");
    expect(res).toContain("**Status**: ⚪ Stopped");
    expect(res).toContain("**Listening**: No");
  });

  it("stopBrowserRuntimeTool safely fails closed on unowned port", async () => {
    const res = await stopBrowserRuntimeTool.execute({ port: 18999 });
    expect(typeof res).toBe("string");
    expect(res).toContain("Could not stop browser on port 18999");
    expect(res).toContain("No tracked browser instance found");
  });

  it("ensureCdpRunning fails closed in test environment when port is closed", async () => {
    // Under NODE_ENV=test and VITEST, auto-launch must return false without hanging or spawning
    const res = await ensureCdpRunning("127.0.0.1", 19998);
    expect(res).toBe(false);
  });

  it("applies headless process intent for Windows without console splash regressions", () => {
    const baseOpts = { timeout: 15000 };
    const headlessOpts = applyProcessIntent(baseOpts, "headless", {
      caller: "test.headless",
      executable: "chrome.exe",
    });

    // In headless intent on Windows, windowsHide is true and maxBuffer is bounded
    expect(headlessOpts.windowsHide).toBe(true);
    expect(headlessOpts.timeout).toBe(15000);
  });
});
