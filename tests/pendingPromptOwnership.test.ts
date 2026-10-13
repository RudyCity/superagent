import { describe, expect, it } from "vitest";
import { isPendingPromptOwner } from "../src/core/agent/pendingPromptOwnership.js";

describe("pending prompt ownership", () => {
  const agentA = {};
  const agentB = {};
  const sessionA = { agent: agentA, sessionId: "session-a" };
  const sessionB = { agent: agentB, sessionId: "session-b" };

  it("allows only the exact agent that owns a prompt", () => {
    const pending = { ownerAgent: agentA, sessionId: "session-a", workspace: "/project-a" };
    expect(isPendingPromptOwner(pending, sessionA)).toBe(true);
    expect(isPendingPromptOwner(pending, sessionB)).toBe(false);
  });

  it("uses exact session ID only for legacy prompts without an agent reference", () => {
    const pending = { sessionId: "session-a", workspace: "/project-a" };
    expect(isPendingPromptOwner(pending, sessionA)).toBe(true);
    expect(isPendingPromptOwner(pending, sessionB)).toBe(false);
  });

  it("fails closed when the prompt or resolving session is missing", () => {
    expect(isPendingPromptOwner(undefined, sessionA)).toBe(false);
    expect(isPendingPromptOwner({ sessionId: "session-a" }, null)).toBe(false);
    expect(isPendingPromptOwner({ workspace: "/project-a" }, sessionA)).toBe(false);
  });
});
