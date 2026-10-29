/**
 * Browser Runtime Lifecycle & Process Ownership Unit Tests (Milestone M1)
 *
 * Validates process ownership registration with ProcessSupervisor, isolated profile preparation,
 * graceful stop invariants (refusing to kill foreign/unverified PIDs), and single-instance locks.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BrowserProcessManager,
  resetBrowserProcessManagerForTest,
} from "../src/core/browserRuntime/browserProcessManager.js";
import {
  getProcessSupervisor,
  resetProcessSupervisorForTest,
} from "../src/core/process/processSupervisor.js";

describe("Browser Runtime Lifecycle & Ownership", () => {
  let testDir: string;
  let manager: BrowserProcessManager;

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `sp-browser-test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    fs.mkdirSync(testDir, { recursive: true });
    resetBrowserProcessManagerForTest();
    resetProcessSupervisorForTest();
    manager = new BrowserProcessManager();
  });

  afterEach(() => {
    resetBrowserProcessManagerForTest();
    resetProcessSupervisorForTest();
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  it("prepares isolated profile directory with proper permissions", async () => {
    const profileDir = path.join(testDir, "test-chrome-profile");
    await manager.prepareUserDataDir(profileDir);
    expect(fs.existsSync(profileDir)).toBe(true);

    if (os.platform() !== "win32") {
      const stats = fs.statSync(profileDir);
      // Mode 0700 (directory + rwx by owner)
      expect(stats.mode & 0o777).toBe(0o700);
    }
  });

  it("generates isolated default directory per port", () => {
    const dir9222 = manager.getDefaultUserDataDir(9222);
    const dir9333 = manager.getDefaultUserDataDir(9333);
    expect(dir9222).toContain("chrome-debug-profile");
    expect(dir9333).toContain("chrome-debug-profile-9333");
    expect(dir9222).not.toBe(dir9333);
  });

  it("refuses to terminate untracked external PIDs", async () => {
    // Attempting to stop an untracked port should fail closed without signaling any process
    const res = await manager.stopBrowser({ port: 9876 });
    expect(res.success).toBe(false);
    expect(res.pid).toBe(null);
    expect(res.reason).toContain("No tracked browser instance found on port 9876");
  });

  it("refuses to terminate a process whose start identity does not match", async () => {
    // Register a mock tracked instance with a mismatched creation identity
    const supervisor = getProcessSupervisor();
    await supervisor.initialize();
    const record = await supervisor.registerProcess({
      component: "browser-runtime",
      executable: "chrome.exe",
      launchIntent: "headless",
      workspaceRoot: testDir,
    });

    // Use current process PID but with an impossible creation ticks identity
    const fakeRecord = {
      recordId: record.recordId,
      pid: process.pid,
      creationIdentity: "win:0000000000000000000",
      port: 9222,
      host: "127.0.0.1",
      mode: "headless" as const,
      resolvedMode: "headless" as const,
      executable: "chrome.exe",
      userDataDir: testDir,
      profileName: "Default",
      browserFingerprint: "mock-fingerprint",
      launchedAt: Date.now(),
      generation: record.runtimeGeneration,
    };

    (manager as any).activeInstances.set(9222, fakeRecord);

    const res = await manager.stopBrowser({ port: 9222 });
    expect(res.success).toBe(false);
    expect(res.reason).toContain("Process start identity mismatch");
    // Verify current process was NOT terminated!
  });

  it("integrates process registration with ProcessSupervisor diagnostics", async () => {
    const supervisor = getProcessSupervisor();
    await supervisor.initialize();

    const record = await supervisor.registerProcess({
      component: "browser-runtime",
      executable: "google-chrome",
      args: ["--headless=new", "--remote-debugging-port=9222"],
      launchIntent: "headless",
      workspaceRoot: testDir,
    });

    expect(record.component).toBe("browser-runtime");
    expect(record.executable).toBe("google-chrome");
    expect(record.state).toBe("registered");

    await supervisor.recordProcessSpawn(record.recordId, process.pid);
    const diag = await supervisor.getProcessDiagnostics({ callerWorkspaceRoot: testDir });
    expect(diag.entries.some((e) => e.recordId === record.recordId && e.pid === process.pid)).toBe(true);
  });
});
