import {describe,it,expect,afterEach} from "vitest";
import {createSuperagentMcpServer,MCP_TOOL_CLASSIFICATION,MCP_TOOL_DEFINITIONS} from "../src/core/mcp/superagentMcpServer.js";
import {setFullYoloMode,setYoloMode} from "../src/core/permissions.js";
import {CallToolRequestSchema,ListToolsRequestSchema} from "@modelcontextprotocol/sdk/types.js";
import {getToolSecuritySchemes} from "../src/core/mcp/mcpToolPolicy.js";

const names=["superagent_core_status","superagent_core_plan","superagent_core_restart",
  "superagent_core_rollback","superagent_core_drain"];

function handlers(config:Parameters<typeof createSuperagentMcpServer>[0]){
  const server=createSuperagentMcpServer(config);
  const map=(server as any)._requestHandlers;
  return {server,list:map.get(ListToolsRequestSchema.shape.method.value),
    call:map.get(CallToolRequestSchema.shape.method.value)};
}
afterEach(()=>{setFullYoloMode(false);setYoloMode(false);});
describe("Core MCP control: independent auth, gateway, supervisor guard",()=>{
  it("has five classified tools and write-scope for mutating calls",()=>{
    for(const name of names) expect(MCP_TOOL_DEFINITIONS.some(t=>t.name===name)).toBe(true);
    expect(MCP_TOOL_CLASSIFICATION.superagent_core_status).toBe("safe");
    expect(MCP_TOOL_CLASSIFICATION.superagent_core_plan).toBe("safe");
    for(const name of names.slice(2)) {
      expect(MCP_TOOL_CLASSIFICATION[name]).toBe("dangerous");
      expect(getToolSecuritySchemes(name,"oauth")[0].scopes).toContain("mcp:tools:write");
    }
  });
  it("advertises status only with local YOLO off; dangerous tools remain hidden",async()=>{
    setYoloMode(false);
    const {server,list}=handlers({allowDangerous:true,toolExposure:"gateway"});
    try {
      const visible=(await list({method:"tools/list",params:{}})).tools.map((t:any)=>t.name);
      expect(visible).toContain(names[0]);
      for(const name of names.slice(2))expect(visible).not.toContain(name);
    } finally {await server.close();}
  });
  it("advertises all five direct gateway tools with authorized dangerous mode",async()=>{
    setYoloMode(true);
    const {server,list}=handlers({allowDangerous:true,toolExposure:"gateway"});
    try {
      const visible=(await list({method:"tools/list",params:{}})).tools.map((t:any)=>t.name);
      for(const name of names)expect(visible).toContain(name);
    } finally {await server.close();}
  });
  it("OAuth read-only principals cannot discover or execute Core restart",async()=>{
    setYoloMode(true);
    const {server,list,call}=handlers({
      allowDangerous:true,toolExposure:"gateway",authMode:"oauth",
      getIdentity:()=>({mode:"oauth",subject:"read-only",scopes:["mcp:tools"]}),
    });
    try {
      const visible=(await list({method:"tools/list",params:{}})).tools.map((t:any)=>t.name);
      expect(visible).toContain("superagent_core_status");
      expect(visible).not.toContain("superagent_core_restart");
      await expect(call({method:"tools/call",params:{
        name:"superagent_core_restart",arguments:{port:19997,confirm:true},
      }})).rejects.toThrow();
    } finally {await server.close();}
  });
  it("OAuth write principals may see Core lifecycle tools but still require confirmation",async()=>{
    setYoloMode(true);
    const {server,list,call}=handlers({
      allowDangerous:true,toolExposure:"gateway",authMode:"oauth",
      getIdentity:()=>({mode:"oauth",subject:"operator",scopes:["mcp:tools","mcp:tools:write"]}),
    });
    try {
      const visible=(await list({method:"tools/list",params:{}})).tools.map((t:any)=>t.name);
      expect(visible).toContain("superagent_core_restart");
      const result=await call({method:"tools/call",params:{
        name:"superagent_core_restart",arguments:{port:19997},
      }});
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain("CORE_OPERATION_PLAN_REQUIRED");
      const consent=await call({method:"tools/call",params:{
        name:"superagent_core_restart",
        arguments:{port:19997,operationId:"sample-operation-id-0001",expectedBuildDigest:"a".repeat(64)},
      }});
      expect(consent.isError).toBe(true);
      expect(JSON.stringify(consent)).toContain("CORE_CONTROL_CONFIRM_REQUIRED");
    } finally {await server.close();}
  });
  it("refuses mutation without confirm or supervised owner; never falls back to process kill",async()=>{
    setYoloMode(true);
    const {server,call}=handlers({allowDangerous:true,toolExposure:"full"});
    try {
      const denied=await call({method:"tools/call",params:{name:"superagent_core_restart",arguments:{port:19997,operationId:"sample-operation-id-0001",expectedBuildDigest:"a".repeat(64)}}});
      expect(denied.isError).toBe(true);
      expect(JSON.stringify(denied)).toContain("CORE_CONTROL_CONFIRM_REQUIRED");
      const missing=await call({method:"tools/call",params:{name:"superagent_core_restart",arguments:{port:19997,confirm:true,operationId:"sample-operation-id-0001",expectedBuildDigest:"a".repeat(64)}}});
      expect(missing.isError).toBe(true);
      expect(JSON.stringify(missing)).toContain("No supervised core");
      const bad=await call({method:"tools/call",params:{name:names[0],arguments:{port:"19997"}}});
      expect(bad.isError).toBe(true);
      expect(JSON.stringify(bad)).toContain("CORE_CONTROL_INVALID_PORT");
    } finally {await server.close();}
  });
  it("read-only status works with YOLO off and reports missing owner safely",async()=>{
    setYoloMode(false);
    const {server,call}=handlers({toolExposure:"gateway"});
    try {
      const result=await call({method:"tools/call",params:{name:names[0],arguments:{port:19997}}});
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain("No supervised core");
      await expect(call({method:"tools/call",params:{name:"superagent_core_restart",arguments:{port:19997,confirm:true,operationId:"sample-operation-id-0001",expectedBuildDigest:"a".repeat(64)}}}))
        .rejects.toThrow();
    } finally {await server.close();}
  });
});
