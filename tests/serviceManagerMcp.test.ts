import {describe,it,expect,afterEach} from "vitest";
import {createSuperagentMcpServer,MCP_TOOL_CLASSIFICATION,MCP_TOOL_DEFINITIONS}
  from "../src/core/mcp/superagentMcpServer.js";
import {CallToolRequestSchema,ListToolsRequestSchema}
  from "@modelcontextprotocol/sdk/types.js";
import {setYoloMode,setFullYoloMode} from "../src/core/permissions.js";
import {getToolSecuritySchemes} from "../src/core/mcp/mcpToolPolicy.js";

function handlers(scope:string[],yolo:boolean){
  setYoloMode(yolo);
  const server=createSuperagentMcpServer({
    allowDangerous:true,toolExposure:"gateway",authMode:"oauth",
    getIdentity:()=>({mode:"oauth",subject:"staging",scopes:scope}),
  });
  const map=(server as any)._requestHandlers;
  return {server,list:map.get(ListToolsRequestSchema.shape.method.value),
    call:map.get(CallToolRequestSchema.shape.method.value)};
}
afterEach(()=>{setYoloMode(false);setFullYoloMode(false);});
describe("MCP unified management authorization",()=>{
  it("defines exactly one unified MCP service management endpoint requiring OAuth write",()=>{
    expect(MCP_TOOL_DEFINITIONS.filter(x=>x.name==="superagent_manage_services")).toHaveLength(1);
    expect(MCP_TOOL_CLASSIFICATION.superagent_manage_services).toBe("dangerous");
    expect(getToolSecuritySchemes("superagent_manage_services","oauth")[0].scopes)
      .toContain("mcp:tools:write");
  });
  it("does not expose or execute manager with read-only OAuth token",async()=>{
    const {server,list,call}=handlers(["mcp:tools"],true);
    try{
      const names=(await list({method:"tools/list",params:{}})).tools.map((x:any)=>x.name);
      expect(names).not.toContain("superagent_manage_services");
      await expect(call({method:"tools/call",params:{
        name:"superagent_manage_services",arguments:{action:"stop",service:"mcp",port:19997,confirm:true},
      }})).rejects.toThrow();
    } finally {await server.close();}
  });
  it("exposes write-scope tools but never treats discovery, YOLO, or read actions as an Execute grant",async()=>{
    const {server,list,call}=handlers(["mcp:tools","mcp:tools:write"],true);
    try {
      const names=(await list({method:"tools/list",params:{}})).tools.map((x:any)=>x.name);
      expect(names).toContain("superagent_manage_services");
      const inventory=await call({method:"tools/call",params:{
        name:"superagent_services_status",arguments:{action:"status",service:"tray"},
      }});
      expect(inventory.isError).not.toBe(true);
      expect(JSON.stringify(inventory)).toContain("tray");
      // Even a read-only action sent via the dangerous mixed-mode endpoint
      // requires an independent operator-approved MCP Connection grant.
      await expect(call({method:"tools/call",params:{
        name:"superagent_manage_services",arguments:{action:"status",service:"tray"},
      }})).rejects.toThrow(/MCP_APPROVAL_REQUIRED/);
      await expect(call({method:"tools/call",params:{
        name:"superagent_manage_services",
        arguments:{action:"restart",service:"mcp",port:19997,confirm:true},
      }})).rejects.toThrow(/MCP_APPROVAL_REQUIRED/);
    } finally {await server.close();}
  });
  it("does not confuse write-scope discovery with a local YOLO or connection grant",async()=>{
    const {server,list,call}=handlers(["mcp:tools","mcp:tools:write"],false);
    try {
      const tools=(await list({method:"tools/list",params:{}})).tools;
      const manager=tools.find((x:any)=>x.name==="superagent_manage_services");
      expect(manager).toBeDefined();
      // Tool visibility is scoped to OAuth. It does not confer execution
      // authority while the independent human-approved grant is absent.
      expect(manager.annotations?.readOnlyHint).not.toBe(true);
      await expect(call({method:"tools/call",params:{
        name:"superagent_manage_services",arguments:{action:"status",service:"core"},
      }})).rejects.toThrow(/MCP_APPROVAL_REQUIRED/);
    } finally {await server.close();}
  });
  it("exposes read-only superagent_services_status to read-only callers without YOLO",async()=>{
    const {server,list,call}=handlers(["mcp:tools"],false);
    try {
      expect(MCP_TOOL_CLASSIFICATION.superagent_services_status).toBe("safe");
      const tools=(await list({method:"tools/list",params:{}})).tools;
      const statusTool=tools.find((x:any)=>x.name==="superagent_services_status");
      expect(statusTool).toBeDefined();
      expect(statusTool.annotations?.readOnlyHint).toBe(true);
      expect(statusTool.annotations?.destructiveHint).toBe(false);
      const attestation=await call({method:"tools/call",params:{
        name:"superagent_services_status",arguments:{action:"owner_status",service:"tray"},
      }});
      expect(attestation.isError).not.toBe(true);
      expect(JSON.stringify(attestation)).toContain("owner_status");
      expect(JSON.stringify(attestation)).not.toContain("authToken");
      const invalid=await call({method:"tools/call",params:{
        name:"superagent_services_status",arguments:{action:"stop"},
      }});
      expect(invalid.isError).toBe(true);
      expect(JSON.stringify(invalid)).toContain("Action 'stop' is not permitted");
    } finally {await server.close();}
  });
});
