import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  WORKSPACE_CHAIN_MCP_TOOL_CLASSIFICATIONS,
  dispatchWorkspaceChainMcpTool,
} from "../src/core/mcp/tools/workspaceChainMcpTools.js";
import { setFullYoloMode } from "../src/core/permissions.js";
import { getWorkspaceChains } from "../src/core/workspace/WorkspaceChainConfig.js";

let configDir: string;
let previousConfigDir: string | undefined;

function textOf(result: any): string {
  return result?.content?.[0]?.text ?? "";
}

beforeEach(() => {
  previousConfigDir = process.env.SUPERAGENT_CONFIG_DIR;
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-chain-tools-config-"));
  process.env.SUPERAGENT_CONFIG_DIR = configDir;
  setFullYoloMode(false);
});

afterEach(() => {
  setFullYoloMode(false);
  if (previousConfigDir === undefined) delete process.env.SUPERAGENT_CONFIG_DIR;
  else process.env.SUPERAGENT_CONFIG_DIR = previousConfigDir;
  fs.rmSync(configDir, { recursive: true, force: true });
});

describe("Workspace Chain MCP adapter", () => {
  it("exposes listing as safe and mutating/cross-node operations as dangerous", () => {
    expect(WORKSPACE_CHAIN_MCP_TOOL_CLASSIFICATIONS.superagent_list_workspace_chains).toBe("safe");
    expect(WORKSPACE_CHAIN_MCP_TOOL_CLASSIFICATIONS.superagent_manage_workspace_chain).toBe("dangerous");
    expect(WORKSPACE_CHAIN_MCP_TOOL_CLASSIFICATIONS.superagent_cross_workspace_exec).toBe("dangerous");
  });

  it("lists chains through the safe MCP adapter", async () => {
    const result = await dispatchWorkspaceChainMcpTool("superagent_list_workspace_chains", {}, process.cwd());
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(textOf(result))).toMatchObject({ count: 0, chains: [] });
  });

  it("requires Full YOLO for chain mutation and cross-workspace execution", async () => {
    const manage = await dispatchWorkspaceChainMcpTool("superagent_manage_workspace_chain", { action: "list" }, process.cwd());
    expect(manage.isError).toBe(true);
    expect(textOf(manage)).toContain("Full YOLO");

    const exec = await dispatchWorkspaceChainMcpTool("superagent_cross_workspace_exec", { operation: "exec", nodeId: "main", command: "echo unsafe" }, process.cwd());
    expect(exec.isError).toBe(true);
    expect(textOf(exec)).toContain("Full YOLO");
  });

  it("rejects inline SSH passwords before they can be persisted", async () => {
    setFullYoloMode(true);
    const result = await dispatchWorkspaceChainMcpTool("superagent_manage_workspace_chain", {
      action: "create",
      name: "No Secrets Test",
      primaryNodeId: "remote",
      nodes: [{
        id: "remote",
        label: "Remote",
        type: "ssh",
        role: "main",
        sshConfig: { host: "example.test", port: 22, username: "tester", remoteCwd: "/srv/app", password: "must-not-be-saved" },
      }],
    }, process.cwd());
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/inline SSH|passwords|secrets/i);
    expect(getWorkspaceChains(process.cwd(), false)).toEqual([]);
  });

  it("requires a registered chain project for cross-workspace execution", async () => {
    setFullYoloMode(true);
    const result = await dispatchWorkspaceChainMcpTool("superagent_cross_workspace_exec", { operation: "health" }, "chain:unregistered-chain");
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/not registered as an enabled MCP project/i);
  });
});
