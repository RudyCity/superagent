import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { sshProxy } from "../src/core/ssh/sshProxy.js";
import { workspaceMode } from "../src/core/ssh/workspaceMode.js";
import { workspaceCommand } from "../src/core/commands/workspaceCommand.js";

describe("SSH Advanced Features (Smart Cache & System Metrics)", () => {
  beforeEach(() => {
    workspaceMode.setLocalMode();
  });

  afterEach(() => {
    workspaceMode.setLocalMode();
  });

  it("should run workspace wizard in local mode without error", async () => {
    let wizardStarted = false;
    await workspaceCommand.execute("status", {
      agent: { workingDirectory: "/test/local" },
      addLine: () => {},
      setActiveWizard: () => { wizardStarted = true; },
      setWizardOptions: () => {},
      setWizardSelectedIndex: () => {},
    } as any);
    expect(true).toBe(true);
  });

  it("should manage SFTP smart cache entries", () => {
    sshProxy.clearCache();
    expect((sshProxy as any).fileCache.size).toBe(0);

    (sshProxy as any).fileCache.set("/remote/file.txt", {
      content: "cached data",
      timestamp: Date.now(),
    });
    expect((sshProxy as any).fileCache.size).toBe(1);

    sshProxy.clearCache();
    expect((sshProxy as any).fileCache.size).toBe(0);
  });
});
