import { describe, expect, it } from "vitest";
import {
  getTrustedCliBridgeAgent,
  runWithTrustedCliBridgeAgent,
} from "../src/core/tools/cliBridgeAgentOwner.js";

const ownerA = "mcp:" + "a".repeat(64);
const ownerB = "mcp:" + "b".repeat(64);

describe("MCP CLI Bridge per-agent concurrency boundary", () => {
  it("isolates overlapping authenticated agent execution contexts", async () => {
    const observed: string[] = [];
    const tasks = [
      runWithTrustedCliBridgeAgent(ownerA, async () => {
        observed.push(getTrustedCliBridgeAgent()!);
        await Promise.resolve();
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(getTrustedCliBridgeAgent()).toBe(ownerA);
        return "agent-a";
      }),
      runWithTrustedCliBridgeAgent(ownerB, async () => {
        observed.push(getTrustedCliBridgeAgent()!);
        await Promise.resolve();
        expect(getTrustedCliBridgeAgent()).toBe(ownerB);
        return "agent-b";
      }),
    ];
    expect(await Promise.all(tasks)).toEqual(["agent-a", "agent-b"]);
    expect(observed).toEqual([ownerA, ownerB]);
    expect(getTrustedCliBridgeAgent()).toBeNull();
  });

  it("rejects spoofed labels or tool arguments as trusted owner identities", () => {
    expect(() => runWithTrustedCliBridgeAgent("agent-Rudy", () => 1)).toThrow(
      "Invalid trusted MCP owner admission context",
    );
    expect(() => runWithTrustedCliBridgeAgent("mcp:" + "x".repeat(64), () => 1))
      .toThrow("Invalid trusted MCP owner admission context");
    expect(getTrustedCliBridgeAgent()).toBeNull();
  });

  it("returns the context value independently inside nested scoped work", () => {
    const result = runWithTrustedCliBridgeAgent(ownerA, () => {
      const nested = runWithTrustedCliBridgeAgent(ownerB, () => getTrustedCliBridgeAgent());
      return { outer: getTrustedCliBridgeAgent(), nested };
    });
    expect(result).toEqual({ outer: ownerA, nested: ownerB });
  });
});
