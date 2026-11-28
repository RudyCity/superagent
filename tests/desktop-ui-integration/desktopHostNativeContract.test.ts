import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/**
 * Static contract tests for the native host. Vitest never executes the WinExe;
 * these assertions pin the security decisions that live in C#, so a future edit
 * that silently drops a privilege, the elevation refusal, or the announced
 * rotation fails the suite. The runtime behaviour of the same code is covered by
 * the injected-double client tests and by the live build verification.
 */
const NATIVE_SOURCE_DIR = new URL("../../native/desktop-host/", import.meta.url);
const REPORT_PATH = new URL("../../docs/reports/2026-11-27-desktop-ui-remaining-items.md", import.meta.url);

async function nativeSource(name: string): Promise<string> {
  return readFile(new URL(name, NATIVE_SOURCE_DIR), "utf8");
}

const DANGEROUS_PRIVILEGES = [
  "SeDebugPrivilege",
  "SeImpersonatePrivilege",
  "SeTakeOwnershipPrivilege",
  "SeLoadDriverPrivilege",
  "SeTcbPrivilege",
  "SeAssignPrimaryTokenPrivilege",
  "SeIncreaseQuotaPrivilege",
  "SeBackupPrivilege",
  "SeRestorePrivilege",
  "SeShutdownPrivilege",
];

describe("native privilege hardening contract", () => {
  it("removes every dangerous privilege and never touches SeChangeNotifyPrivilege", async () => {
    const guard = await nativeSource("PrivilegeGuard.cs");
    for (const privilege of DANGEROUS_PRIVILEGES) {
      expect(guard).toContain(`"${privilege}"`);
    }
    const arrayStart = guard.indexOf("DangerousPrivileges = new string[]");
    expect(arrayStart).toBeGreaterThan(0);
    const arrayEnd = guard.indexOf("};", arrayStart);
    expect(arrayEnd).toBeGreaterThan(arrayStart);
    const arrayBody = guard.slice(arrayStart, arrayEnd);
    for (const privilege of DANGEROUS_PRIVILEGES) {
      expect(arrayBody).toContain(privilege);
    }
    // Bypass traverse checking stays enabled: the CLR and file/registry access
    // need it, and it does not grant capture or UIA reach.
    expect(arrayBody).not.toContain("SeChangeNotifyPrivilege");
    expect(guard).toContain("SeChangeNotifyPrivilege");
    // Removal is permanent, with plain-disable only as the fallback.
    expect(guard).toContain("SePrivilegeRemoved");
    expect(guard).toContain("AdjustTokenPrivileges");
  });

  it("refuses an elevated token with a typed error and a non-zero exit", async () => {
    const guard = await nativeSource("PrivilegeGuard.cs");
    const program = await nativeSource("Program.cs");
    expect(guard).toContain("TokenElevation");
    expect(guard).toContain("ELEVATED_TOKEN");
    expect(program).toContain("PrivilegeGuard.TryHarden");
    expect(program).toMatch(/ExitElevated\s*=\s*7/);
    expect(program).toMatch(/ExitPrivilegeHardening\s*=\s*8/);
    expect(program).toMatch(/ProtocolJson\.WriteError\(stdout, hardeningCode, hardeningMessage\)/);
    expect(program).toMatch(/hardeningCode == PrivilegeGuard\.ElevatedCode \? ExitElevated/);
  });

  it("advertises the hardening state and the bounded lifetime in the ready line", async () => {
    const program = await nativeSource("Program.cs");
    expect(program).toContain('ready.Name("elevated").Value(false)');
    expect(program).toContain('ready.Name("privilegesRemoved")');
    expect(program).toContain('ready.Name("maxRequests")');
    expect(program).toContain('ready.Name("maxLifetimeMs")');
  });
});

describe("native bounded lifetime contract", () => {
  it("defaults to 500 requests and 10 minutes and reads the documented environment names", async () => {
    const budget = await nativeSource("HostBudget.cs");
    expect(budget).toContain("SUPERAGENT_DESKTOP_HOST_MAX_REQUESTS");
    expect(budget).toContain("SUPERAGENT_DESKTOP_HOST_MAX_LIFETIME_MS");
    expect(budget).toMatch(/DefaultMaxRequests\s*=\s*500/);
    expect(budget).toMatch(/DefaultMaxLifetimeMs\s*=\s*600000/);
    expect(budget).toMatch(/RequestCapReason\s*=\s*"request-cap"/);
    expect(budget).toMatch(/LifetimeReason\s*=\s*"lifetime"/);
  });

  it("announces the planned rotation before serving the over-cap request", async () => {
    const program = await nativeSource("Program.cs");
    const protocol = await nativeSource("ProtocolJson.cs");
    expect(protocol).toContain("WriteRotating");
    expect(protocol).toContain('Value("rotating")');
    // The in-band line must be written before the request is executed, which is
    // what lets the client re-issue it exactly once without losing it.
    const beginIndex = program.indexOf("budget.TryBeginRequest");
    const rotatingIndex = program.indexOf("ProtocolJson.WriteRotating");
    const captureIndex = program.indexOf("CaptureCommand.Execute");
    const inspectIndex = program.indexOf("InspectCommand.Execute");
    expect(beginIndex).toBeGreaterThan(0);
    expect(rotatingIndex).toBeGreaterThan(beginIndex);
    expect(rotatingIndex).toBeLessThan(captureIndex);
    expect(rotatingIndex).toBeLessThan(inspectIndex);
    expect(program).toMatch(/ProtocolJson\.WriteRotating[\s\S]{0,200}return ExitClean/);
    // An idle host still respects the wall-clock lifetime.
    expect(program).toContain("StartLifetimeWatchdog");
    expect(program).toMatch(/Environment\.Exit\(ExitClean\)/);
    expect(program).toContain("TryClaimIdleRotation");
  });

  it("keeps rotation out-of-band from the protocol-violation exit path", async () => {
    const program = await nativeSource("Program.cs");
    expect(program).toMatch(/WriteRotating[\s\S]{0,200}stdout\.Flush\(\);\s*return ExitClean/);
    // Rotation must not be reported as a protocol violation or a crash code.
    expect(program).toMatch(/ExitProtocolViolations\s*=\s*3/);
    expect(program).toMatch(/ExitMalformedJson\s*=\s*4/);
  });
});

describe("documented residual risk", () => {
  it("records why AppContainer/low-integrity containment is not applied and names the residual risk", async () => {
    const report = await readFile(REPORT_PATH, "utf8");
    expect(report).toContain("Residual risk");
    expect(report).toContain("AppContainer");
    expect(report).toMatch(/low[- ]integrity/i);
    expect(report).toContain("SeChangeNotifyPrivilege");
    expect(report).toContain("request-cap");
  });
});
