import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";
import { startMcpHttpServer, generateMcpBearerToken } from "../src/core/mcp/mcpHttpTransport.js";
import { canUnlockMcpDangerousTools, isR1OwnerToolCallAllowed,
  R1_OWNER_TOOLS } from "../src/core/mcp/mcpSafeOwnerPolicy.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stagingMcpOwnerHost } from "../src/core/runtime/mcpOwnerLifecycle.js";

describe("R1 immutable MCP permission ceiling",()=>{
  it("restricts workspace reads and prevents symlink escape even if global YOLO becomes full",()=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),"r1-safe-root-"));
    const outside=fs.mkdtempSync(path.join(os.tmpdir(),"r1-outside-"));
    try {
      const inside=path.join(root,"owned.txt");
      const foreign=path.join(outside,"foreign.txt");
      fs.writeFileSync(inside,"owner");
      fs.writeFileSync(foreign,"foreign");
      expect(R1_OWNER_TOOLS).not.toContain("superagent_list_projects");
      expect(R1_OWNER_TOOLS).not.toContain("superagent_get_config");
      expect(isR1OwnerToolCallAllowed("superagent_read_files",{files:["owned.txt"]},root)).toBe(true);
      expect(isR1OwnerToolCallAllowed("superagent_read_files",{files:[foreign]},root)).toBe(false);
      expect(isR1OwnerToolCallAllowed("superagent_read_files",{files:["../foreign.txt"]},root)).toBe(false);
      expect(isR1OwnerToolCallAllowed("superagent_get_workspace",{projectId:"another-project"},root)).toBe(false);
      expect(isR1OwnerToolCallAllowed("superagent_read_files",{files:["owned.txt"],workspace:outside},root)).toBe(false);
      expect(isR1OwnerToolCallAllowed("superagent_tool_execute",{name:"superagent_read_files",arguments:{files:[foreign]}},root)).toBe(true);
      // Recursion must check the underlying target, not the gateway envelope.
      expect(isR1OwnerToolCallAllowed("superagent_read_files",{files:[foreign]},root)).toBe(false);
      try {
        const link=path.join(root,"symlink.txt");
        fs.symlinkSync(foreign,link);
        expect(isR1OwnerToolCallAllowed("superagent_read_files",{files:["symlink.txt"]},root)).toBe(false);
      }catch(error) {
        if((error as NodeJS.ErrnoException).code!=="EPERM") throw error;
      }
    }finally{
      fs.rmSync(root,{recursive:true,force:true});
      fs.rmSync(outside,{recursive:true,force:true});
    }
  });
  it("cannot be overridden by global scoped or full YOLO",()=>{
    for(const yoloState of ["off","scoped","full"] as const) {
      expect(canUnlockMcpDangerousTools({lockSafeTools:true,allowDangerous:false,yoloState})).toBe(false);
    }
    expect(canUnlockMcpDangerousTools({lockSafeTools:false,allowDangerous:true,yoloState:"off"})).toBe(true);
    expect(canUnlockMcpDangerousTools({lockSafeTools:false,allowDangerous:false,yoloState:"full"})).toBe(true);
  });
  it("reuses ONE staging owner host for CLI status/start/drain/stop",()=>{
    expect(stagingMcpOwnerHost.mode).toBe("staging_safe_only");
    expect(stagingMcpOwnerHost.capabilities()).toMatchObject({
      version:1,gracefulDrain:true,safeToolsOnly:true,
      externalIngressAttachment:false,oauthIssuer:false,
    });
    expect(["status","start","drain","stop"].every(k=>
      typeof (stagingMcpOwnerHost as unknown as Record<string,unknown>)[k]==="function")).toBe(true);
  });
  it("rejects a request to combine safe lock and dangerous tool permission",async()=>{
    await expect(startMcpHttpServer({
      port:0,bearerToken:generateMcpBearerToken(),
      allowDangerous:true,lockSafeTools:true,
    })).rejects.toThrow(/Safe-only/);
  });
  it("rechecks nested gateway calls, including write/admin/execute, at execution",async()=>{
    const bearer=generateMcpBearerToken();
    const server=await startMcpHttpServer({
      port:0,bearerToken:bearer,allowDangerous:false,
      lockSafeTools:true,toolExposure:"gateway",
    });
    const client=new Client({name:"r1-safety-test",version:"1.0.0"},{capabilities:{}});
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(server.url),{
        requestInit:{headers:{Authorization:"Bearer "+bearer}},
      }));
      const capabilities=client.getServerCapabilities();
      expect(capabilities?.resources).toBeUndefined();
      expect(capabilities?.prompts).toBeUndefined();
      const names=(await client.listTools()).tools.map(t=>t.name);
      expect(names).toContain("superagent_tool_execute");
      expect(names).not.toContain("superagent_exec_command");
      const safe=await client.callTool({
        name:"superagent_tool_execute",
        arguments:{name:"superagent_server_health",arguments:{}},
      });
      expect(safe.isError).not.toBe(true);
      const deniedOutside=path.join(os.tmpdir(),"r1-external-read-"+Date.now()+".txt");
      fs.writeFileSync(deniedOutside,"SECRET_NOT_TO_LEAK_R1");
      try{
        const directRead=await client.callTool({name:"superagent_tool_execute",
          arguments:{name:"superagent_read_files",arguments:{files:[deniedOutside]}}})
          .catch(error=>({isError:true,content:[],error:String(error)}));
        expect(directRead.isError).toBe(true);
        expect(JSON.stringify(directRead)).not.toContain("SECRET_NOT_TO_LEAK_R1");
      }finally{fs.rmSync(deniedOutside,{force:true});}
      for(const name of ["superagent_exec_command","superagent_write_files","superagent_grant_project_access",
        "superagent_cross_workspace_exec","superagent_manage_worktrees"]){
        const result=await client.callTool({name:"superagent_tool_execute",
          arguments:{name,arguments:{}}})
          .catch(error=>({isError:true,error:String(error)}));
        expect(result.isError, "Denied via gateway: "+name).toBe(true);
      }
      const direct=await client.callTool({name:"superagent_exec_command",arguments:{command:"echo forbidden"}})
        .catch(e=>({isError:true, error:e}));
      expect(direct.isError).toBe(true);
    } finally {
      await client.close().catch(()=>{});
      await server.close();
    }
  },30000);
});
