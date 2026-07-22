import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { Agent } from "../src/core/agent.js";
import { streamText } from "ai";
import type { AgentEvent } from "../src/core/tools/types.js";
import { closeHistoryDb } from "../src/core/storage/historyDb.js";

// Mock providers config and jsonConfig to avoid actual files and API keys.
const tempHome = path.join(os.tmpdir(), "superagent-test-home-" + Date.now());
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;

import * as jsonConfigModule from "../src/core/config/jsonConfig.js";
import * as providersModule from "../src/core/config/providers.js";
import * as permissionsModule from "../src/core/permissions.js";

// Mock the AI SDK so we never hit a real provider.
vi.mock("ai", () => ({
  streamText: vi.fn(),
  jsonSchema: (val: any) => val,
}));

// Stub executeToolCall so the model's `write` tool call to the plan file is a
// no-op on disk — the agent's own MODIFYING_TOOLS guard handles the planState
// transition before executeToolCall runs, which is what we are testing.
vi.mock("../src/core/permissions.js", () => ({
  executeToolCall: vi.fn(async (tc: any) => ({
    toolCallId: tc.id,
    name: tc.name,
    result: "ok",
  })),
  getToolDescription: vi.fn(() => "mock tool description"),
  isDangerousCommand: vi.fn(() => false),
  isToolCallOutOfBounds: vi.fn(() => false),
  isModelConfigAccess: vi.fn(() => false),
  isSensitiveEnvFileAccess: vi.fn(() => false),
  MODIFYING_TOOLS: [
    "write",
    "write_to_file",
    "edit",
    "replace_file_content",
    "multi_replace_file_content",
    "apply_patch",
  ],
}));

describe("Agent – plan approval breaks the loop", () => {
  beforeEach(() => {
    if (fs.existsSync(tempHome)) {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
    fs.mkdirSync(tempHome, { recursive: true });
    vi.clearAllMocks();

    // Mock jsonConfig using vi.spyOn
    vi.spyOn(jsonConfigModule, "getSettings").mockReturnValue({
      maxConcurrency: 1,
      rateLimitRequests: 10,
      rateLimitInterval: 1000,
      disableStreaming: false,
      contextWindowLimit: 10000,
      maxIterations: 10,
    } as any);

    // Mock providers using vi.spyOn
    vi.spyOn(providersModule, "getEffectiveMasterModel").mockReturnValue("gpt-4");
    vi.spyOn(providersModule, "getTierModel").mockReturnValue("gpt-4");
    vi.spyOn(providersModule, "getActiveProviderName").mockReturnValue("openai");
    vi.spyOn(providersModule, "getConfiguredProviders").mockReturnValue({
      provider: "openai",
      model: "gpt-4",
      apiKey: "fake-key",
      disableStreaming: false,
      workingDirectory: process.cwd(),
      systemPrompt: "Base Agent Prompt Content",
    } as any);
  });

  afterEach(() => {
    try {
      closeHistoryDb();
    } catch {}
    if (fs.existsSync(tempHome)) {
      try {
        fs.rmSync(tempHome, { recursive: true, force: true });
      } catch {}
    }
  });

  /**
   * Reproduces the bug: when the model writes a valid implementation plan, the
   * agent loop must stop immediately so that the natural "done" event fires
   * and the UI can open the plan approval wizard. Before the fix the loop kept
   * iterating and "done" only fired when the user pressed ESC to abort.
   */
  it("emits a done event after planState becomes PLANNING_PENDING without abort", async () => {
    const events: AgentEvent[] = [];
    const onEvent = vi.fn((e: AgentEvent) => events.push(e));
    const onPermission = vi.fn().mockResolvedValue(true);
    const onQuestion = vi.fn();

    const agent = new Agent(onEvent, onPermission, onQuestion);
    agent.tier = "single";
    agent.planState = "IDLE";

    // Lock the history file path FIRST so getPlanFilePath() returns a stable
    // path (resolveHistoryFilePath generates a new timestamp per call when
    // currentHistoryFilePath is unset — we must pin it before reading the plan
    // path, otherwise the path we hand the model won't match the one the agent
    // checks inside sendMessage).
    agent.getCurrentHistoryFilePath();
    const planPath = agent.getPlanFilePath();

    // A valid plan that passes the required-sections validation in agent.ts.
    const validPlan = `# Sample Goal

Some background.

## Proposed Changes
- [ ] Task 1: edit source code

## Verification Plan
Verify the build.

### Automated Tests
- Run npm test

### Manual Verification
- Manual check
`;

    let modelCallCount = 0;
    vi.mocked(streamText).mockImplementation(() => {
      modelCallCount++;
      const currentCall = modelCallCount;
      return {
        fullStream: (async function* () {
          if (currentCall === 1) {
            // First iteration: model writes the implementation plan to the
            // plan file path. The agent's MODIFYING_TOOLS guard should flip
            // planState to PLANNING_PENDING.
            yield {
              type: "tool-call",
              toolCallId: "call_1",
              toolName: "write",
              args: { filePath: planPath, content: validPlan },
            };
          } else {
            // If the loop does NOT break (the bug), the model gets called
            // again. A defensive second response that does nothing harmful.
            yield { type: "text-delta", textDelta: "Standing by." };
          }
        })(),
        usage: Promise.resolve({ promptTokens: 10, completionTokens: 10 }),
      } as any;
    });

    await agent.sendMessage("please make a plan");

    // ── The core assertion of the fix ────────────────────────────────────
    // The loop must break after the plan is written, so the model is only
    // called ONCE. Before the fix, planState flipped but the loop kept
    // iterating (model called repeatedly until ESC).
    expect(modelCallCount).toBe(1);

    // planState must be PLANNING_PENDING for the UI to open the wizard.
    expect(agent.planState).toBe("PLANNING_PENDING");

    // A "done" event must have been emitted naturally (the UI opens the
    // approval wizard on done + PLANNING_PENDING, see app.tsx handleEvent).
    const doneEvents = events.filter((e) => e.type === "done");
    expect(doneEvents.length).toBe(1);
  });
});
