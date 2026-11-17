import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSuperagentMcpServer, MCP_TOOL_DEFINITIONS } from "../src/core/mcp/superagentMcpServer.js";
import { MCP_TOOL_CLASSIFICATION, DISABLED_MCP_TOOLS } from "../src/core/mcp/mcpToolPolicy.js";
import { getPermanentFileToolReadiness } from "../src/core/tools/registeredFileToolGate.js";
import { MCP_GATEWAY_TOOL_NAMES } from "../src/core/mcp/mcpToolGateway.js";

const validStates = new Set([
  "certified_metadata", "certified_app_storage", "requires_explicit_files",
  "action_dependent", "uncertified",
]);
const invoke = async (server: ReturnType<typeof createSuperagentMcpServer>, tool: string, args: object = {}) =>
  (server as any)._requestHandlers.get("tools/call")({
    method: "tools/call", params: { name: tool, arguments: args },
  });
const listing = async (server: ReturnType<typeof createSuperagentMcpServer>) =>
  (server as any)._requestHandlers.get("tools/list")({method:"tools/list",params:{}});
const resultJson = (result: any) => JSON.parse(result.content[0].text);

describe("MCP full-catalog host file-policy transparency", () => {
  let config: string | undefined;
  let previous: string | undefined;
  afterEach(() => {
    if (previous === undefined) delete process.env.SUPERAGENT_CONFIG_DIR;
    else process.env.SUPERAGENT_CONFIG_DIR = previous;
    if (config) fs.rmSync(config, {recursive:true,force:true});
    config = undefined;
  });

  it("covers every registered MCP tool and all aliases with a conservative file-effect classification", () => {
    const enabled = MCP_TOOL_DEFINITIONS.filter(t=>!DISABLED_MCP_TOOLS.has(t.name));
    expect(enabled.length).toBeGreaterThan(150);
    expect(new Set(enabled.map(x=>x.name)).size).toBe(enabled.length);
    for (const tool of enabled) {
      expect(MCP_TOOL_CLASSIFICATION[tool.name], tool.name).toMatch(/^(safe|dangerous)$/);
      expect(validStates.has(getPermanentFileToolReadiness(tool.name)), tool.name).toBe(true);
    }
    expect(getPermanentFileToolReadiness("superagent_exec_command")).toBe("uncertified");
    expect(getPermanentFileToolReadiness("superagent_delegate_sync_history")).toBe("certified_app_storage");
    expect(getPermanentFileToolReadiness("superagent_lan_capabilities")).toBe("certified_metadata");
  });

  it("reports active v2 restrictions for discovery without treating certification as authorization", async () => {
    previous = process.env.SUPERAGENT_CONFIG_DIR;
    config = fs.mkdtempSync(path.join(os.tmpdir(), "sa-mcp-policy-matrix-"));
    process.env.SUPERAGENT_CONFIG_DIR = config;
    fs.writeFileSync(path.join(config,"desktop-access-registry.json"),
      JSON.stringify({version:2,defaultEffect:"deny",rules:[]}));

    const server = createSuperagentMcpServer({
      toolExposure: "full",
      authMode: "oauth",
      getIdentity: () => ({mode:"oauth",subject:"matrix-reader",
        scopes:["mcp:tools","mcp:tools:write","mcp:tools:admin"]}),
    });
    try {
      const tools = (await listing(server)).tools as Array<any>;
      const byName = (name:string) => tools.find(x=>x.name===name);
      expect(byName("superagent_exec_command")._meta.filePolicy)
        .toMatchObject({active:true,readiness:"uncertified"});
      expect(byName("superagent_read_files")._meta.filePolicy.readiness)
        .toBe("requires_explicit_files");
      expect(byName("superagent_chrome_cdp")._meta.filePolicy.readiness)
        .toBe("action_dependent");
      expect(byName("superagent_lan_capabilities")._meta.filePolicy.readiness)
        .toBe("certified_metadata");

      const search = resultJson(await invoke(server,MCP_GATEWAY_TOOL_NAMES.search,
        {query:"exec_command"}));
      expect(search.filePolicyActive).toBe(true);
      expect(search.tools.find((x:any)=>x.name==="superagent_exec_command").filePolicy)
        .toBe("uncertified");
      const describe = resultJson(await invoke(server,MCP_GATEWAY_TOOL_NAMES.describe,
        {name:"superagent_delegate_sync_history"}));
      expect(describe.filePolicy).toBe("certified_app_storage");
      expect(describe.note).toMatch(/never grants execution/i);
      const status = resultJson(await invoke(server,MCP_GATEWAY_TOOL_NAMES.status));
      expect(status.filePolicy).toMatchObject({active:true});
      expect(status.filePolicy.readinessCounts.uncertified).toBeGreaterThan(0);

      const pureCapability = await invoke(server, "superagent_lan_capabilities");
      expect(pureCapability.isError).not.toBe(true);
      expect(JSON.stringify(pureCapability)).toContain("reverseHttpsTunnel");
      const processStats = await invoke(server, "superagent_process_pool_status");
      expect(processStats.isError).not.toBe(true);
      expect(JSON.stringify(processStats)).toContain("ephemeral-os-process");
    } finally { await server.close(); }
  });
});
