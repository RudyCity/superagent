import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRuntimeLogger,
  formatRuntimeLogArgs,
  isRuntimeLogTerminalEchoEnabled,
  setRuntimeLogTerminalEcho,
} from "../src/core/utils/runtimeLog.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function createLogger() {
  const append = vi.fn();
  const echo = vi.fn();
  return { logger: createRuntimeLogger({ append, echo }), append, echo };
}

afterEach(() => {
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
});

describe("server wiring guards", () => {
  const serverSource = readFileSync(path.join(repoRoot, "src", "server.ts"), "utf8");

  it("derives terminal echo from the silent host flag in runServer", () => {
    expect(serverSource).toMatch(/setRuntimeLogTerminalEcho\(!silent\)/);
  });

  it("routes runtime chatter through the policy logger instead of console", () => {
    expect(serverSource).toContain('serverRuntimeLog("warn", "[chat] event journal unavailable');
    expect(serverSource).toContain('serverRuntimeLog("warn", "[chat] turn recovery unavailable:"');
    expect(serverSource).not.toContain('console.warn("[chat] event journal unavailable');
    expect(serverSource).not.toContain('console.error("[SERVER ERROR]", err)');
  });
});
