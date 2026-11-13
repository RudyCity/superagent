import { describe, expect, it } from "vitest";
import path from "node:path";
import {
  externalControlEligibility, observeExternalProcess, configureExternalStart,
  buildVerifiedExternalStopScript, prepareExternalStop, stopExternalProcess,
  startStoppedExternal, getStoppedExternalProcesses, PROTECTED_EXTERNAL_PORTS,
} from "../src/core/runtime/externalTerminalControl.js";
import { parseExternalProcessSnapshot } from "../src/core/runtime/externalTerminalProcesses.js";

const isWindows = process.platform === "win32";
const birth = "win:638980000000000000";

describe("External desktop terminal lifecycle guard", () => {
  it("parses birth identity but never saves command line or token secrets", () => {
    const [entry] = parseExternalProcessSnapshot([{
      ProcessId: 31777, Name: "python.exe", Ports: [8095],
      CreationTicks: "638980000000000000",
      CommandLine: "python server.py --token top-secret",
    }]);
    expect(entry).toEqual({
      pid: 31777, name: "python.exe", ports: [8095],
      creationIdentity: birth,
    });
    expect(JSON.stringify(entry)).not.toContain("top-secret");
  });

  it("denies all protected service ports and missing creation identities", () => {
    expect(PROTECTED_EXTERNAL_PORTS.has(7888)).toBe(true);
    expect(PROTECTED_EXTERNAL_PORTS.has(17341)).toBe(true);
    expect(externalControlEligibility({
      pid: 31777, name: "python.exe", ports: [8095],
    }).allowed).toBe(false);
    expect(externalControlEligibility({
      pid: 31777, name: "bun.exe", ports: [7888],
      creationIdentity: birth,
    }).allowed).toBe(false);
    expect(externalControlEligibility({
      pid: process.pid, name: "node.exe", ports: [8095],
      creationIdentity: birth,
    }).allowed).toBe(false);
    expect(externalControlEligibility({
      pid: 31777, name: "python.exe", ports: [8095],
      creationIdentity: birth,
    }).allowed).toBe(isWindows);
  });

  it("requires a birth-verified, explicitly configured launch specification", async () => {
    const id = "external-win-31777";
    const observed = observeExternalProcess({
      pid: 31777, name: "python.exe", ports: [8095],
      creationIdentity: birth,
    });
    if (!isWindows) {
      expect(observed.canStop).toBe(false);
      return;
    }
    expect(observed.canStop).toBe(true);
    expect(observed.canConfigureStart).toBe(true);
    expect(() => configureExternalStart(id, "", process.cwd())).toThrow();
    expect(() => configureExternalStart(id, "python app.py", "relative")).toThrow();
    const configured = configureExternalStart(id, "python app.py", path.resolve("."));
    expect(configured.success).toBe(true);
    expect(configured.canStart).toBe(false); // never start a duplicate live process
    expect(getStoppedExternalProcesses().some((x) => x.id === id)).toBe(false);
    await expect(startStoppedExternal(id, () => ({}))).rejects.toThrow(/Stop/);
    // A client cannot force termination with a guessed/missing one-time operation.
    await expect(stopExternalProcess(id, "unknown")).rejects.toThrow(/authorization expired/);
    // Fresh OS identity is required; fake test PID cannot issue a valid stop plan.
    await expect(prepareExternalStop(id)).rejects.toThrow();
  });

  it("builds an in-command birth/port verification before a single-PID Stop-Process", () => {
    const script = buildVerifiedExternalStopScript({
      pid: 31777, identity: birth, name: "python.exe",
    });
    expect(script).toContain("$pidToStop=31777");
    expect(script).toContain("CreationDate.ToUniversalTime().Ticks");
    expect(script).toContain("Get-NetTCPConnection");
    expect(script).toContain("Stop-Process -Id $pidToStop -Force");
    expect(script).not.toContain("taskkill");
    expect(script.indexOf("Get-NetTCPConnection")).toBeLessThan(script.indexOf("Stop-Process"));
    expect(() => buildVerifiedExternalStopScript({
      pid: 31777, identity: "win:wrong", name: "python.exe",
    })).toThrow(/Invalid/);
  });
});
