import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CORE_SUPERVISOR_LONG_RUNNING_ACTIONS,
  applyCoreRuntimeLogEcho,
  coreSupervisorTerminalEchoReason,
  handleCoreCliCommand,
} from "../src/core/runtime/coreSupervisor.js";
import { runtimeLogEchoState, setRuntimeLogTerminalEcho } from "../src/core/utils/runtimeLog.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const supervisorSource = readFileSync(
  path.join(repoRoot, "src", "core", "runtime", "coreSupervisor.ts"), "utf8",
);
const bootSource = readFileSync(
  path.join(repoRoot, "src", "core", "runtime", "coreBoot.ts"), "utf8",
);

beforeEach(() => {
  setRuntimeLogTerminalEcho(true, "test baseline");
});

afterEach(() => {
  setRuntimeLogTerminalEcho(true);
});

describe("Core supervisor terminal echo decision", () => {
  it("echoes only for an operator TTY on the long-lived actions", () => {
    for (const action of CORE_SUPERVISOR_LONG_RUNNING_ACTIONS) {
      expect(applyCoreRuntimeLogEcho(action, true)).toBe(true);
      expect(runtimeLogEchoState()).toMatchObject({
        hostEnabled: true,
        hostReason: "core supervisor terminal",
      });

      setRuntimeLogTerminalEcho(true, "test baseline");
      expect(applyCoreRuntimeLogEcho(action, false)).toBe(true);
      expect(runtimeLogEchoState()).toMatchObject({
        hostEnabled: false,
        hostReason: "core supervisor piped stdio",
      });
      setRuntimeLogTerminalEcho(true, "test baseline");
    }
  });

  it("keeps the reason strings the runtime log records for incident review", () => {
    expect(coreSupervisorTerminalEchoReason(true)).toBe("core supervisor terminal");
    expect(coreSupervisorTerminalEchoReason(false)).toBe("core supervisor piped stdio");
  });

  it("never changes the echo policy for read-only report subcommands", () => {
    const reportActions = [
      "status", "restart", "rollback", "drain",
      "lifecycle-plan", "boot-audit", "ownership-audit", "help",
    ];
    for (const action of reportActions) {
      expect(applyCoreRuntimeLogEcho(action, true)).toBe(false);
      expect(applyCoreRuntimeLogEcho(action, false)).toBe(false);
      expect(runtimeLogEchoState()).toMatchObject({
        hostEnabled: true,
        hostReason: "test baseline",
      });
    }
  });

  it("applies the TTY decision inside the CLI dispatch without spawning a supervisor", async () => {
    // An invalid port is rejected before any socket or child process exists, so
    // this exercises the real wiring without a live Core.
    await expect(handleCoreCliCommand(["start", "--port", "0"])).rejects.toThrow("Invalid --port");
    expect(runtimeLogEchoState()).toMatchObject({
      hostEnabled: Boolean(process.stdout.isTTY),
      hostReason: coreSupervisorTerminalEchoReason(Boolean(process.stdout.isTTY)),
    });
  });

  it("leaves the echo policy untouched for the status command", async () => {
    await expect(handleCoreCliCommand(["status", "--port", "0"])).rejects.toThrow("Invalid --port");
    expect(runtimeLogEchoState()).toMatchObject({
      hostEnabled: true,
      hostReason: "test baseline",
    });
  });
});

describe("Core CLI runtime-log wiring guards", () => {
  it("applies the host echo decision exactly once", () => {
    expect(supervisorSource).toContain(
      "applyCoreRuntimeLogEcho(action, Boolean(process.stdout.isTTY));",
    );
    expect(supervisorSource.match(/setRuntimeLogTerminalEcho\(/g) ?? []).toHaveLength(1);
    expect(supervisorSource).toContain(
      "setRuntimeLogTerminalEcho(hasTty, coreSupervisorTerminalEchoReason(hasTty));",
    );
    expect(supervisorSource).toContain(
      'import { serverRuntimeLog, setRuntimeLogTerminalEcho } from "../utils/runtimeLog.js";',
    );
  });

  it("routes supervisor runtime lines through the Tray-readable logger", () => {
    const coveredLines = [
      'serverRuntimeLog("error", "[core] Failed to persist session affinity checkpoint")',
      'serverRuntimeLog("info", "Core supervisor listening on http://127.0.0.1:" + port)',
      'serverRuntimeLog("info", "Worker PID " + active!.pid',
      'serverRuntimeLog("info", "Authenticated supervisor recovery completed; old sessions kept on original workers.")',
      'serverRuntimeLog("info", "MCP, Muse and Telegram processes are not controlled by this supervisor.")',
      'serverRuntimeLog("info", "Core guardian: NOT REGISTERED. No automatic Core supervisor recovery.")',
      'serverRuntimeLog("info", "Core guardian registration: "',
      'serverRuntimeLog("info", "Core guardian stopped: "',
      'serverRuntimeLog("info", formatCoreSupervisorStatus(',
    ];
    for (const line of coveredLines) expect(supervisorSource).toContain(line);

    expect(supervisorSource).not.toContain('console.log("Core supervisor listening on');
    expect(supervisorSource).not.toContain('console.error("[core] Failed to persist');
    expect(supervisorSource).not.toContain('console.log("Core guardian');
    expect(supervisorSource).not.toContain("console.log(formatCoreSupervisorStatus(");
  });

  it("keeps the usage/help text terminal-only by design", () => {
    expect(supervisorSource).toContain(
      'console.log("superagent core start [--port 7888] [--client-mode tline|chrome-extension]");',
    );
    expect(supervisorSource).toContain(
      'console.log("Requires opt-in supervisor startup; existing unsupervised processes are never replaced.");',
    );
    expect(supervisorSource).not.toContain('serverRuntimeLog("info", "superagent core start');
  });

  it("routes every Core boot decision through the Tray-readable logger", () => {
    expect(bootSource).toContain('import { serverRuntimeLog } from "../utils/runtimeLog.js";');
    expect(bootSource.match(/serverRuntimeLog\("info", "Core boot:/g) ?? []).toHaveLength(3);
    expect(bootSource).not.toContain('console.log("Core boot:');
  });
});
