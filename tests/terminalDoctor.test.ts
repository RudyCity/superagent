import { describe, expect, it } from "vitest";
import {
  formatTerminalDiagnostics,
  formatTerminalDiagnosticsFromDisk,
  parseLastMountRecord,
} from "../src/core/commands/terminalDoctorView.js";
import type { RuntimeLogEchoState } from "../src/core/utils/runtimeLog.js";

const ttyStdin = { isTTY: true, isPaused: () => false, setRawMode: () => undefined };
const ttyStdout = { isTTY: true };

function echoState(overrides: Partial<RuntimeLogEchoState> = {}): RuntimeLogEchoState {
  return {
    enabled: false,
    source: "host",
    hostEnabled: false,
    hostReason: "embedded host (CLI/Tray-owned/tunnel server)",
    ...overrides,
  };
}

function logWith(...records: object[]): string {
  return records
    .map((record, index) => `[2026-11-28T04:48:3${index}.000Z] [CLI] App component mounted | ${JSON.stringify(record)}`)
    .join("\n");
}

describe("terminal doctor mount record parsing", () => {
  it("returns the newest mount record", () => {
    const log = logWith(
      { stdinWasPaused: true, stdinResumed: true },
      { stdinWasPaused: false, stdinResumed: true }
    );

    expect(parseLastMountRecord(log)).toMatchObject({ stdinWasPaused: false, stdinResumed: true });
  });

  it("ignores missing, malformed or unrelated log text", () => {
    expect(parseLastMountRecord("")).toBeUndefined();
    expect(parseLastMountRecord("App component mounted | {oops")).toBeUndefined();
    expect(parseLastMountRecord("[CLI] App component unmounting")).toBeUndefined();
  });
});

describe("terminal doctor report", () => {
  it("reports a healthy transport with the mount snapshot", () => {
    const report = formatTerminalDiagnostics({
      stdin: ttyStdin,
      stdout: ttyStdout,
      logText: logWith({ stdinWasPaused: true, stdinResumed: true }),
    });

    expect(report).toContain("SUPERAGENT TERMINAL DIAGNOSTICS");
    expect(report).toContain("stdin paused now     : no");
    expect(report).toContain("last mount stdin     : paused=yes resumed=yes");
    expect(report).toMatch(/ {2}runtime log echo {5}: (on|off) \(host: (on|off) - /);
    expect(report).not.toContain("Runtime log note:");
    expect(report).toContain("Verdict: interactive input transport looks healthy.");
  });

  it("reports the injected echo policy instead of the global state", () => {
    const off = formatTerminalDiagnostics({
      stdin: ttyStdin,
      stdout: ttyStdout,
      echoState: echoState(),
    });
    const on = formatTerminalDiagnostics({
      stdin: ttyStdin,
      stdout: ttyStdout,
      echoState: echoState({ enabled: true, hostEnabled: true, hostReason: "foreground server" }),
    });

    expect(off).toContain(
      "  runtime log echo     : off (host: off - embedded host (CLI/Tray-owned/tunnel server); source: host; env: unset)"
    );
    expect(on).toContain("  runtime log echo     : on (host: on - foreground server; source: host; env: unset)");
    expect(off).not.toContain("Runtime log note:");
    expect(on).not.toContain("Runtime log note:");
  });

  it("explains an environment override that forces echo onto the terminal", () => {
    const report = formatTerminalDiagnostics({
      stdin: ttyStdin,
      stdout: ttyStdout,
      echoState: echoState({ enabled: true, source: "env", envValue: "1" }),
    });

    expect(report).toContain('source: env; env: "1"');
    expect(report).toContain(
      "Runtime log note: SUPERAGENT_RUNTIME_LOG_ECHO forces runtime logs onto this terminal."
    );
    // The env note is appended after the single verdict line, which stays as-is.
    expect(report).toContain("Verdict: interactive input transport looks healthy.");
    expect(report.trimEnd().split("\n").at(-1)).toBe(
      "Runtime log note: SUPERAGENT_RUNTIME_LOG_ECHO forces runtime logs onto this terminal."
    );
  });

  it("flags a non-TTY stdin as unable to receive keys", () => {
    const report = formatTerminalDiagnostics({ stdin: { isTTY: false }, stdout: {} });
    expect(report).toContain("Verdict: stdin is not a TTY");
  });

  it("flags a terminal without raw mode support", () => {
    const report = formatTerminalDiagnostics({ stdin: { isTTY: true }, stdout: ttyStdout });
    expect(report).toContain("Verdict: raw mode is unavailable");
  });

  it("flags a stream that is paused right now", () => {
    const report = formatTerminalDiagnostics({
      stdin: { ...ttyStdin, isPaused: () => true },
      stdout: ttyStdout,
    });
    expect(report).toContain("stdin paused now     : yes");
    expect(report).toContain("Verdict: stdin is paused right now.");
  });

  it("flags a legacy mount that saw a paused stdin and never resumed it", () => {
    const report = formatTerminalDiagnostics({
      stdin: ttyStdin,
      stdout: ttyStdout,
      logText: logWith({ stdinWasPaused: true }),
    });
    expect(report).toContain("Verdict: the last mount saw a paused stdin and did not resume it.");
  });

  it("says so when the log has no mount record", () => {
    const report = formatTerminalDiagnostics({ stdin: ttyStdin, stdout: ttyStdout, logText: "" });
    expect(report).toContain("last mount stdin     : no mount record in log");
  });

  it("reads the on-disk report without throwing when no log exists", () => {
    expect(formatTerminalDiagnosticsFromDisk()).toContain("SUPERAGENT TERMINAL DIAGNOSTICS");
  });
});
