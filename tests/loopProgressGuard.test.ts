import { describe, expect, it } from "vitest";
import { LoopProgressGuard } from "../src/core/agent/LoopProgressGuard.js";

function step(name = "read", args: Record<string, unknown> = { path: "README.md" }, result = "unchanged") {
  return {
    calls: [{ id: "call-1", name, args }],
    results: [{ toolCallId: "call-1", name, result }],
  };
}

describe("LoopProgressGuard", () => {
  it("stops repeated identical tool calls regardless of advisor settings", () => {
    const guard = new LoopProgressGuard();
    const same = step();
    for (let i = 1; i < 6; i++) {
      expect(guard.recordToolStep(same.calls, same.results).action).toBe("continue");
    }
    expect(guard.recordToolStep(same.calls, same.results)).toEqual({
      action: "stop", reason: "identical_tools", repeated: 6, backoffMs: 0,
    });
  });

  it("does not stop when identical call arguments return changing results", () => {
    const guard = new LoopProgressGuard();
    for (let i = 0; i < 30; i++) {
      const { calls, results } = step("run_command", { command: "git status" }, "progress:" + i);
      expect(guard.recordToolStep(calls, results).action).toBe("continue");
    }
  });

  it("uses the whole result instead of mistaking equal output prefixes for stagnation", () => {
    const guard = new LoopProgressGuard();
    const prefix = "same-prefix".repeat(100);
    for (let i = 0; i < 25; i++) {
      const { calls, results } = step("read", { path: "test.json" }, prefix + String(i));
      expect(guard.recordToolStep(calls, results).action).toBe("continue");
    }
  });

  it("gives unchanged status polling a bounded backoff before stopping", () => {
    const guard = new LoopProgressGuard();
    const same = step("motion_status", { jobId: "pending" }, "rendering");
    for (let i = 1; i < 10; i++) {
      const decision = guard.recordToolStep(same.calls, same.results);
      expect(decision.action).toBe("continue");
      if (i === 3) expect(decision.backoffMs).toBe(500);
      if (i === 4) expect(decision.backoffMs).toBe(1000);
      if (i === 9) expect(decision.backoffMs).toBe(4000);
    }
    expect(guard.recordToolStep(same.calls, same.results)).toMatchObject({
      action: "stop", reason: "identical_tools", repeated: 10,
    });
  });

  it("detects repeated alternating A/B calls with identical output", () => {
    const guard = new LoopProgressGuard();
    for (let i = 0; i < 7; i++) {
      const { calls, results } = step(i % 2 === 0 ? "read" : "describe_tool");
      expect(guard.recordToolStep(calls, results).action).toBe("continue");
    }
    const last = step("describe_tool");
    expect(guard.recordToolStep(last.calls, last.results)).toMatchObject({
      action: "stop", reason: "alternating_tools",
    });
  });

  it("resets its loop budget when a new user turn begins", () => {
    const guard = new LoopProgressGuard();
    const same = step();
    for (let i = 0; i < 5; i++) guard.recordToolStep(same.calls, same.results);
    guard.reset();
    expect(guard.recordToolStep(same.calls, same.results)).toEqual({
      action: "continue", repeated: 1, backoffMs: 0,
    });
  });

  it("does not conflate equal-length edits with identical argument prefixes", () => {
    const guard = new LoopProgressGuard();
    const prefix = "const same = true;".repeat(25);
    for (let i = 0; i < 15; i++) {
      const { calls, results } = step("write_to_file", {
        path: "src/file.ts",
        content: prefix + String(i).padStart(3, "0"),
      }, "file written");
      expect(guard.recordToolStep(calls, results).action).toBe("continue");
    }
  });

  it("does not repeatedly back off on a failed status check", () => {
    const guard = new LoopProgressGuard();
    const { calls } = step("motion_status", { jobId: "bad" }, "error");
    const results = [{ toolCallId: "call-1", name: "motion_status", result: "error", isError: true }];
    for (let i = 1; i < 6; i++) {
      expect(guard.recordToolStep(calls, results)).toEqual({
        action: "continue", repeated: i, backoffMs: 0,
      });
    }
    expect(guard.recordToolStep(calls, results)).toMatchObject({
      action: "stop", repeated: 6,
    });
  });

  it("ignores empty tool batches without polluting the streak", () => {
    const guard = new LoopProgressGuard();
    expect(guard.recordToolStep([], [])).toEqual({
      action: "continue", repeated: 0, backoffMs: 0,
    });
  });
});
