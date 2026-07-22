import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { Agent } from "../src/core/agent.js";
import * as aiModule from "ai";
import * as configModule from "../src/core/config.js";

// Tests for Agent workspace cache behavior using the actual API:
//   agent.workspaceCache (null initially)
//   agent.workspaceCacheNeedsUpdate (private flag)
//   agent.disableWorkspaceDiscovery (public, set to true under VITEST)

describe("Agent Workspace Cache Integration", () => {
  let testWorkspaceDir: string;
  let testConfigDir: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.restoreAllMocks();
    testWorkspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-test-"));
    testConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-config-test-"));
    process.env.SUPERAGENT_CONFIG_DIR = testConfigDir;
    process.env.VITEST = "true";

    vi.spyOn(aiModule, "generateText").mockImplementation(async (options: any) => {
      if (options.prompt && options.prompt.includes("CLASSIFY_TASK")) {
        return { text: "no", usage: { promptTokens: 10, completionTokens: 2 } } as any;
      }
      return {
        text: "Mocked non-streaming agent response",
        toolCalls: [],
        usage: { promptTokens: 100, completionTokens: 20 }
      } as any;
    });

    vi.spyOn(aiModule, "streamText").mockImplementation((_options: any) => {
      const mockStream = (async function* () {
        yield { type: "text-delta", textDelta: "Mocked response." };
      })();
      return {
        fullStream: mockStream,
        usage: Promise.resolve({ promptTokens: 120, completionTokens: 30 })
      } as any;
    });

    vi.spyOn(configModule, "getConfig").mockReturnValue({
      provider: "openai",
      model: "gpt-4",
      apiKey: "test-api-key",
      disableStreaming: true,
      workingDirectory: testWorkspaceDir,
    } as any);
  });

  afterEach(() => {
    Object.assign(process.env, originalEnv);
    fs.rmSync(testWorkspaceDir, { recursive: true, force: true });
    fs.rmSync(testConfigDir, { recursive: true, force: true });
  });

  it("should start with null workspace cache on initialization", () => {
    const agent = new Agent(
      () => {},
      async () => true,
      async () => ""
    );

    expect(agent.workspaceCache).toBeNull();
  });

  it("should have workspace discovery disabled under VITEST", () => {
    const agent = new Agent(
      () => {},
      async () => true,
      async () => ""
    );

    expect(agent.disableWorkspaceDiscovery).toBe(true);
  });

  it("should allow manually setting workspaceCache", () => {
    const agent = new Agent(
      () => {},
      async () => true,
      async () => ""
    );

    const fakeCache = { agentsMd: "# Project\nTest project", files: [] };
    agent.workspaceCache = fakeCache;

    expect(agent.workspaceCache).toBe(fakeCache);
    expect(agent.workspaceCache.agentsMd).toBe("# Project\nTest project");
  });

  it("should reset workspace cache flag when workspaceCache is set to null", () => {
    const agent = new Agent(
      () => {},
      async () => true,
      async () => ""
    );

    const fakeCache = { agentsMd: "some content" };
    agent.workspaceCache = fakeCache;
    expect(agent.workspaceCache).not.toBeNull();

    agent.workspaceCache = null;
    expect(agent.workspaceCache).toBeNull();
  });
});
