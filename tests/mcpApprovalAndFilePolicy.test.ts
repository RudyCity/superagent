import {afterEach,describe,expect,it} from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {createSuperagentMcpServer} from "../src/core/mcp/superagentMcpServer.js";
import {grantProjectAccess,revokeProjectAccess} from "../src/core/project/projectAccessPolicy.js";
import {MCP_CONNECTION_PROJECT_ID,listProjectAccessRequests} from "../src/core/project/projectAccessRequestStore.js";
import {onMcpActivity} from "../src/core/mcp/mcpActivityBus.js";

const invoke=async(server:ReturnType<typeof createSuperagentMcpServer>,name:string,args:Record<string,unknown>)=>
  (server as any)._requestHandlers.get("tools/call")({
    method:"tools/call",params:{name,arguments:args},
  });

describe("MCP Connection Controls independent from host file-policy certification",()=>{
  let prior:string|undefined;
  let isolated:string|undefined;
  afterEach(()=>{
    if(prior===undefined)delete process.env.SUPERAGENT_CONFIG_DIR;
    else process.env.SUPERAGENT_CONFIG_DIR=prior;
    if(isolated)fs.rmSync(isolated,{recursive:true,force:true});
    isolated=undefined;
  });

  it("requires explicit MCP execute grant, reflects immediate revoke and never consults chat YOLO",async()=>{
    prior=process.env.SUPERAGENT_CONFIG_DIR;
    isolated=fs.mkdtempSync(path.join(os.tmpdir(),"sa-mcp-v2-revoke-"));
    process.env.SUPERAGENT_CONFIG_DIR=isolated;
    fs.writeFileSync(path.join(isolated,"desktop-access-registry.json"),
      JSON.stringify({version:2,defaultEffect:"deny",rules:[]}));
    const identity={mode:"oauth" as const,subject:"file-policy-revoke-test",
      scopes:["mcp:tools","mcp:tools:write"]};
    const server=createSuperagentMcpServer({
      toolExposure:"full",authMode:"oauth",getIdentity:()=>identity,
      allowDangerous:true,
    });
    try{
      await expect(invoke(server,"superagent_desktop_ui",{command:"probe"}))
        .rejects.toThrow(/MCP_APPROVAL_REQUIRED/);
      grantProjectAccess(identity,MCP_CONNECTION_PROJECT_ID,["execute"]);
      const approved=await invoke(server,"superagent_desktop_ui",{command:"probe"});
      expect(JSON.stringify(approved)).not.toMatch(/MCP_APPROVAL_REQUIRED|permanent file policy/i);
      expect(revokeProjectAccess(identity,MCP_CONNECTION_PROJECT_ID)).toBe(true);
      await expect(invoke(server,"superagent_desktop_ui",{command:"probe"}))
        .rejects.toThrow(/MCP_APPROVAL_REQUIRED/);
    }finally{await server.close();}
  });

  it("preflights exact Desktop UI commands without executing or silently creating grants",async()=>{
    prior=process.env.SUPERAGENT_CONFIG_DIR;
    isolated=fs.mkdtempSync(path.join(os.tmpdir(),"sa-mcp-v2-preflight-"));
    process.env.SUPERAGENT_CONFIG_DIR=isolated;
    fs.writeFileSync(path.join(isolated,"desktop-access-registry.json"),
      JSON.stringify({version:2,defaultEffect:"deny",rules:[]}));
    const identity={mode:"oauth" as const,subject:"mcp-preflight-writer",
      scopes:["mcp:tools","mcp:tools:write"]};
    const auditRecords:string[]=[];
    const activityRecords:string[]=[];
    const unsubscribe=onMcpActivity((event)=>{
      if(event.tool==="superagent_tool_describe")activityRecords.push(JSON.stringify(event));
    });
    const server=createSuperagentMcpServer({toolExposure:"gateway",authMode:"oauth",
      getIdentity:()=>identity,allowDangerous:true,
      onToolCall:(event)=>{if(event.tool==="superagent_tool_describe")auditRecords.push(JSON.stringify(event));}});
    const describe=async(checkArguments:Record<string,unknown>)=>{
      const response=await invoke(server,"superagent_tool_describe",{
        name:"superagent_desktop_ui",checkArguments,
      });
      expect(response.isError).not.toBe(true);
      return JSON.parse(response.content[0].text).permissionPreflight;
    };
    try {
      const metadata=await describe({command:"probe"});
      expect(metadata.hostFilePolicy).toMatchObject({active:true,decision:"eligible",reasonCode:null});
      expect(metadata.mcpConnectionExecute.decision).toBe("approval_required");
      expect(metadata.performedExecution).toBe(false);
      const protectedUi=await describe({command:"inspect_window",pid:5344,nativeId:"123",
        title:"SECRET_DO_NOT_ECHO"});
      expect(protectedUi.hostFilePolicy).toMatchObject({
        active:true,decision:"blocked",reasonCode:"not_certified_or_denied",
      });
      expect(JSON.stringify(protectedUi)).not.toContain("SECRET_DO_NOT_ECHO");
      expect(JSON.stringify(auditRecords)).not.toContain("SECRET_DO_NOT_ECHO");
      expect(JSON.stringify(activityRecords)).not.toContain("SECRET_DO_NOT_ECHO");
      expect(activityRecords.at(-1)).toContain("TOOL_PERMISSION_PREFLIGHT_REDACTED");
      const badShape=await describe({command:"inspect_security_prompts",limit:10});
      expect(badShape.hostFilePolicy.reasonCode).toBe("unsupported_arguments");
      const validPrompts=await describe({command:"inspect_security_prompts"});
      expect(validPrompts.hostFilePolicy.decision).toBe("eligible");
      const approvedRequests=listProjectAccessRequests({status:"pending",projectId:MCP_CONNECTION_PROJECT_ID});
      expect(approvedRequests).toHaveLength(0);
      grantProjectAccess(identity,MCP_CONNECTION_PROJECT_ID,["execute"]);
      expect((await describe({command:"probe"})).mcpConnectionExecute.decision).toBe("granted");
      expect((await describe({command:"open",pid:5344,nativeId:"123",allowInput:false}))
        .hostFilePolicy.decision).toBe("blocked");
      expect(revokeProjectAccess(identity,MCP_CONNECTION_PROJECT_ID)).toBe(true);
      expect((await describe({command:"probe"})).mcpConnectionExecute.decision).toBe("approval_required");
      expect(listProjectAccessRequests({status:"pending",projectId:MCP_CONNECTION_PROJECT_ID})).toHaveLength(0);
      const invalid=await invoke(server,"superagent_tool_describe",{
        name:"superagent_desktop_ui",checkArguments:[],
      });
      expect(invalid.isError).toBe(true);
      const unavailable=await invoke(server,"superagent_tool_describe",{
        name:"superagent_server_health",checkArguments:{command:"probe"},
      });
      expect(unavailable.isError).toBe(true);
    }finally{unsubscribe();await server.close();}
  });

  it("OAuth read-only identities cannot execute approved host-file-safe desktop metadata",async()=>{
    prior=process.env.SUPERAGENT_CONFIG_DIR;
    isolated=fs.mkdtempSync(path.join(os.tmpdir(),"sa-mcp-v2-readonly-"));
    process.env.SUPERAGENT_CONFIG_DIR=isolated;
    fs.writeFileSync(path.join(isolated,"desktop-access-registry.json"),
      JSON.stringify({version:2,defaultEffect:"deny",rules:[]}));
    const identity={mode:"oauth" as const,subject:"readonly-metadata-test",scopes:["mcp:tools"]};
    grantProjectAccess(identity,MCP_CONNECTION_PROJECT_ID,["execute"]);
    const server=createSuperagentMcpServer({toolExposure:"full",
      authMode:"oauth",getIdentity:()=>identity,allowDangerous:true});
    try {
      await expect(invoke(server,"superagent_desktop_ui",{command:"probe"}))
        .rejects.toThrow(/mcp:tools:write/);
      // A read-only principal cannot inspect the authorization state or
      // schema of a dangerous tool through an optional metadata preflight.
      const hidden=await invoke(server,"superagent_tool_describe",{
        name:"superagent_desktop_ui",checkArguments:{command:"probe"},
      });
      expect(hidden.isError).toBe(true);
      expect(JSON.stringify(hidden)).not.toContain("mcpConnectionExecute");
    }finally{await server.close();}
  });
});
