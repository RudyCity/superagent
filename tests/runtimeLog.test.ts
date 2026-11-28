import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRuntimeLogger,
  describeRuntimeLogEcho,
  formatRuntimeLogArgs,
  isRuntimeLogTerminalEchoEnabled,
  parseRuntimeLogEchoOverride,
  runtimeLogEchoState,
  setRuntimeLogTerminalEcho,
  superAgentServerLogPath,
} from "../src/core/utils/runtimeLog.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function createLogger() {
  const append = vi.fn();
  const echo = vi.fn();
  return { logger: createRuntimeLogger({ append, echo }), append, echo };
}

afterEach(() => {
  vi.unstubAllEnvs();
  setRuntimeLogTerminalEcho(true);
});

describe("runtime log capture contract", () => {
  it("captures to the durable sink even when the terminal echo is off", () => {
    setRuntimeLogTerminalEcho(false);
    const { logger, append, echo } = createLogger();

    logger("info", "Core supervisor ready");

    expect(append).toHaveBeenCalledWith("[INFO] Core supervisor ready");
    expect(echo).not.toHaveBeenCalled();
  });

  it("echoes only while the host keeps terminal echo enabled", () => {
    const { logger, append, echo } = createLogger();

    setRuntimeLogTerminalEcho(true);
    logger("warn", "turn recovery unavailable");

    expect(echo).toHaveBeenCalledWith("warn", "turn recovery unavailable");
    expect(append).toHaveBeenCalledWith("[WARN] turn recovery unavailable");
  });

  it("keeps one appended line per call so the Tray log never duplicates", () => {
    setRuntimeLogTerminalEcho(true);
    const { logger, append } = createLogger();

    logger("error", "[Server Error]", "bind failed");
    logger("info", "ready");

    expect(append).toHaveBeenCalledTimes(2);
    expect(append.mock.calls[0][0]).toBe("[ERROR] [Server Error] bind failed");
  });

  it("formats objects as JSON and everything else as String, like the old console wrapper", () => {
    expect(formatRuntimeLogArgs(["plain", 42, { type: "status" }])).toBe('plain 42 {"type":"status"}');
    expect(formatRuntimeLogArgs([null, undefined, ["a"]])).toBe('null undefined ["a"]');
  });

  it("honours a per-logger echo override instead of the process policy", () => {
    setRuntimeLogTerminalEcho(true);
    const append = vi.fn();
    const echo = vi.fn();
    const logger = createRuntimeLogger({ append, echo, echoEnabled: () => false });

    logger("info", "embedded host");

    expect(echo).not.toHaveBeenCalled();
    expect(append).toHaveBeenCalledTimes(1);
  });

  it("defaults the process policy to echo enabled", () => {
    expect(isRuntimeLogTerminalEchoEnabled()).toBe(true);
    setRuntimeLogTerminalEcho(false);
    expect(isRuntimeLogTerminalEchoEnabled()).toBe(false);
  });

  it("points the durable sink at the Tray-readable server log", () => {
    expect(superAgentServerLogPath("/tmp/config")).toBe(
      path.join("/tmp/config", "superagent-server.log"),
    );
  });
});

describe("SUPERAGENT_RUNTIME_LOG_ECHO escape hatch", () => {
  it("accepts explicit on/off spellings and ignores anything else", () => {
    for (const raw of ["1", "true", "ON", " yes "]) {
      expect(parseRuntimeLogEchoOverride(raw)).toBe(true);
    }
    for (const raw of ["0", "false", "Off", " no "]) {
      expect(parseRuntimeLogEchoOverride(raw)).toBe(false);
    }
    for (const raw of [undefined, "", "  ", "maybe", "2"]) {
      expect(parseRuntimeLogEchoOverride(raw)).toBeUndefined();
    }
  });

  it("lets an operator force echo on for debugging even when the host said no", () => {
    setRuntimeLogTerminalEcho(false, "embedded host (CLI/Tray-owned/tunnel server)");
    vi.stubEnv("SUPERAGENT_RUNTIME_LOG_ECHO", "1");

    expect(isRuntimeLogTerminalEchoEnabled()).toBe(true);
    const state = runtimeLogEchoState();
    expect(state).toMatchObject({ enabled: true, source: "env", hostEnabled: false });
    expect(state.hostReason).toBe("embedded host (CLI/Tray-owned/tunnel server)");
  });

  it("lets an operator force echo off when the host wanted it on", () => {
    setRuntimeLogTerminalEcho(true, "foreground server");
    vi.stubEnv("SUPERAGENT_RUNTIME_LOG_ECHO", "0");

    expect(isRuntimeLogTerminalEchoEnabled()).toBe(false);
    expect(runtimeLogEchoState()).toMatchObject({ enabled: false, source: "env", hostEnabled: true });
  });

  it("falls back to the host decision for an unrecognised value", () => {
    setRuntimeLogTerminalEcho(false, "embedded host");
    vi.stubEnv("SUPERAGENT_RUNTIME_LOG_ECHO", "bogus");

    const state = runtimeLogEchoState();
    expect(state).toMatchObject({ enabled: false, source: "host", hostEnabled: false });
    expect(state.envValue).toBe("bogus");
  });

  it("describes the effective policy in one operator-readable line", () => {
    setRuntimeLogTerminalEcho(false, "embedded host (CLI/Tray-owned/tunnel server)");
    expect(describeRuntimeLogEcho()).toBe(
      'off (host: off - embedded host (CLI/Tray-owned/tunnel server); source: host; env: unset)',
    );

    vi.stubEnv("SUPERAGENT_RUNTIME_LOG_ECHO", "1");
    expect(describeRuntimeLogEcho()).toContain("on (host: off");
    expect(describeRuntimeLogEcho()).toContain('source: env; env: "1"');
  });
});

describe("server wiring guards", () => {
  const serverSource = readFileSync(path.join(repoRoot, "src", "server.ts"), "utf8");

  it("derives terminal echo from the silent host flag in runServer", () => {
    expect(serverSource).toMatch(/setRuntimeLogTerminalEcho\(\s*!silent,/);
  });

  it("routes runtime chatter through the policy logger instead of console", () => {
    expect(serverSource).toContain('serverRuntimeLog("warn", "[chat] event journal unavailable');
    expect(serverSource).toContain('serverRuntimeLog("warn", "[chat] turn recovery unavailable:"');
    expect(serverSource).not.toContain('console.warn("[chat] event journal unavailable');
    expect(serverSource).not.toContain('console.error("[SERVER ERROR]", err)');
  });

  it("keeps one durable sink definition for the Tray log", () => {
    expect(serverSource).not.toContain("function logToSuperAgentServerFile");
    expect(serverSource).toMatch(/export \{ logToSuperAgentServerFile/);
  });
});
