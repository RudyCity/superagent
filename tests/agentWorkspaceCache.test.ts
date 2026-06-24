import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { Agent } from "../src/core/agent.js";
import * as workspaceDiscovery from "../src/core/workspaceDiscovery.js";

// Mock the AI SDK to bypass network calls
vi.mock("ai", async (importOriginal) => {
  const original = await importOriginal<any>();
  return {
    ...original,
    generateText: vi.fn(async (options: any) => {
      // Mock classifier run
      if (options.prompt && options.prompt.includes("CLASSIFY_TASK")) {
        return {
          text: "no",
          usage: { promptTokens: 10, completionTokens: 2 }
        };
      }
      return {
        text: "Mocked non-streaming agent response",
        toolCalls: [],
        usage: { promptTokens: 100, completionTokens: 20 }
      };
    }),
    streamText: vi.fn((options: any) => {
      const mockStream = (async function* () {
        yield { type: "text-delta", textDelta: "Mocked " };
        yield { type: "text-delta", textDelta: "response." };
      })();
      return {
        fullStream: mockStream,
        usage: Promise.resolve({
          promptTokens: 120,
          completionTokens: 30
        })
      };
    })
  };
});

describe("Agent Workspace Cache Integration", () => {
  let testWorkspaceDir: string;
  let testConfigDir: string;
  let originalConfigDirEnv: string | undefined;

  beforeEach(() => {
    originalConfigDirEnv = process.env.SUPERAGENT_CONFIG_DIR;
    testWorkspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "sa-agent-test-ws-"));
    testConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "sa-agent-test-cfg-"));
    process.env.SUPERAGENT_CONFIG_DIR = testConfigDir;

    // Write mock configuration to avoid missing provider error
    const modelConfigPath = path.join(testConfigDir, "model-config.json");
    fs.writeFileSync(
      modelConfigPath,
      JSON.stringify({
        activeProviderId: "anthropic",
        providers: [
          {
            id: "anthropic",
            profileId: "anthropic",
            apiKey: "dummy-key"
          }
        ],
        settings: {
          concurrencyLimit: 2,
          streaming: false
        },
        tierModels: {
          single: "claude-3-5-sonnet-20241022"
        }
      })
    );

    // Mock minimal project layout
    fs.writeFileSync(path.join(testWorkspaceDir, "agents.md"), "# Project Guidelines");
  });

  afterEach(() => {
    process.env.SUPERAGENT_CONFIG_DIR = originalConfigDirEnv;
    try {
      fs.rmSync(testWorkspaceDir, { recursive: true, force: true });
      fs.rmSync(testConfigDir, { recursive: true, force: true });
    } catch {}
    vi.restoreAllMocks();
  });

  it("should trigger discoverWorkspace and print cache hit logs when workspace is identical", async () => {
    const mockCache = {
      workspaceDir: testWorkspaceDir,
      fingerprint: "12345",
      fileList: ["agents.md", "src/index.ts"],
      files: {},
      agentsMd: "# Project Guidelines",
      packageJson: {},
      lastScanTime: Date.now()
    };

    // Spy/Mock workspace discovery methods
    const discoverSpy = vi.spyOn(workspaceDiscovery, "discoverWorkspace").mockResolvedValue({
      isIdentical: true,
      cache: mockCache
    });
    const injectSpy = vi.spyOn(workspaceDiscovery, "injectWorkspaceOverview");

    const events: any[] = [];
    const onEvent = (e: any) => events.push(e);
    const onPermission = async () => true;
    const onQuestion = async () => "yes";

    const agent = new Agent(
      onEvent,
      onPermission,
      onQuestion,
      undefined,
      undefined,
      testWorkspaceDir
    );

    // Send a message to start the loop
    await agent.sendMessage("Hello agent");

    // Verify workspace discovery was called
    expect(discoverSpy).toHaveBeenCalledWith(testWorkspaceDir);

    // Verify it printed cached message
    const sysLogs = events.filter(e => e.type === "text" && e.content.includes("identical"));
    expect(sysLogs.length).toBeGreaterThan(0);
    expect(sysLogs[0].content).toContain("identical to previous session");

    // Verify prompt overview injection occurred
    expect(injectSpy).toHaveBeenCalled();
  });

  it("should print partial scan logs when workspace has changed", async () => {
    const mockCache = {
      workspaceDir: testWorkspaceDir,
      fingerprint: "changed-67890",
      fileList: ["agents.md", "src/index.ts"],
      files: {},
      agentsMd: "# Project Guidelines",
      packageJson: {},
      lastScanTime: Date.now()
    };

    const discoverSpy = vi.spyOn(workspaceDiscovery, "discoverWorkspace").mockResolvedValue({
      isIdentical: false,
      cache: mockCache
    });

    const events: any[] = [];
    const onEvent = (e: any) => events.push(e);
    const onPermission = async () => true;
    const onQuestion = async () => "yes";

    const agent = new Agent(
      onEvent,
      onPermission,
      onQuestion,
      undefined,
      undefined,
      testWorkspaceDir
    );

    await agent.sendMessage("Hello agent");

    expect(discoverSpy).toHaveBeenCalledWith(testWorkspaceDir);

    // Verify it printed partial scan/cache build logs
    const sysLogs = events.filter(e => e.type === "text" && (e.content.includes("changed") || e.content.includes("scanned")));
    expect(sysLogs.length).toBeGreaterThan(0);
  });
});
