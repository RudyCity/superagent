import { describe, expect, it } from "vitest";
import { collectSessionOwnedAgents } from "../src/core/utils/sessionAgentOwnership.js";

describe("per-session subagent ownership", () => {
  it("isolates two independent chat trees inside the same workspace", () => {
    const rootA = { sessionId: "a", workingDirectory: "D:/same" };
    const rootB = { sessionId: "b", workingDirectory: "D:/same" };
    const aChild = { workingDirectory: "D:/same" };
    const aGrandchild = { workingDirectory: "D:/same" };
    const bChild = { workingDirectory: "D:/same" };
    const orphan = { workingDirectory: "D:/same" };
    const instances = [
      { agent: aChild, parentAgent: rootA },
      { agent: aGrandchild, parentAgent: aChild },
      { agent: bChild, parentAgent: rootB },
      { agent: orphan },
    ];
    const selected = collectSessionOwnedAgents(rootA, "a", instances);
    expect(selected.has(rootA)).toBe(true);
    expect(selected.has(aChild)).toBe(true);
    expect(selected.has(aGrandchild)).toBe(true);
    expect(selected.has(rootB)).toBe(false);
    expect(selected.has(bChild)).toBe(false);
    expect(selected.has(orphan)).toBe(false);
  });

  it("allows an explicitly owned orphan but rejects contradictory parent ownership", () => {
    const rootA = {};
    const otherRoot = {};
    const owned = { sessionId: "a" };
    const conflicting = { sessionId: "a" };
    const selected = collectSessionOwnedAgents(rootA, "a", [
      { agent: owned, sessionId: "a" },
      { agent: conflicting, parentAgent: otherRoot, sessionId: "a" },
    ]);
    expect(selected.has(owned)).toBe(true);
    expect(selected.has(conflicting)).toBe(false);
  });
});
