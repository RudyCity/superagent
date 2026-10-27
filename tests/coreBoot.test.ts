import { describe, expect, it } from "vitest";
import { createCoreWindowsStartupPlan } from "../src/core/runtime/coreWindowsStartup.js";
import { decideCoreBoot } from "../src/core/runtime/coreBoot.js";

const clean = {
  checkpointPresent: false, discoveryPresent: false, guardianLeasePresent: false,
  verifiedRunningOwner: false, checkpointValid: false, checkpointModeMatches: false,
  coldResetAllowed: false,
};
describe("fail-closed Core login bootstrap", () => {
  it("starts fresh guardian only with an empty owner namespace", () => {
    expect(decideCoreBoot(clean)).toBe("fresh_guard");
    expect(decideCoreBoot({ ...clean, discoveryPresent: true })).toBe("refuse");
    expect(decideCoreBoot({ ...clean, guardianLeasePresent: true })).toBe("refuse");
  });
  it("recovers only a well-formed checkpoint whose client mode matches", () => {
    expect(decideCoreBoot({ ...clean, checkpointPresent: true,
      checkpointValid: true, checkpointModeMatches: true })).toBe("recover_survivors");
    expect(decideCoreBoot({ ...clean, checkpointPresent: true,
      checkpointValid: false, checkpointModeMatches: true })).toBe("refuse");
    expect(decideCoreBoot({ ...clean, checkpointPresent: true,
      checkpointValid: true, checkpointModeMatches: false })).toBe("refuse");
  });
  it("allows cold reset only when an external auditor explicitly proved it safe", () => {
    expect(decideCoreBoot({ ...clean, checkpointPresent: true,
      checkpointValid: true, checkpointModeMatches: true,
      guardianLeasePresent: true, discoveryPresent: true,
      coldResetAllowed: true })).toBe("cold_reset");
    expect(decideCoreBoot({ ...clean, checkpointPresent: true,
      checkpointValid: true, checkpointModeMatches: true,
      guardianLeasePresent: true, discoveryPresent: true,
      coldResetAllowed: false })).toBe("refuse");
  });
  it("does nothing if the owner is already authenticated and online", () => {
    expect(decideCoreBoot({ ...clean, verifiedRunningOwner: true,
      coldResetAllowed: true })).toBe("already_running");
  });
});
describe("Windows startup task planning is safe and opt-in", () => {
  const opts = { port: 7888, cliFile: "D:\Projects\super agent\dist\cli.js",
    bunExecutable: "C:\Users\USER\.bun\bin\bun.exe",
    launcherFile: "C:\Users\USER\.superagent-r\windows-startup\core-boot-7888.ps1" };
  it("produces a user-level logon task for Core boot, not an elevated service", () => {
    const plan = createCoreWindowsStartupPlan(opts);
    expect(plan.taskName).toBe("SuperAgent-Core-Boot-7888");
    expect(plan.registerCommand).toContain("New-ScheduledTaskTrigger -AtLogOn");
    expect(plan.registerCommand).toContain("-RunLevel Limited");
    expect(plan.registerCommand).not.toContain("-Force");
    expect(plan.registerCommand).toContain("-RestartCount 3");
    expect(plan.launcherContent).toContain("core boot --port 7888 --client-mode tline");
    expect(plan.launcherContent).toContain("'D:\Projects\super agent\dist\cli.js'");
    expect(plan.launcherContent).not.toContain("taskkill");
    expect(plan.launcherContent).not.toContain("schtasks /DELETE");
  });
  it("escapes single quotes in script paths and never interpolates them as code", () => {
    const withQuote = createCoreWindowsStartupPlan({
      ...opts, cliFile: "D:\O'Brian\app\dist\cli.js",
    });
    expect(withQuote.launcherContent).toContain("'D:\O''Brian\app\dist\cli.js'");
  });
  it("rejects unsafe ports, UNC and relative paths, invalid executable types", () => {
    expect(() => createCoreWindowsStartupPlan({ ...opts, port: 0 })).toThrow();
    expect(() => createCoreWindowsStartupPlan({ ...opts, port: 80 })).toThrow();
    expect(() => createCoreWindowsStartupPlan({ ...opts, cliFile: "\\server\remote\dist\cli.js" })).toThrow();
    expect(() => createCoreWindowsStartupPlan({ ...opts, bunExecutable: "bun" })).toThrow();
    expect(() => createCoreWindowsStartupPlan({ ...opts, launcherFile: "C:\tmp\evil.ps1
New-Code" })).toThrow();
  });
});
