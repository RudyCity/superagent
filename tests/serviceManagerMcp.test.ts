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
  it("shows service manager to write-scope callers and checks confirmations",async()=>{
    const {server,list,call}=handlers(["mcp:tools","mcp:tools:write"],true);
    try {
      const names=(await list({method:"tools/list",params:{}})).tools.map((x:any)=>x.name);
      expect(names).toContain("superagent_manage_services");
      const inventory=await call({method:"tools/call",params:{
        name:"superagent_manage_services",arguments:{action:"status",service:"tray"},
      }});
      expect(inventory.isError).not.toBe(true);
      expect(JSON.stringify(inventory)).toContain("tray");
      const refused=await call({method:"tools/call",params:{
        name:"superagent_manage_services",
        arguments:{action:"restart",service:"mcp",port:19997,confirm:true},
      }});
      expect(refused.isError).toBe(true);
      expect(JSON.stringify(refused)).toContain("SERVICE_UNSUPPORTED_MUTATION");
    } finally {await server.close();}
  });
  it("remains hidden with local YOLO disabled despite OAuth write scopes",async()=>{
    const {server,list}=handlers(["mcp:tools","mcp:tools:write"],false);
    try {
      const names=(await list({method:"tools/list",params:{}})).tools.map((x:any)=>x.name);
      expect(names).not.toContain("superagent_manage_services");
    } finally {await server.close();}
  });
});
