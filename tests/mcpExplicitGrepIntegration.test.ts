import {afterEach,describe,expect,it} from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {createSuperagentMcpServer} from "../src/core/mcp/superagentMcpServer.js";
import {identityOfSelf} from "../src/core/tools/registeredFileToolGate.js";
import {MCP_GATEWAY_TOOL_NAMES} from "../src/core/mcp/mcpToolGateway.js";

const invoke=async(server:ReturnType<typeof createSuperagentMcpServer>,name:string,args:Record<string,unknown>)=>
  (server as any)._requestHandlers.get("tools/call")({
    method:"tools/call",params:{name,arguments:args},
  });
describe("MCP explicit file grep enforces registered host denies end-to-end",()=>{
  let config:string|undefined,prior:string|undefined;
  afterEach(()=>{
    if(prior===undefined)delete process.env.SUPERAGENT_CONFIG_DIR;
    else process.env.SUPERAGENT_CONFIG_DIR=prior;
    if(config)fs.rmSync(config,{recursive:true,force:true});
  });
  it("allows one approved source and refuses the blocked file and recursive search",async()=>{
    prior=process.env.SUPERAGENT_CONFIG_DIR;
    config=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),"sa-mcp-grep-e2e-")));
    process.env.SUPERAGENT_CONFIG_DIR=config;
    const project=path.join(config,"workspace");fs.mkdirSync(project);
    fs.writeFileSync(path.join(project,"allowed.txt"),"PUBLIC_MARKER\nhello world\n");
    fs.writeFileSync(path.join(project,"blocked.txt"),"PRIVATE_MARKER\n");
    const app=identityOfSelf();
    expect(app).not.toBeNull();
    fs.writeFileSync(path.join(config,"desktop-access-registry.json"),JSON.stringify({
      version:2,defaultEffect:"deny",rules:[
        {id:"approved",kind:"file",effect:"allow",app,
          operations:["read"],scope:{path:project,recursive:true}},
        {id:"blocked",kind:"file",effect:"deny",app,
          operations:["read"],scope:{path:path.join(project,"blocked.txt"),recursive:false}},
      ],
    }));
    const identity={mode:"oauth" as const,subject:"explicit-grep-reader",scopes:["mcp:tools"]};
    const server=createSuperagentMcpServer({authMode:"oauth",toolExposure:"full",
      getIdentity:()=>identity,workspace:project});
    try{
      const safe=await invoke(server,"superagent_grep_search",{
        workspace:project,filePaths:["allowed.txt"],query:"PUBLIC_MARKER",
      });
      expect(safe.isError).not.toBe(true);
      expect(JSON.stringify(safe)).toContain("PUBLIC_MARKER");
      const prohibited=await invoke(server,"superagent_grep_search",{
        workspace:project,filePaths:["allowed.txt","blocked.txt"],query:"PRIVATE_MARKER",
      });
      expect(prohibited.isError).toBe(true);
      expect(JSON.stringify(prohibited)).toMatch(/denies read|Access denied/);
      expect(JSON.stringify(prohibited)).not.toContain("PRIVATE_MARKER");
      const recursive=await invoke(server,"superagent_grep_search",{
        workspace:project,path:".",query:"PRIVATE_MARKER",
      });
      expect(recursive.isError).toBe(true);
      expect(JSON.stringify(recursive)).toMatch(/Unmediated discovery/);
      const nested=await invoke(server,MCP_GATEWAY_TOOL_NAMES.execute,{
        name:"superagent_grep_search",
        arguments:{workspace:project,filePaths:["blocked.txt"],query:"PRIVATE_MARKER"},
      });
      expect(nested.isError).toBe(true);
      expect(JSON.stringify(nested)).not.toContain("PRIVATE_MARKER");
    }finally{await server.close();}
  });
});
