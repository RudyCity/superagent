import { describe, expect, it } from "vitest";
import { validateCoreCheckpoint, type CoreSupervisorCheckpoint } from "../src/core/runtime/coreSupervisorCheckpoint.js";

function valid(): CoreSupervisorCheckpoint {
  return {
    version: 1, port: 7888, savedAt: 100, clientMode: "tline",
    serverToken: "a".repeat(48), inspectToken: "b".repeat(64), activePid: 20,
    workers: [
      { pid: 10, port: 13000, since: 1, generationId: "c".repeat(32), drainEligible: false },
      { pid: 20, port: 13001, since: 2, generationId: "d".repeat(32), drainEligible: true },
    ],
    sessions: [{ sessionId: "session_1", owner: { pid: 10, port: 13000, since: 1 } }],
  };
}
describe("supervisor checkpoint validation", () => {
  it("accepts metadata with original session owners", () => {
    expect(validateCoreCheckpoint(valid(), 7888).sessions[0].owner.pid).toBe(10);
  });
  it("rejects unauthenticated or mismatched recovery inputs", () => {
    expect(() => validateCoreCheckpoint(valid(), 7788)).toThrow();
    expect(() => validateCoreCheckpoint({ ...valid(), serverToken: "bad" }, 7888)).toThrow();
    expect(() => validateCoreCheckpoint({ ...valid(), activePid: 999 }, 7888)).toThrow();
    expect(() => validateCoreCheckpoint({ ...valid(), workers: [valid().workers[0], valid().workers[0]] }, 7888)).toThrow();
  });
  it("rejects unknown or invalid session owners", () => {
    expect(() => validateCoreCheckpoint({ ...valid(), sessions: [
      { sessionId: "session_1", owner: { pid: 999, port: 13000, since: 1 } },
    ] }, 7888)).toThrow();
    expect(() => validateCoreCheckpoint({ ...valid(), sessions: [
      { sessionId: "\nmalicious", owner: { pid: 10, port: 13000, since: 1 } },
    ] }, 7888)).toThrow();
  });
});
