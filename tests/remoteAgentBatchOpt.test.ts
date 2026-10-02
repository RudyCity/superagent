import { describe, it, expect } from "vitest";
import {
  computeExecutionWaves,
  executeBatch,
} from "../src/core/remoteAgent/batchExecutor.js";
import type { BatchToolCall } from "../src/core/remoteAgent/protocol.js";

const mk = (
  id: string,
  tool = "read",
  extra: Partial<BatchToolCall> = {}
): BatchToolCall => ({ id, tool, args: {}, ...extra });

describe("computeExecutionWaves", () => {
  it("puts independent calls in a single wave, preserving order", () => {
    const { waves, errors } = computeExecutionWaves([
      mk("a"),
      mk("b"),
      mk("c"),
    ]);
    expect(errors.size).toBe(0);
    expect(waves).toEqual([["a", "b", "c"]]);
  });

  it("orders dependent calls into topological waves", () => {
    const { waves, errors } = computeExecutionWaves([
      mk("c", "read", { depends_on: ["a", "b"] }),
      mk("a"),
      mk("b"),
      mk("d", "read", { depends_on: ["c"] }),
    ]);
    expect(errors.size).toBe(0);
    expect(waves).toEqual([["a", "b"], ["c"], ["d"]]);
  });

  it("reports unknown dependencies as errors", () => {
    const { waves, errors } = computeExecutionWaves([
      mk("a", "read", { depends_on: ["nope"] }),
      mk("b"),
    ]);
    expect(errors.get("a")).toMatch(/Unknown dependency/);
    expect(waves).toEqual([["b"]]);
  });

  it("reports circular dependencies as errors", () => {
    const { waves, errors } = computeExecutionWaves([
      mk("a", "read", { depends_on: ["b"] }),
      mk("b", "read", { depends_on: ["a"] }),
      mk("c"),
    ]);
    expect(errors.get("a")).toMatch(/Circular/);
    expect(errors.get("b")).toMatch(/Circular/);
    expect(waves).toEqual([["c"]]);
  });
});

describe("executeBatch", () => {
  it("runs independent read-only calls and preserves call order", async () => {
    const results = await executeBatch(
      [
        { id: "r1", tool: "run_command", args: { command: "echo one" } },
        { id: "r2", tool: "run_command", args: { command: "echo two" } },
      ],
      { workspace: process.cwd() }
    );
    expect(results.map((r) => r.id)).toEqual(["r1", "r2"]);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it("aborts a hanging call after timeout_ms", async () => {
    const sleepCmd =
      process.platform === "win32"
        ? "powershell -NoProfile -Command Start-Sleep -Seconds 10"
        : "sleep 10";
    const results = await executeBatch(
      [{ id: "s1", tool: "run_command", args: { command: sleepCmd }, timeout_ms: 800 }],
      { workspace: process.cwd() }
    );
    expect(results[0].ok).toBe(false);
    expect(results[0].error).toMatch(/timed out after 800ms/);
  }, 15000);

  it("reports unknown tools without breaking the batch", async () => {
    const results = await executeBatch(
      [
        { id: "u1", tool: "no_such_tool_xyz" },
        { id: "r1", tool: "run_command", args: { command: "echo ok" } },
      ],
      { workspace: process.cwd() }
    );
    expect(results[0].ok).toBe(false);
    expect(results[0].error).toMatch(/Unknown tool/);
    expect(results[1].ok).toBe(true);
  });

  it("executes calls normally when timeout_ms is omitted (using default timeout)", async () => {
    const results = await executeBatch(
      [{ id: "def1", tool: "run_command", args: { command: "node -e 'console.log(999)'" } }],
      { workspace: process.cwd() }
    );
    expect(results[0].id).toBe("def1");
    expect(results[0].ok).toBe(true);
    expect(results[0].output).toContain("999");
  });
});
