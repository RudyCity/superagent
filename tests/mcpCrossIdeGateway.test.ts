import { afterEach, beforeEach, describe, expect, test } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSuperagentMcpServer } from "../src/core/mcp/superagentMcpServer.js";
import { MCP_GATEWAY_TOOL_NAMES } from "../src/core/mcp/mcpToolGateway.js";
import { setYoloMode } from "../src/core/permissions.js";
import { grantProjectAccess } from "../src/core/project/projectAccessPolicy.js";
import { MCP_CONNECTION_PROJECT_ID } from "../src/core/project/projectAccessRequestStore.js";

async function call(server: ReturnType<typeof createSuperagentMcpServer>, name: string, args: Record<string, unknown>) {
  const handler = (server as any)._requestHandlers.get("tools/call");
  return handler({ method: "tools/call", params: { name, arguments: args } });
}
async function list(server: ReturnType<typeof createSuperagentMcpServer>) {
  return ((await (server as any)._requestHandlers.get("tools/list")({
    method: "tools/list", params: {},
  })).tools as Array<{ name: string }>).map(x => x.name);
}
const approvedIdentity = () => ({
  mode: "oauth" as const, subject: "mcp-gateway-fixture",
  scopes: ["mcp:tools", "mcp:tools:write", "mcp:tools:admin"],
});
let priorConfig: string | undefined;
let isolatedConfig: string;
beforeEach(() => {
  priorConfig = process.env.SUPERAGENT_CONFIG_DIR;
  isolatedConfig = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-browser-gateway-"));
  process.env.SUPERAGENT_CONFIG_DIR = isolatedConfig;
  // Only a native operator-issued connection grant, never chat YOLO, may
  // authorize dangerous MCP browser control. This fixture simulates approval.
  grantProjectAccess(approvedIdentity(), MCP_CONNECTION_PROJECT_ID, ["execute"]);
});
afterEach(() => {
  setYoloMode(false);
  delete process.env.SUPERAGENT_CDP_GATEWAY_ONLY;
  if (priorConfig === undefined) delete process.env.SUPERAGENT_CONFIG_DIR;
  else process.env.SUPERAGENT_CONFIG_DIR = priorConfig;
  fs.rmSync(isolatedConfig, { recursive: true, force: true });
});
describe("Cross-IDE gateway MCP exposure and direct bypass policy", () => {
  test("gateway discovery works with dangerous tool enabled, without caller-supplied agentId", async () => {
    setYoloMode(true);
    const mcp = createSuperagentMcpServer({ toolExposure: "gateway", allowDangerous: true,
      authMode: "oauth", getIdentity: approvedIdentity });
    try {
      const tools = await list(mcp);
      expect(tools).toContain(MCP_GATEWAY_TOOL_NAMES.execute);
      expect(tools).not.toContain("superagent_browser_gateway");
      const result = await call(mcp, MCP_GATEWAY_TOOL_NAMES.execute, {
        name: "superagent_browser_gateway", arguments: { action: "identity", agentId: "FORGED" },
      });
      expect(result.isError).not.toBe(true);
      const inner = JSON.parse(result.content[0].text);
      expect(inner.agentId).toMatch(/^ide-[0-9a-f]{24}$/);
      expect(inner.agentId).not.toBe("FORGED");
    } finally { await mcp.close(); }
  });
  test("MCP-only enforcement blocks cached direct CDP/vision tool calls, but not gateway identity", async () => {
    setYoloMode(true);
    process.env.SUPERAGENT_CDP_GATEWAY_ONLY = "1";
    const mcp = createSuperagentMcpServer({ toolExposure: "full", allowDangerous: true,
      authMode: "oauth", getIdentity: approvedIdentity });
    try {
      const names = await list(mcp);
      expect(names).toContain("superagent_browser_gateway");
      const blocked = await call(mcp, "superagent_chrome_cdp", { command: "list_targets" });
      expect(blocked.isError).toBe(true);
      expect(JSON.stringify(blocked)).toContain("gateway-only mode");
      const newTool = await call(mcp, "superagent_browser_gateway", { action: "identity" });
      expect(newTool.isError).not.toBe(true);
      expect(JSON.parse(newTool.content[0].text).agentId).toMatch(/^ide-/);
    } finally { await mcp.close(); }
  });
  test("read-only OAuth identity cannot discover dangerous gateway tool", async () => {
    const mcp = createSuperagentMcpServer({
      toolExposure: "full", allowDangerous: true, authMode: "oauth",
      getIdentity: () => ({ mode: "oauth", subject: "viewer", credentialHash: "a".repeat(64), scopes: ["mcp:tools:read"] }),
    });
    try {
      expect(await list(mcp)).not.toContain("superagent_browser_gateway");
      await expect(call(mcp, "superagent_browser_gateway", { action: "identity" }))
        .rejects.toThrow(/mcp:tools:write/);
    } finally { await mcp.close(); }
  });
});
