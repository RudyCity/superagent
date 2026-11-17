import {afterEach,describe,expect,it} from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StreamableHTTPClientTransport} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {startMcpHttpServer,generateMcpBearerToken} from "../src/core/mcp/mcpHttpTransport.js";
import {MCP_GATEWAY_TOOL_NAMES} from "../src/core/mcp/mcpToolGateway.js";

describe("isolated MCP HTTP runtime policy smoke (NOT an installed host)",()=>{
  let previous:string|undefined;
  let directory:string|undefined;
  afterEach(()=>{
    if(previous===undefined)delete process.env.SUPERAGENT_CONFIG_DIR;
    else process.env.SUPERAGENT_CONFIG_DIR=previous;
    if(directory)fs.rmSync(directory,{recursive:true,force:true});
  });
  it("advertises independent approval and file-policy readiness over authenticated HTTP",async()=>{
    previous=process.env.SUPERAGENT_CONFIG_DIR;
    directory=fs.mkdtempSync(path.join(os.tmpdir(),"sa-mcp-http-policy-"));
    process.env.SUPERAGENT_CONFIG_DIR=directory;
    fs.writeFileSync(path.join(directory,"desktop-access-registry.json"),
      JSON.stringify({version:2,defaultEffect:"deny",rules:[]}));
    const token=generateMcpBearerToken();
    const server=await startMcpHttpServer({port:0,bearerToken:token,
      allowDangerous:false,toolExposure:"gateway"});
    const client=new Client({name:"mcp-policy-staging-test",version:"1.0.0"},
      {capabilities:{}});
    try{
      await client.connect(new StreamableHTTPClientTransport(new URL(server.url),{
        requestInit:{headers:{Authorization:"Bearer "+token}},
      }));
      const {tools}=await client.listTools();
      const search=tools.find(x=>x.name===MCP_GATEWAY_TOOL_NAMES.search);
      expect(search?._meta?.filePolicy).toMatchObject({active:true});
      expect(search?._meta?.mcpApproval).toMatchObject({kind:"read_only"});
      const gateway=tools.find(x=>x.name===MCP_GATEWAY_TOOL_NAMES.execute);
      expect(gateway?._meta?.mcpApproval).toMatchObject({kind:"target_dependent"});
      const describe=await client.callTool({name:MCP_GATEWAY_TOOL_NAMES.describe,
        arguments:{name:"superagent_grep_search"}});
      const json=JSON.parse((describe.content as any[])[0].text);
      expect(json.filePolicy).toBe("action_dependent");
      expect(json.mcpApproval).toMatchObject({kind:"project",capability:"read"});
      const status=await client.callTool({name:MCP_GATEWAY_TOOL_NAMES.status,arguments:{}});
      const readiness=JSON.parse((status.content as any[])[0].text);
      expect(readiness.filePolicy.active).toBe(true);
      expect(readiness.filePolicy.readinessCounts.uncertified).toBeGreaterThan(0);
      expect(JSON.stringify(readiness)).not.toContain(token);
    }finally{
      await client.close().catch(()=>undefined);
      await server.close();
    }
  },30000);
});
