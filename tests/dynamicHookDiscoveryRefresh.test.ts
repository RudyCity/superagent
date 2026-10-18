import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Agent, agentLocalStorage } from "../src/core/agent.js";
import { executeToolCall } from "../src/core/permissions.js";
import { refreshDynamicHooks } from "../src/core/tools/index.js";

describe("Dynamic hook refresh and Agent discovery cache", () => {
  let originalCwd: string;
  let tempDir: string;
  let agent: Agent | undefined;

  function writeHook(name: string, description = `Dynamic test hook ${name}`) {
    const hookDir = path.join(tempDir, "internal-hooks", name);
    fs.mkdirSync(hookDir, { recursive: true });
    fs.writeFileSync(path.join(hookDir, "hook.json"), JSON.stringify({
      name,
      description,
      parameters: {
        type: "object",
        properties: { value: { type: "string" } },
      },
      command: "echo ran > hook-ran.txt",
    }), "utf8");
  }

  beforeEach(() => {
    originalCwd = process.cwd();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "superagent-discovery-refresh-"));
    process.chdir(tempDir);
    refreshDynamicHooks();
  });

  afterEach(() => {
    agent?.dispose();
    agent = undefined;
    try {
      process.chdir(originalCwd);
      fs.rmSync(tempDir, { recursive: true, force: true });
      refreshDynamicHooks();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("invalidates cached schemas and rejects stale hook calls after a registry refresh", async () => {
    const oldName = "dynamic_refresh_old";
    const newName = "dynamic_refresh_new";
    writeHook(oldName);
    refreshDynamicHooks();

    agent = new Agent(
      vi.fn(),
      vi.fn(async () => true),
      vi.fn(async () => "continue"),
      undefined,
      undefined,
      tempDir,
    );
    agent.tier = "single";

    const beforeRefresh = await agent.getActiveTools();
    expect(beforeRefresh.map((tool) => tool.name)).toContain(oldName);

    const describe = beforeRefresh.find((tool) => tool.name === "describe_tool");
    expect(describe).toBeDefined();
    await describe!.execute({ tool: oldName }, tempDir);
    expect(agent.isToolDiscovered(oldName)).toBe(true);

    fs.rmSync(path.join(tempDir, "internal-hooks", oldName), { recursive: true, force: true });
    writeHook(newName, "Replacement dynamic test hook");
    refreshDynamicHooks();

    const staleCall = await agentLocalStorage.run(agent, () =>
      executeToolCall(
        { id: "stale-hook-call", name: oldName, args: {} },
        tempDir,
        undefined,
        beforeRefresh,
      ),
    );
    expect(staleCall.isError).toBe(true);
    expect(fs.existsSync(path.join(tempDir, "hook-ran.txt"))).toBe(false);

    const afterRefresh = await agent.getActiveTools();
    expect(afterRefresh.map((tool) => tool.name)).not.toContain(oldName);
    expect(afterRefresh.map((tool) => tool.name)).toContain(newName);
    expect((await agent.getModelVisibleTools(afterRefresh)).map((tool) => tool.name)).not.toContain(oldName);
  });
});
