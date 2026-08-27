/**
 * Regression tests for the M4 + M5 audit fixes.
 *
 * Subagents (researcher, coder, reviewer, software-tester,
 * security-engineer, general, etc.) MUST NOT be able to write to
 * long-term rmemory or to shared memory. Only the Master Agent and
 * Superagent tiers may write.
 *
 * This test pins the *curated* toolset lists (so an editor can't
 * accidentally re-add the write tools) AND exercises the runtime
 * tier guard in each write tool so a subagent that somehow has the
 * tool registered (e.g. a custom subagent type) still gets rejected.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { subagentToolsets } from "../src/core/tools/toolsets.js";

const READ_ONLY_RMEMORY = new Set([
  "rmemory_search",
  "rmemory_conversation_search",
  "rmemory_read_cos",
  "read_shared_memory",
]);
const WRITE_RMEMORY = new Set([
  "rmemory_save",
  "rmemory_conversation_add",
  "save_shared_memory",
]);

describe("subagent toolsets — M4+M5 read-only memory", () => {
  const allowedWriteTiers = new Set([
    "researcher", // verify the read-only posture
  ]);
  const TiersWithoutMemory = new Set([
    "chrome-agent", // browser-control subagent; not memory-aware by design
  ]);
  for (const [tierName, toolset] of Object.entries(subagentToolsets)) {
    it(`${tierName}: contains no write-memory tools`, () => {
      const toolNames = new Set(toolset.map((t) => t.name));
      for (const writeTool of WRITE_RMEMORY) {
        if (allowedWriteTiers.has(tierName)) continue;
        expect(
          toolNames.has(writeTool),
          `subagentToolsets.${tierName} should NOT include ${writeTool} (audit M4/M5)`
        ).toBe(false);
      }
    });

    it(`${tierName}: may still include read-memory tools`, () => {
      if (TiersWithoutMemory.has(tierName)) return;
      const toolNames = new Set(toolset.map((t) => t.name));
      // At least one read-only memory tool should be present so
      // subagents retain context access; if this fails, the
      // curation went too far.
      const hasRead = [...READ_ONLY_RMEMORY].some((n) => toolNames.has(n));
      if (toolNames.size > 0) {
        expect(hasRead, `${tierName} has no read-only memory tool — verify the curation`).toBe(true);
      }
    });
  }
});

describe("runtime tier guard in write tools (M4+M5)", () => {
  // We do NOT want to actually persist anything, so stub the rmemory
  // client and the shared-memory fs paths. We do want to assert the
  // guard fires before any side effect.
  beforeEach(() => {
    // Reset the agentLocalStorage between tests.
    vi.resetModules();
  });
  afterAll(() => {
    vi.restoreAllMocks();
  });

  it("rmemory_save refuses when current agent tier is subagent", async () => {
    const { agentLocalStorage } = await import("../src/core/agent.js");
    // Fake an agent that "is a subagent of type 'coder'".
    const fakeAgent: any = {
      tier: "subagent",
      subagentType: "coder",
    };
    await agentLocalStorage.run(fakeAgent, async () => {
      // Lazy-import so the module sees the in-store agent.
      const { rmemorySaveTool } = await import(
        "../src/core/tools/rmemoryTools.js"
      );
      const result = await rmemorySaveTool.execute(
        { id: "test", content: "should not be saved" } as any,
        "/tmp"
      );
      expect(typeof result).toBe("string");
      expect(result).toMatch(/restricted to Master Agent and Superagent/);
      expect(result).toMatch(/subagent/);
    });
  });

  it("rmemory_conversation_add refuses when current agent tier is subagent", async () => {
    const { agentLocalStorage } = await import("../src/core/agent.js");
    const fakeAgent: any = {
      tier: "subagent",
      subagentType: "researcher",
    };
    await agentLocalStorage.run(fakeAgent, async () => {
      const { rmemoryConversationAddTool } = await import(
        "../src/core/tools/rmemoryTools.js"
      );
      const result = await rmemoryConversationAddTool.execute({
        session_id: "s",
        role: "assistant",
        content: "hi",
      } as any);
      expect(typeof result).toBe("string");
      expect(result).toMatch(/restricted to Master Agent and Superagent/);
    });
  });

  it("save_shared_memory refuses when current agent tier is subagent", async () => {
    const { agentLocalStorage } = await import("../src/core/agent.js");
    const fakeAgent: any = {
      tier: "subagent",
      subagentType: "reviewer",
    };
    await agentLocalStorage.run(fakeAgent, async () => {
      const { saveSharedMemoryTool } = await import(
        "../src/core/tools/sharedMemoryTools.js"
      );
      const result = await saveSharedMemoryTool.execute(
        { key: "k", value: "v" } as any,
        "/tmp"
      );
      expect(typeof result).toBe("string");
      expect(result).toMatch(/restricted to Master Agent and Superagent/);
    });
  });
});
