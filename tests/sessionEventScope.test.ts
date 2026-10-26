import { describe, expect, it } from "vitest";
import { shouldDeliverEventToClient } from "../src/core/utils/sessionEventScope.js";

describe("SSE session/workspace event scope", () => {
  it("delivers session events only to the exact session", () => {
    const event = { type: "permission_required", sessionId: "session-a", workspace: "D:/projects/a" };
    expect(shouldDeliverEventToClient(event, { sessionId: "session-a", workspace: "D:/projects/a" })).toBe(true);
    expect(shouldDeliverEventToClient(event, { sessionId: "session-b", workspace: "D:/projects/a" })).toBe(false);
    expect(shouldDeliverEventToClient(event, { sessionId: "session-b", workspace: "D:/projects/b" })).toBe(false);
  });

  it("never falls back to workspace when an event belongs to a specific chat session", () => {
    const event = { type: "agent_event", sessionId: "chat-a", workspace: "D:/same-project" };
    expect(shouldDeliverEventToClient(event, { workspace: "D:/same-project" })).toBe(false);
    expect(shouldDeliverEventToClient(event, { sessionId: "chat-b", workspace: "D:/same-project" })).toBe(false);
    expect(shouldDeliverEventToClient(event, { sessionId: "chat-a", workspace: "D:/different" })).toBe(false);
    expect(shouldDeliverEventToClient(event, { sessionId: "chat-a", workspace: "D:/same-project" })).toBe(true);
  });

  it("allows workspace-scoped delivery only when the client has the same workspace", () => {
    const event = { type: "status", workspace: "D:/projects/a" };
    expect(shouldDeliverEventToClient(event, { workspace: "d:/projects/a/" })).toBe(true);
    expect(shouldDeliverEventToClient(event, { workspace: "D:/projects/b" })).toBe(false);
    expect(shouldDeliverEventToClient(event, undefined)).toBe(false);
  });

  it("does not deliver session prompts to clients with no resolvable context", () => {
    expect(shouldDeliverEventToClient({ type: "question_required", sessionId: "session-a" })).toBe(false);
    expect(shouldDeliverEventToClient({ type: "question_required", sessionId: "session-a" }, {})).toBe(false);
  });

  it("keeps intentionally global events available to every client", () => {
    expect(shouldDeliverEventToClient({ type: "superagent-sessions-changed" })).toBe(true);
  });

  it("preserves explicit agent sessionId across history path resolution", async () => {
    const { PathResolver } = await import("../src/core/agent/PathResolver.js");
    const mockAgent: any = {
      sessionId: "sess_custom_preserve_999",
      workingDirectory: process.cwd(),
      isMultiAgent: false,
      tier: "single",
    };
    mockAgent.resolveHistoryFilePath = (resume: any) => PathResolver.resolveHistoryFilePath(mockAgent, resume);
    mockAgent.getCurrentHistoryFilePath = () => PathResolver.getCurrentHistoryFilePath(mockAgent);

    const historyPath = PathResolver.getCurrentHistoryFilePath(mockAgent);
    expect(mockAgent.sessionId).toBe("sess_custom_preserve_999");
    expect(historyPath.endsWith("sess_custom_preserve_999.json")).toBe(true);
  });
});
