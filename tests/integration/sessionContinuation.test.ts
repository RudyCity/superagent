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

  it("should resolve explicit session ID in alternative history mode directory if not found in current mode", () => {
    const dummyWorkspace = path.join(process.cwd(), "temp-test-workspace-" + Date.now());
    
    const singleAgent = new Agent(
      () => {},
      async () => true,
      async () => {},
      "System prompt",
      [],
      dummyWorkspace
    );
    singleAgent.isMultiAgent = false; // single mode

    const multiAgent = new Agent(
      () => {},
      async () => true,
      async () => {},
      "System prompt",
      [],
      dummyWorkspace
    );
    multiAgent.isMultiAgent = true; // multi mode

    const customSessionId = "session_mock_mode_cross_" + Date.now();
    
    // Let's mock the existence of the file in the multi-agent directory
    const multiPath = PathResolver.resolveHistoryFilePath(multiAgent, customSessionId);
    
    const fs = require("fs");
    fs.mkdirSync(path.dirname(multiPath), { recursive: true });
    fs.writeFileSync(multiPath, "");

    try {
      // Now, try to resolve the same customSessionId on the SINGLE-agent instance.
      // It should check the multi-agent mode directory and find the existing path!
      const resolvedFromSingle = PathResolver.resolveHistoryFilePath(singleAgent, customSessionId);
      
      expect(resolvedFromSingle).toBe(multiPath);
    } finally {
      // Cleanup
      try {
        fs.unlinkSync(multiPath);
        fs.rmdirSync(path.dirname(multiPath));
      } catch {}
    }
  });
});
