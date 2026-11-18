import { describe, expect, it } from "vitest";
import {
  LanTerminalTaskManager, LAN_TERMINAL_MAX_COMMAND, LAN_TERMINAL_MAX_INPUT,
} from "../src/core/lanRemote/terminalTasks.js";

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function untilFinished(manager: LanTerminalTaskManager, session: string, id: string) {
  let cursor = 0;
  const collected: string[] = [];
  for (let i = 0; i < 120; i++) {
    const result = manager.read(session, id, cursor);
    collected.push(...result.chunks.map(chunk => chunk.text));
    cursor = result.nextCursor;
    if (!result.running) return { result, output: collected.join("") };
    await pause(40);
  }
  throw Error("Test terminal did not complete.");
}

describe("attended LAN terminal task lifecycle", () => {
  it("delivers incremental output and exit status via a session-bound cursor", async () => {
    const manager = new LanTerminalTaskManager();
    const command = process.platform === "win32"
      ? "Write-Output LAN_TERMINAL_OK" : "printf LAN_TERMINAL_OK";
    const started = manager.start("approved-session", command);
    try {
      expect(started.jobId).toMatch(/^[a-f0-9-]{36}$/);
      const { result, output } = await untilFinished(manager, "approved-session", started.jobId);
      expect(output).toContain("LAN_TERMINAL_OK");
      expect(result.running).toBe(false);
      expect(result.exitCode).toBe(0);
      expect(result.reason).toBe("exited");
      expect(manager.read("approved-session", started.jobId, result.nextCursor).chunks).toEqual([]);
    } finally {
      manager.stopAll();
    }
  }, 12_000);

  it("rejects cross-session reads, input and stops; stops only owned child", () => {
    const manager = new LanTerminalTaskManager();
    const command = process.platform === "win32" ? "Start-Sleep -Seconds 20" : "sleep 20";
    const started = manager.start("first-session", command);
    try {
      expect(() => manager.read("second-session", started.jobId)).toThrow(/not found/);
      expect(() => manager.input("second-session", started.jobId, "hello")).toThrow(/not found/);
      expect(() => manager.stop("second-session", started.jobId)).toThrow(/not found/);
      expect(() => manager.start("first-session", command)).toThrow(/already running/);
      const wrote = manager.input("first-session", started.jobId, "hello", true);
      expect(wrote.running).toBe(true);
      const stopped = manager.stop("first-session", started.jobId);
      expect(stopped.running).toBe(false);
      expect(stopped.reason).toBe("stopped_by_owner");
      expect(() => manager.input("first-session", started.jobId, "hello")).toThrow(/not running/);
    } finally {
      manager.stopAll();
    }
  }, 10_000);

  it("bounds command and input, rejecting control bytes and extra sessions", () => {
    const manager = new LanTerminalTaskManager();
    expect(() => manager.start("approved", "")).toThrow();
    expect(() => manager.start("approved", "a".repeat(LAN_TERMINAL_MAX_COMMAND + 1))).toThrow();
    expect(() => manager.start("approved", "hello\u0000world")).toThrow();
    const command = process.platform === "win32" ? "Start-Sleep -Seconds 20" : "sleep 20";
    const task = manager.start("approved", command);
    try {
      for (const input of ["", "x".repeat(LAN_TERMINAL_MAX_INPUT + 1), "unsafe\u001b"]) {
        expect(() => manager.input("approved", task.jobId, input)).toThrow();
      }
      expect(() => manager.read("approved", task.jobId, -1)).toThrow(/cursor/);
      expect(() => manager.read("approved", task.jobId, Number.MAX_SAFE_INTEGER)).toThrow(/cursor/);
    } finally {
      manager.stopAll();
    }
  }, 10_000);
});
