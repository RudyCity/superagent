import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import {
  windowsHeadlessOptions,
  applyProcessIntent,
  redactSensitiveProcessText,
  sanitizeArgvForTrace,
  recordProcessLaunchTrace,
  traceChildProcess,
  setProcessTraceEnabledForTest,
  getProcessTraceEvents,
  clearProcessTraceEvents,
  resolveWindowsDirectExecutable,
  inspectAgyWindowsEnvironment,
} from "../src/core/process/processSpawnPolicy.js";

describe("processSpawnPolicy — Centralized Windows Subprocess Intent & Tracing", () => {
  beforeEach(() => {
    clearProcessTraceEvents();
    setProcessTraceEnabledForTest(null);
  });

  afterEach(() => {
    clearProcessTraceEvents();
    setProcessTraceEnabledForTest(null);
  });

  it("windowsHeadlessOptions returns { windowsHide: true }", () => {
    expect(windowsHeadlessOptions()).toEqual({ windowsHide: true });
  });

  it("applyProcessIntent('headless') sets windowsHide: true and preserves caller options without mutating input", () => {
    const controller = new AbortController();
    const original = {
      cwd: "C:\\workspace",
      all: true,
      buffer: false,
      reject: false,
      timeout: 15_000,
      forceKillAfterDelay: 5_000,
      detached: false,
      shell: "powershell.exe",
      cancelSignal: controller.signal,
    };
    const merged = applyProcessIntent(original, "headless");

    expect(merged.windowsHide).toBe(true);
    expect(merged.cwd).toBe("C:\\workspace");
    expect(merged.all).toBe(true);
    expect(merged.buffer).toBe(false);
    expect(merged.reject).toBe(false);
    expect(merged.timeout).toBe(15_000);
    expect(merged.forceKillAfterDelay).toBe(5_000);
    expect(merged.detached).toBe(false);
    expect(merged.shell).toBe("powershell.exe");
    expect(merged.cancelSignal).toBe(controller.signal);
    expect("windowsHide" in original).toBe(false);
  });

  it("applyProcessIntent('capturedInteractive') sets windowsHide: true and preserves stdio pipes", () => {
    const merged = applyProcessIntent(
      {
        cwd: "/tmp/session",
        stdin: "pipe" as const,
        stdout: "pipe" as const,
        stderr: "pipe" as const,
        reject: false,
      },
      "capturedInteractive"
    );

    expect(merged.windowsHide).toBe(true);
    expect(merged.stdin).toBe("pipe");
    expect(merged.stdout).toBe("pipe");
    expect(merged.stderr).toBe("pipe");
    expect(merged.reject).toBe(false);
  });

  it("applyProcessIntent('visibleTerminal') explicitly sets windowsHide: false", () => {
    const merged = applyProcessIntent(
      {
        detached: true,
        stdio: "ignore" as const,
        windowsVerbatimArguments: true,
        windowsHide: true,
      },
      "visibleTerminal"
    );

    expect(merged.windowsHide).toBe(false);
    expect(merged.detached).toBe(true);
    expect(merged.stdio).toBe("ignore");
    expect(merged.windowsVerbatimArguments).toBe(true);
  });

  it("redacts API keys, bearer tokens, env secrets, and truncates long text in redactSensitiveProcessText", () => {
    const raw =
      'OPENAI_API_KEY=sk-proj-1234567890abcdefghijklmnop Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc1234567890 token="ghp_abcdefghijklmnopqrstuvwxyz123456"';
    const redacted = redactSensitiveProcessText(raw, 500);

    expect(redacted).not.toContain("sk-proj-1234567890");
    expect(redacted).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
    expect(redacted).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz123456");
    expect(redacted).toContain("[REDACTED]");
  });

  it("redacts prompt arguments (-p, --prompt) and PowerShell -EncodedCommand payloads in sanitizeArgvForTrace", () => {
    const argv = [
      "--dangerously-skip-permissions",
      "--add-dir",
      "d:\\workspace",
      "-p",
      "Sensitive user prompt containing secret architectural details and instructions",
      "-EncodedCommand",
      "UwB0AGEAcgB0AC0AUwBsAGUAZQBwACAALQBTAGUAYwBvAG4AZABzACAAMQAwAA==",
    ];
    const sanitized = sanitizeArgvForTrace(argv);

    expect(sanitized).toEqual([
      "--dangerously-skip-permissions",
      "--add-dir",
      "d:\\workspace",
      "-p",
      "[REDACTED_PROMPT len=78]",
      "-EncodedCommand",
      "[REDACTED_ENCODED len=64]",
    ]);
  });

  it("records spawn and exit trace events only when tracing is enabled", () => {
    const fakeChild = Object.assign(new EventEmitter(), { pid: 42424 });

    // Disabled by default
    traceChildProcess(fakeChild, {
      caller: "unitTest.disabled",
      executable: "git",
      args: ["status"],
      intent: "headless",
      options: { windowsHide: true },
    });
    expect(getProcessTraceEvents()).toHaveLength(0);

    // Enabled for test
    setProcessTraceEnabledForTest(true);
    traceChildProcess(fakeChild, {
      caller: "unitTest.enabled",
      executable: "agy.exe",
      args: ["-p", "My secret prompt", "--output-format", "stream-json"],
      cwd: "C:\\project",
      intent: "headless",
      options: { windowsHide: true, shell: false, detached: false },
    });

    const afterSpawn = getProcessTraceEvents();
    expect(afterSpawn).toHaveLength(1);
    expect(afterSpawn[0]).toMatchObject({
      phase: "spawn",
      childPid: 42424,
      executable: "agy.exe",
      argvSummary: ["-p", "[REDACTED_PROMPT len=16]", "--output-format", "stream-json"],
      intent: "headless",
      caller: "unitTest.enabled",
      cwd: "C:\\project",
      shell: false,
      detached: false,
      windowsHide: true,
    });

    fakeChild.emit("exit", 0, null);
    const afterExit = getProcessTraceEvents();
    expect(afterExit).toHaveLength(2);
    expect(afterExit[1]).toMatchObject({
      phase: "exit",
      childPid: 42424,
      exitCode: 0,
      signal: null,
      windowsHide: true,
    });
    expect(typeof afterExit[1].durationMs).toBe("number");
  });

  it("resolves agy/agy.cmd to native agy.exe on Windows when installed and leaves non-agy binaries unchanged", () => {
    expect(resolveWindowsDirectExecutable("node")).toBe("node");
    expect(resolveWindowsDirectExecutable("git")).toBe("git");

    if (process.platform === "win32") {
      const report = inspectAgyWindowsEnvironment();
      if (report.agyBinaryPath) {
        expect(resolveWindowsDirectExecutable("agy")).toBe(report.agyBinaryPath);
        expect(resolveWindowsDirectExecutable("agy.cmd")).toBe(report.agyBinaryPath);
        expect(resolveWindowsDirectExecutable("agy.bat")).toBe(report.agyBinaryPath);
        expect(report.agyBinaryIsNativeExe).toBe(true);
      }
    }
  });
});
