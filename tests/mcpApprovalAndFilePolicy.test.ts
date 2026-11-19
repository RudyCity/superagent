import {afterEach,describe,expect,it} from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {createSuperagentMcpServer,MCP_TOOL_DEFINITIONS} from "../src/core/mcp/superagentMcpServer.js";
import {grantProjectAccess,revokeProjectAccess} from "../src/core/project/projectAccessPolicy.js";
import {listProjectAccessRequests} from "../src/core/project/projectAccessRequestStore.js";
import {registerProject} from "../src/core/project/projectRegistry.js";
const TEST_PROJECT_ID="permission-test";
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
    registerProject({id:TEST_PROJECT_ID,name:"Permission test project",type:"local",root:isolated});
    fs.writeFileSync(path.join(isolated,"desktop-access-registry.json"),
      JSON.stringify({version:2,defaultEffect:"deny",rules:[]}));
    const identity={mode:"oauth" as const,subject:"file-policy-revoke-test",
      scopes:["mcp:tools","mcp:tools:write"]};
    const server=createSuperagentMcpServer({workspace:isolated,
      toolExposure:"full",authMode:"oauth",getIdentity:()=>identity,
      allowDangerous:true,
    });
    try{
      await expect(invoke(server,"superagent_desktop_ui",{command:"probe"}))
        .rejects.toThrow(/PROJECT_GRANT_MISSING/);
      grantProjectAccess(identity,TEST_PROJECT_ID,["execute"]);
      const approved=await invoke(server,"superagent_desktop_ui",{command:"probe"});
      expect(JSON.stringify(approved)).not.toMatch(/PROJECT_GRANT_MISSING|permanent file policy/i);
      expect(revokeProjectAccess(identity,TEST_PROJECT_ID)).toBe(true);
      await expect(invoke(server,"superagent_desktop_ui",{command:"probe"}))
        .rejects.toThrow(/PROJECT_GRANT_MISSING/);
    }finally{await server.close();}
  });

  it.each([false,true])("denies host-blocked Desktop UI before requesting Execute (gateway=%s)",async gateway=>{
    prior=process.env.SUPERAGENT_CONFIG_DIR;
    isolated=fs.mkdtempSync(path.join(os.tmpdir(),"sa-mcp-host-first-"));
    process.env.SUPERAGENT_CONFIG_DIR=isolated;
    registerProject({id:TEST_PROJECT_ID,name:"Permission test project",type:"local",root:isolated});
    fs.writeFileSync(path.join(isolated,"desktop-access-registry.json"),
      JSON.stringify({version:2,defaultEffect:"deny",rules:[]}));
    const identity={mode:"oauth" as const,subject:"host-before-connection",
      scopes:["mcp:tools","mcp:tools:write"]};
    const audits:string[]=[];
    const activity:string[]=[];
    const unsubscribe=onMcpActivity(event=>activity.push(JSON.stringify(event)));
    const server=createSuperagentMcpServer({workspace:isolated,toolExposure:"gateway",authMode:"oauth",
      getIdentity:()=>identity,allowDangerous:true,onToolCall:event=>audits.push(JSON.stringify(event))});
    const sentinel="PRIVATE_WINDOW_AND_PROJECT_DO_NOT_ECHO";
    try{
      for(const args of [
        {command:"inspect_window",pid:5344,nativeId:"123",title:sentinel},
        {command:"open",pid:5344,nativeId:"123",allowInput:false},
        {command:"inspect_security_prompts",limit:10,projectId:sentinel},
      ]){
        const described=await invoke(server,"superagent_tool_describe",{
          name:"superagent_desktop_ui",checkArguments:args,
        });
        const preflight=JSON.parse(described.content[0].text).permissionPreflight;
        expect(["HOST_FILE_POLICY_UNCERTIFIED","SCHEMA_INVALID"]).toContain(preflight.decisionCode);
        const auditStart=audits.length,activityStart=activity.length;
        let denied;
        try{denied=await invoke(server,gateway?"superagent_tool_execute":"superagent_desktop_ui",
          gateway?{name:"superagent_desktop_ui",arguments:args}:args);}
        catch(error){denied={isError:true,content:[{text:error instanceof Error?error.message:String(error)}]};}
        expect(denied.isError).toBe(true);
        expect(JSON.stringify(denied)).toContain(preflight.decisionCode);
        expect(JSON.stringify(denied)).not.toContain("PROJECT_GRANT_MISSING");
        expect(listProjectAccessRequests({status:"pending",projectId:TEST_PROJECT_ID})).toHaveLength(0);
        for(const output of [JSON.stringify(denied),JSON.stringify(audits.slice(auditStart)),JSON.stringify(activity.slice(activityStart))]){
          expect(output).not.toContain(sentinel);
          expect(output).not.toContain(isolated);
        }
      }
    }finally{unsubscribe();await server.close();}
  });

  it.each(["readonly","safe_owner"] as const)("keeps host diagnostic state hidden from %s callers",async mode=>{
    prior=process.env.SUPERAGENT_CONFIG_DIR;
    isolated=fs.mkdtempSync(path.join(os.tmpdir(),"sa-mcp-hidden-host-"));
    process.env.SUPERAGENT_CONFIG_DIR=isolated;
    registerProject({id:TEST_PROJECT_ID,name:"Permission test project",type:"local",root:isolated});
    fs.writeFileSync(path.join(isolated,"desktop-access-registry.json"),
      JSON.stringify({version:2,defaultEffect:"deny",rules:[]}));
    const identity={mode:"oauth" as const,subject:"hidden-host-client",
      scopes:mode==="readonly"?["mcp:tools"]:["mcp:tools","mcp:tools:write"]};
    const server=createSuperagentMcpServer({workspace:isolated,toolExposure:"gateway",authMode:"oauth",getIdentity:()=>identity,
      ...(mode==="safe_owner"?{lockSafeTools:true,allowDangerous:false,
        allowedTools:["superagent_tool_describe","superagent_tool_execute","superagent_services_status"]}:{allowDangerous:true})});
    try{
      for(const gateway of [false,true]){
        let response;
        try{response=await invoke(server,gateway?"superagent_tool_execute":"superagent_desktop_ui",
          gateway?{name:"superagent_desktop_ui",arguments:{command:"inspect_window"}}:{command:"inspect_window"});}
        catch(error){response={isError:true,content:[{text:error instanceof Error?error.message:String(error)}]};}
        expect(response.isError).toBe(true);
        expect(JSON.stringify(response)).not.toMatch(/HOST_FILE_POLICY_UNCERTIFIED|SCHEMA_INVALID|permanent file policy|mcpProjectExecute/);
      }
      expect(listProjectAccessRequests({status:"pending",projectId:TEST_PROJECT_ID})).toHaveLength(0);
    }finally{await server.close();}
  });

  it.each([
    {mode:"owner",gateway:false},{mode:"owner",gateway:true},
    {mode:"scope",gateway:false},{mode:"scope",gateway:true},
  ])("redacts unvalidated $mode denial metadata (gateway=$gateway)",async({mode,gateway})=>{
    prior=process.env.SUPERAGENT_CONFIG_DIR;
    isolated=fs.mkdtempSync(path.join(os.tmpdir(),"sa-mcp-denial-private-"));
    process.env.SUPERAGENT_CONFIG_DIR=isolated;
    registerProject({id:TEST_PROJECT_ID,name:"Permission test project",type:"local",root:isolated});
    const sentinel="PRIVATE_TITLE_PAYLOAD_AND_PROJECT_DO_NOT_ECHO";
    const privatePath=path.join(isolated,sentinel);
    const identity={mode:"oauth" as const,subject:"private-denial-client",
      scopes:mode==="scope"?[]:["mcp:tools","mcp:tools:write"]};
    const audits:any[]=[];
    const activity:any[]=[];
    const unsubscribe=onMcpActivity(event=>activity.push(event));
    const server=createSuperagentMcpServer({workspace:isolated,toolExposure:"gateway",authMode:"oauth",
      getIdentity:()=>identity,onToolCall:event=>audits.push(event),
      ...(mode==="owner"?{allowedTools:["superagent_services_status"]}:{})});
    const args={command:"inspect_window",title:sentinel,cwd:privatePath,projectId:privatePath,
      payload:{text:sentinel}};
    try{
      let response;
      try{response=await invoke(server,gateway?"superagent_tool_execute":"superagent_desktop_ui",
        gateway?{name:"superagent_desktop_ui",arguments:args,cwd:privatePath,projectId:privatePath}:args);}
      catch(error){response={isError:true,content:[{text:error instanceof Error?error.message:String(error)}]};}
      expect(response.isError).toBe(true);
      expect(audits).toHaveLength(1);
      expect(activity).toHaveLength(1);
      for(const output of [JSON.stringify(response),JSON.stringify(audits),JSON.stringify(activity)]){
        expect(output).not.toContain(sentinel);
        expect(output).not.toContain(isolated);
      }
      expect(audits[0]).toMatchObject({args:{},authorizationDecision:"denied",projectId:null,providerKind:null,
        errorCode:mode==="owner"?"mcp_owner_allowlist_denied":"insufficient_oauth_scope"});
      expect(audits[0].principalHash).toMatch(/^[a-f0-9]{16}$/);
      expect(activity[0].args).toEqual({});
      expect(activity[0].workspace).toBe("mcp://authorization");
      expect(listProjectAccessRequests({status:"pending",projectId:TEST_PROJECT_ID})).toHaveLength(0);
    }finally{unsubscribe();await server.close();}
  });

  it.each(["readonly","safe_owner"] as const)("rejects recursive gateways without exposing host state to %s callers",async mode=>{
    prior=process.env.SUPERAGENT_CONFIG_DIR;
    isolated=fs.mkdtempSync(path.join(os.tmpdir(),"sa-mcp-recursive-private-"));
    process.env.SUPERAGENT_CONFIG_DIR=isolated;
    registerProject({id:TEST_PROJECT_ID,name:"Permission test project",type:"local",root:isolated});
    const registry=path.join(isolated,"desktop-access-registry.json");
    const sentinel="PRIVATE_RECURSIVE_TITLE_AND_PAYLOAD";
    const privatePath=path.join(isolated,sentinel);
    const audits:any[]=[];
    const activity:any[]=[];
    const unsubscribe=onMcpActivity(event=>activity.push(event));
    const identity={mode:"oauth" as const,subject:"recursive-boundary-client",
      scopes:mode==="readonly"?["mcp:tools"]:["mcp:tools","mcp:tools:write"]};
    const server=createSuperagentMcpServer({workspace:isolated,toolExposure:"gateway",authMode:"oauth",
      getIdentity:()=>identity,onToolCall:event=>audits.push(event),
      ...(mode==="safe_owner"?{lockSafeTools:true,allowDangerous:false,
        allowedTools:["superagent_tool_describe","superagent_tool_execute","superagent_services_status"]}:{})});
    const outputs:string[]=[];
    try{
      for(const active of [false,true]){
        if(active)fs.writeFileSync(registry,JSON.stringify({version:2,defaultEffect:"deny",rules:[]}));
        const auditStart=audits.length,activityStart=activity.length;
        const denied=await invoke(server,"superagent_tool_execute",{name:"superagent_tool_execute",
          arguments:{name:"superagent_desktop_ui",arguments:{command:"inspect_window",title:sentinel,
            cwd:privatePath,projectId:privatePath,payload:{text:sentinel}}}});
        expect(denied.isError).toBe(true);
        const output=JSON.stringify(denied);
        outputs.push(output);
        expect(output).not.toMatch(/HOST_FILE_POLICY_UNCERTIFIED|SCHEMA_INVALID|permanent file policy|mcpProjectExecute/);
        const newAudits=audits.slice(auditStart),newActivity=activity.slice(activityStart);
        expect(newAudits).toHaveLength(1);
        expect(newActivity).toHaveLength(1);
        for(const serialized of [output,JSON.stringify(newAudits),JSON.stringify(newActivity)]){
          expect(serialized).not.toContain(sentinel);
          expect(serialized).not.toContain(isolated);
        }
        expect(newAudits[0]).toMatchObject({args:{},projectId:null,providerKind:null,
          authorizationDecision:"denied",errorCode:"gateway_target_unavailable"});
        expect(newActivity[0].workspace).toBe("mcp://authorization");
        expect(listProjectAccessRequests({status:"pending",projectId:TEST_PROJECT_ID})).toHaveLength(0);
      }
      expect(outputs[0]).toBe(outputs[1]);
    }finally{unsubscribe();await server.close();}
  });

  it("preflights exact Desktop UI commands without executing or silently creating grants",async()=>{
    prior=process.env.SUPERAGENT_CONFIG_DIR;
    isolated=fs.mkdtempSync(path.join(os.tmpdir(),"sa-mcp-v2-preflight-"));
    process.env.SUPERAGENT_CONFIG_DIR=isolated;
    registerProject({id:TEST_PROJECT_ID,name:"Permission test project",type:"local",root:isolated});
    fs.writeFileSync(path.join(isolated,"desktop-access-registry.json"),
      JSON.stringify({version:2,defaultEffect:"deny",rules:[]}));
    const identity={mode:"oauth" as const,subject:"mcp-preflight-writer",
      scopes:["mcp:tools","mcp:tools:write"]};
    const auditRecords:string[]=[];
    const activityRecords:string[]=[];
    const unsubscribe=onMcpActivity((event)=>{
      if(event.tool==="superagent_tool_describe")activityRecords.push(JSON.stringify(event));
    });
    const server=createSuperagentMcpServer({workspace:isolated,toolExposure:"gateway",authMode:"oauth",
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
      expect(metadata.mcpProjectExecute.decision).toBe("approval_required");
      expect(metadata.performedExecution).toBe(false);
      expect(metadata.decisionCode).toBe("PROJECT_CAPABILITY_MISSING");
      expect(metadata.layers).toMatchObject({
        oauthScope:"granted",projectCapability:"blocked",hostFilePolicy:"granted",
        nativeConsent:"not_checked",targetIdentity:"not_checked",
      });
      const protectedUi=await describe({command:"inspect_window",pid:5344,nativeId:"123",
        title:"SECRET_DO_NOT_ECHO"});
      expect(protectedUi.hostFilePolicy).toMatchObject({
        active:true,decision:"blocked",reasonCode:"not_certified_or_denied",
      });
      expect(protectedUi.decisionCode).toBe("HOST_FILE_POLICY_UNCERTIFIED");
      expect(protectedUi.remediation).toMatch(/cannot override/);
      expect(JSON.stringify(protectedUi)).not.toContain("SECRET_DO_NOT_ECHO");
      expect(JSON.stringify(auditRecords)).not.toContain("SECRET_DO_NOT_ECHO");
      expect(JSON.stringify(activityRecords)).not.toContain("SECRET_DO_NOT_ECHO");
      expect(activityRecords.at(-1)).toContain("TOOL_PERMISSION_PREFLIGHT_REDACTED");
      const badShape=await describe({command:"inspect_security_prompts",limit:10});
      expect(badShape.hostFilePolicy.reasonCode).toBe("unsupported_arguments");
      expect(badShape.decisionCode).toBe("SCHEMA_INVALID");
      const validPrompts=await describe({command:"inspect_security_prompts"});
      expect(validPrompts.hostFilePolicy.decision).toBe("eligible");
      const approvedRequests=listProjectAccessRequests({status:"pending",projectId:TEST_PROJECT_ID});
      expect(approvedRequests).toHaveLength(0);
      grantProjectAccess(identity,TEST_PROJECT_ID,["execute"]);
      expect((await describe({command:"probe"})).mcpProjectExecute.decision).toBe("granted");
      expect((await describe({command:"probe"})).decisionCode).toBe("ALLOWED_TO_ATTEMPT");
      expect((await describe({command:"open",pid:5344,nativeId:"123",allowInput:false}))
        .hostFilePolicy.decision).toBe("blocked");
      expect(revokeProjectAccess(identity,TEST_PROJECT_ID)).toBe(true);
      expect((await describe({command:"probe"})).mcpProjectExecute.decision).toBe("approval_required");
      expect(listProjectAccessRequests({status:"pending",projectId:TEST_PROJECT_ID})).toHaveLength(0);
      fs.writeFileSync(path.join(isolated,"project-access.json"),"{invalid_private_policy_path");
      const unavailable=await describe({command:"probe"});
      expect(unavailable.mcpProjectExecute.decision).toBe("unavailable");
      expect(unavailable.decisionCode).toBe("POLICY_STORE_UNAVAILABLE");
      expect(JSON.stringify(unavailable)).not.toContain(isolated);
      // The read-only service probe is schema-only and never uses project
      // access or native process inspection to report its argument verdict.
      const service=await invoke(server,"superagent_tool_describe",{
        name:"superagent_services_status",
        checkArguments:{action:"owner_status",service:"tray"},
      });
      const servicePreflight=JSON.parse(service.content[0].text).permissionPreflight;
      expect(servicePreflight.decisionCode).toBe("ALLOWED_TO_ATTEMPT");
      expect(servicePreflight.mcpProjectExecute.decision).toBe("not_required");
      expect(servicePreflight.performedExecution).toBe(false);
      const badService=await invoke(server,"superagent_tool_describe",{
        name:"superagent_services_status",
        checkArguments:{action:"restart",secret:"DO_NOT_ECHO"},
      });
      const badPreflight=JSON.parse(badService.content[0].text).permissionPreflight;
      expect(badPreflight.decisionCode).toBe("SCHEMA_INVALID");
      const serviceSchema=MCP_TOOL_DEFINITIONS.find(tool=>tool.name==="superagent_services_status")!.inputSchema;
      expect(badPreflight.remediationActions).toEqual([{kind:"inspect_schema",tool:"superagent_services_status",
        fields:Object.keys(serviceSchema.properties??{}),requiresUserAction:true}]);
      expect(JSON.stringify(badService)).not.toContain("DO_NOT_ECHO");
      const invalid=await invoke(server,"superagent_tool_describe",{
        name:"superagent_desktop_ui",checkArguments:[],
      });
      expect(invalid.isError).toBe(true);
      const unsupportedTool=await invoke(server,"superagent_tool_describe",{
        name:"superagent_server_health",checkArguments:{command:"probe"},
      });
      expect(unsupportedTool.isError).toBe(true);
    }finally{unsubscribe();await server.close();}
  });

  it("OAuth read-only identities cannot execute approved host-file-safe desktop metadata",async()=>{
    prior=process.env.SUPERAGENT_CONFIG_DIR;
    isolated=fs.mkdtempSync(path.join(os.tmpdir(),"sa-mcp-v2-readonly-"));
    process.env.SUPERAGENT_CONFIG_DIR=isolated;
    registerProject({id:TEST_PROJECT_ID,name:"Permission test project",type:"local",root:isolated});
    fs.writeFileSync(path.join(isolated,"desktop-access-registry.json"),
      JSON.stringify({version:2,defaultEffect:"deny",rules:[]}));
    const identity={mode:"oauth" as const,subject:"readonly-metadata-test",scopes:["mcp:tools"]};
    grantProjectAccess(identity,TEST_PROJECT_ID,["execute"]);
    const server=createSuperagentMcpServer({workspace:isolated,toolExposure:"full",
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
      expect(JSON.stringify(hidden)).not.toContain("mcpProjectExecute");

      // Nor can a read-only principal probe dangerous tools via superagent_tool_execute
      // or superagent_tool_describe on superagent_tool_execute.
      const hiddenGatewayDescribe=await invoke(server,"superagent_tool_describe",{
        name:"superagent_tool_execute",
        checkArguments:{name:"superagent_desktop_ui",arguments:{command:"inspect_window"}},
      });
      expect(hiddenGatewayDescribe.isError).toBe(true);
      expect(JSON.stringify(hiddenGatewayDescribe)).not.toMatch(/permanent file|mcpProjectExecute/i);

      const oracleProbe=await invoke(server,"superagent_tool_execute",{
        name:"superagent_desktop_ui",
        arguments:{command:"inspect_window",pid:1234,nativeId:"567"},
      });
      expect(oracleProbe.isError).toBe(true);
      expect(oracleProbe.content[0].text).toBe("Target tool unavailable, unauthorized, or arguments invalid.");
      expect(JSON.stringify(oracleProbe)).not.toMatch(/permanent file policy|certified/i);

      // Read-only principal CAN preflight certified read-only Chrome observe metadata.
      const chromePreflightRes=await invoke(server,"superagent_tool_describe",{
        name:"superagent_chrome_cdp_observe",
        checkArguments:{command:"list_targets",transport:"delegate",delegateClientId:"client_1234"},
      });
      expect(chromePreflightRes.isError).not.toBe(true);
      expect(JSON.parse(chromePreflightRes.content[0].text).permissionPreflight.decisionCode).toBe("ALLOWED_TO_ATTEMPT");
    }finally{await server.close();}
  });

  it("maintains direct vs gateway parity, redacts nested payloads in audit, and isolates distinct OAuth principals",async()=>{
    prior=process.env.SUPERAGENT_CONFIG_DIR;
    isolated=fs.mkdtempSync(path.join(os.tmpdir(),"sa-mcp-v2-parity-"));
    process.env.SUPERAGENT_CONFIG_DIR=isolated;
    registerProject({id:TEST_PROJECT_ID,name:"Permission test project",type:"local",root:isolated});
    fs.writeFileSync(path.join(isolated,"desktop-access-registry.json"),
      JSON.stringify({version:2,defaultEffect:"deny",rules:[]}));
    const clientA={mode:"oauth" as const,subject:"client-alpha",scopes:["mcp:tools","mcp:tools:write"]};
    const clientB={mode:"oauth" as const,subject:"client-beta",scopes:["mcp:tools","mcp:tools:write"]};
    let activeIdentity=clientA;
    const audits:any[]=[];
    const activities:any[]=[];
    const unsubscribe=onMcpActivity((event)=>activities.push(event));
    const server=createSuperagentMcpServer({workspace:isolated,
      toolExposure:"gateway",authMode:"oauth",
      getIdentity:()=>activeIdentity,
      allowDangerous:true,
      onToolCall:(event)=>audits.push(event),
    });
    const secretTitle="SECRET_GATEWAY_TITLE_991";
    const secretPath="C:\\Users\\Private\\top-secret-file.env";
    try {
      // Preflight via superagent_desktop_ui returns machine-readable supportedFields
      // when schema arguments are invalid, and superagent_tool_execute cannot be described directly.
      const preflightRes=await invoke(server,"superagent_tool_describe",{
        name:"superagent_desktop_ui",
        checkArguments:{command:"inspect_security_prompts",limit:5},
      });
      const preflight=JSON.parse(preflightRes.content[0].text).permissionPreflight;
      expect(preflight.decisionCode).toBe("SCHEMA_INVALID");
      expect(preflight.remediationAction).toMatchObject({
        kind:"fix_arguments",
        supportedFields:["command","action"],
      });

      const describeExecute=await invoke(server,"superagent_tool_describe",{
        name:"superagent_tool_execute",
        checkArguments:{name:"superagent_desktop_ui",arguments:{command:"probe"}},
      });
      expect(describeExecute.isError).toBe(true);

      // Preflight for superagent_manage_services separates Execute requirement from uncertified mutations.
      const manageNeedsGrant=await invoke(server,"superagent_tool_describe",{
        name:"superagent_manage_services",
        checkArguments:{action:"owner_status",service:"tray"},
      });
      expect(JSON.parse(manageNeedsGrant.content[0].text).permissionPreflight.decisionCode)
        .toBe("PROJECT_CAPABILITY_MISSING");
      const manageUncertified=await invoke(server,"superagent_tool_describe",{
        name:"superagent_manage_services",
        checkArguments:{action:"restart",service:"tray",confirm:true},
      });
      expect(JSON.parse(manageUncertified.content[0].text).permissionPreflight.decisionCode)
        .toBe("HOST_FILE_POLICY_UNCERTIFIED");

      // Grant clientA only; clientB remains unapproved and isolated.
      grantProjectAccess(clientA,TEST_PROJECT_ID,["execute"]);
      const gwOk=await invoke(server,"superagent_tool_execute",{
        name:"superagent_desktop_ui",arguments:{command:"probe"},
      });
      expect(gwOk.isError).not.toBe(true);
      // Even when a certified query runs on headless CI (where find_window may return
      // DESKTOP_UI_UNAVAILABLE), nested caller queries never enter telemetry.
      await invoke(server,"superagent_tool_execute",{
        name:"superagent_desktop_ui",arguments:{command:"find_window",query:secretTitle,limit:5},
      });
      const gwInvalidProbe=await invoke(server,"superagent_tool_execute",{
        name:"superagent_desktop_ui",arguments:{command:"probe",title:secretTitle},
      });
      expect(gwInvalidProbe.isError).toBe(true);
      expect(gwInvalidProbe.content[0].text).toMatch(/unsupported arguments/);

      // ClientB with identical server cannot inherit clientA's grant.
      activeIdentity=clientB;
      await expect(invoke(server,"superagent_tool_execute",{
        name:"superagent_desktop_ui",arguments:{command:"probe"},
      })).rejects.toThrow(/PROJECT_GRANT_MISSING/);

      // ClientA loses grant between preflight and execute -> fails closed.
      activeIdentity=clientA;
      expect(revokeProjectAccess(clientA,TEST_PROJECT_ID)).toBe(true);
      await expect(invoke(server,"superagent_tool_execute",{
        name:"superagent_desktop_ui",arguments:{command:"probe"},
      })).rejects.toThrow(/PROJECT_GRANT_MISSING/);

      // Host file policy denial via gateway must not echo nested path in audit/activity.
      grantProjectAccess(clientA,TEST_PROJECT_ID,["execute"]);
      const deniedWrite=await invoke(server,"superagent_tool_execute",{
        name:"superagent_write_files",
        arguments:{files:[{filePath:secretPath,content:secretTitle}]},
      });
      expect(deniedWrite.isError).toBe(true);

      const serializedTelemetry=JSON.stringify([...audits,...activities]);
      expect(serializedTelemetry).not.toContain(secretTitle);
      expect(serializedTelemetry).not.toContain(secretPath);
    }finally{unsubscribe();await server.close();}
  });

  it("fails closed with a bounded store reason after preflight without leaking or creating an approval",async()=>{
    prior=process.env.SUPERAGENT_CONFIG_DIR;
    isolated=fs.mkdtempSync(path.join(os.tmpdir(),"sa-mcp-private-store-"));
    process.env.SUPERAGENT_CONFIG_DIR=isolated;
    registerProject({id:TEST_PROJECT_ID,name:"Permission test project",type:"local",root:isolated});
    fs.writeFileSync(path.join(isolated,"desktop-access-registry.json"),
      JSON.stringify({version:2,defaultEffect:"deny",rules:[]}));
    const identity={mode:"oauth" as const,subject:"store-recheck-writer",
      scopes:["mcp:tools","mcp:tools:write"]};
    grantProjectAccess(identity,TEST_PROJECT_ID,["execute"]);
    const records:string[]=[];
    const server=createSuperagentMcpServer({workspace:isolated,toolExposure:"gateway",authMode:"oauth",
      getIdentity:()=>identity,allowDangerous:true,
      onToolCall:(event)=>records.push(JSON.stringify(event))});
    const sentinel="PRIVATE_TOKEN_JSON_MUST_NOT_ESCAPE";
    const policy=path.join(isolated,"project-access.json");
    try {
      const preflight=await invoke(server,"superagent_tool_describe",{
        name:"superagent_desktop_ui",checkArguments:{command:"probe"},
      });
      expect(JSON.parse(preflight.content[0].text).permissionPreflight.decisionCode)
        .toBe("ALLOWED_TO_ATTEMPT");
      for(const invalid of ["{"+sentinel,JSON.stringify({schemaVersion:1,grants:[{secret:sentinel}]})]){
        fs.writeFileSync(policy,invalid);
        for(const gateway of [false,true]){
          let failure="";
          try {
            await invoke(server,gateway?"superagent_tool_execute":"superagent_desktop_ui",
              gateway?{name:"superagent_desktop_ui",arguments:{command:"probe"}}:{command:"probe"});
          }catch(error){failure=error instanceof Error?error.message:String(error);}
          expect(failure).toContain("POLICY_STORE_UNAVAILABLE");
          expect(failure).not.toContain(isolated);
          expect(failure).not.toContain(sentinel);
          expect(failure).not.toContain("PROJECT_GRANT_MISSING");
        }
        expect(fs.readFileSync(policy,"utf8")).toBe(invalid);
        expect(listProjectAccessRequests({status:"pending",projectId:TEST_PROJECT_ID})).toHaveLength(0);
      }
      expect(JSON.stringify(records)).not.toContain(sentinel);
      expect(JSON.stringify(records)).not.toContain(isolated);
      expect(records.some(record=>record.includes("policy_store_unavailable"))).toBe(true);
    }finally{await server.close();}
  });
});
