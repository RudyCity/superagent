import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSuperagentMcpServer, MCP_TOOL_DEFINITIONS } from "../src/core/mcp/superagentMcpServer.js";
import { MCP_TOOL_CLASSIFICATION, DISABLED_MCP_TOOLS } from "../src/core/mcp/mcpToolPolicy.js";
import { getPermanentFileToolReadiness } from "../src/core/tools/registeredFileToolGate.js";
import { MCP_GATEWAY_TOOL_NAMES } from "../src/core/mcp/mcpToolGateway.js";

const validStates = new Set([
  "certified_metadata", "certified_non_file", "certified_app_storage", "requires_explicit_files",
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
    expect(getPermanentFileToolReadiness("superagent_find_process")).toBe("certified_non_file");
    expect(getPermanentFileToolReadiness("superagent_sync_projects")).toBe("certified_non_file");
    expect(getPermanentFileToolReadiness("superagent_device_android_diagnostic")).toBe("certified_non_file");
    expect(getPermanentFileToolReadiness("superagent_delegate_sync_history")).toBe("certified_app_storage");
    expect(getPermanentFileToolReadiness("superagent_lan_capabilities")).toBe("certified_metadata");
    expect(getPermanentFileToolReadiness("superagent_tool_execute")).toBe("action_dependent");
    expect(MCP_TOOL_CLASSIFICATION["superagent_chrome_cdp_observe"]).toBe("safe");
    expect(getPermanentFileToolReadiness("superagent_chrome_cdp_observe")).toBe("certified_metadata");
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
      expect(byName("superagent_desktop_ui")._meta.mcpApproval)
        .toMatchObject({kind:"project",capability:"execute",oauthScope:"mcp:tools:write"});
      expect(byName("superagent_tool_execute")._meta.mcpApproval.kind)
        .toBe("target_dependent");
      expect(byName("superagent_write_files")._meta.mcpApproval.kind)
        .toBe("project");
      expect(byName("superagent_read_files")._meta.mcpApproval)
        .toMatchObject({kind:"project",oauthScope:"mcp:tools",capability:"read"});
      expect(byName("superagent_grep_search")._meta.mcpApproval)
        .toMatchObject({kind:"project",oauthScope:"mcp:tools",capability:"read"});
      expect(byName("superagent_read_files")._meta.filePolicy.readiness)
        .toBe("requires_explicit_files");
      expect(byName("superagent_chrome_cdp")._meta.filePolicy.readiness)
        .toBe("action_dependent");
      expect(byName("superagent_chrome_cdp_observe")._meta.filePolicy.readiness)
        .toBe("certified_metadata");
      expect(byName("superagent_chrome_cdp")._meta.filePolicy.requirement)
        .toMatch(/no evaluate/i);
      expect(byName("superagent_lan_capabilities")._meta.filePolicy.readiness)
        .toBe("certified_metadata");
      // Tool discovery must not suggest a fixed Git grant when the action
      // determines read vs git; OAuth write is still independently required.
      expect(byName("superagent_git_action")._meta.mcpApproval).toMatchObject({
        kind:"project",capabilityMode:"action_dependent",
        capabilitiesByAction:{status:"read",diff:"read",log:"read",commit:"git"},
      });
      expect(byName("superagent_register_project")._meta.mcpApproval).toMatchObject({
        kind:"operator_admin",
        requiredOAuthScopes:["mcp:tools:write","mcp:tools:admin"],
      });

      const search = resultJson(await invoke(server,MCP_GATEWAY_TOOL_NAMES.search,
        {query:"exec_command"}));
      expect(search.filePolicyActive).toBe(true);
      expect(search.tools.find((x:any)=>x.name==="superagent_exec_command").filePolicy)
        .toBe("uncertified");
      expect(search.tools.find((x:any)=>x.name==="superagent_exec_command").filePolicyRequirement)
        .toMatch(/not certified/i);
      const describe = resultJson(await invoke(server,MCP_GATEWAY_TOOL_NAMES.describe,
        {name:"superagent_delegate_sync_history"}));
      expect(describe.filePolicy).toBe("certified_app_storage");
      expect(describe.mcpApproval).toMatchObject({kind:"project",capability:"execute"});
      expect(describe.filePolicyRequirement).toMatch(/MCP write scope/);
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

  it("advertises narrow CDP observation directly to read-only MCP clients", async () => {
    previous = process.env.SUPERAGENT_CONFIG_DIR;
    config = fs.mkdtempSync(path.join(os.tmpdir(), "sa-mcp-cdp-observe-"));
    process.env.SUPERAGENT_CONFIG_DIR = config;
    fs.writeFileSync(path.join(config,"desktop-access-registry.json"),
      JSON.stringify({version:2,defaultEffect:"deny",rules:[]}));
    const server = createSuperagentMcpServer({
      toolExposure: "gateway",
      authMode: "oauth",
      getIdentity: () => ({mode:"oauth",subject:"cdp-metadata-reader",scopes:["mcp:tools"]}),
    });
    try {
      const tools = (await listing(server)).tools as Array<any>;
      const observe = tools.find(x => x.name === "superagent_chrome_cdp_observe");
      expect(observe).toBeDefined();
      expect(observe._meta.filePolicy).toMatchObject({active:true,readiness:"certified_metadata"});
      expect(observe._meta.mcpApproval).toMatchObject({kind:"read_only",oauthScope:"mcp:tools"});
      expect(observe.annotations).toMatchObject({readOnlyHint:true,destructiveHint:false});
      expect(tools.some(x => x.name === "superagent_chrome_cdp")).toBe(false);
      const rejected = await invoke(server,"superagent_chrome_cdp_observe",
        {command:"evaluate",transport:"delegate"});
      expect(rejected.isError).toBe(true);
      expect(JSON.stringify(rejected)).toMatch(/not certified|Uncertified|denied/i);
    } finally { await server.close(); }
  });
  it("rejects control commands on the observe endpoint even without a permanent file registry", async () => {
    previous = process.env.SUPERAGENT_CONFIG_DIR;
    config = fs.mkdtempSync(path.join(os.tmpdir(), "sa-mcp-cdp-no-registry-"));
    process.env.SUPERAGENT_CONFIG_DIR = config;
    const server = createSuperagentMcpServer({
      toolExposure: "full",
      authMode: "oauth",
      getIdentity: () => ({mode:"oauth",subject:"cdp-reader-only",scopes:["mcp:tools"]}),
    });
    try {
      const forbidden = await invoke(server,"superagent_chrome_cdp_observe",
        {command:"navigate",transport:"delegate",url:"https://example.com"});
      expect(forbidden.isError).toBe(true);
      expect(JSON.stringify(forbidden)).toMatch(/Uncertified|denied|not certified/i);
    } finally { await server.close(); }
  });

});
