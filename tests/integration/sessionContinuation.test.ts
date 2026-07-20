import { describe, it, expect } from "vitest";
import { PathResolver } from "../../src/core/agent/PathResolver.js";
import { Agent } from "../../src/core/agent.js";
import type { AgentEvent } from "../../src/core/agent.js";
import path from "path";

describe("Session Continuation Integration Tests", () => {
  it("should preserve custom session ID when resolving file path for a new session", () => {
    const dummyWorkspace = path.join(process.cwd(), "temp-test-workspace-" + Date.now());
    
    const mockAgent = new Agent(
      () => {},
      async () => true,
      async () => {},
      "System prompt",
      [],
      dummyWorkspace
    );

    const customSessionId = "session_test_" + Date.now();
    const resolvedPath = PathResolver.resolveHistoryFilePath(mockAgent, customSessionId);
    
    // Basename should match the customSessionId exactly
    const resolvedBasename = path.basename(resolvedPath, ".json");
    expect(resolvedBasename).toBe(customSessionId);
    
    // Folder name should also match the customSessionId
    const resolvedFolder = path.basename(path.dirname(resolvedPath));
    expect(resolvedFolder).toBe(customSessionId);
  });
});
