import {afterAll,beforeAll,describe,expect,it} from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {buildTrayToolInventory} from "../src/core/mcp/mcpTrayToolInventory.js";
import {MCP_TOOL_DEFINITIONS} from "../src/core/mcp/superagentMcpServer.js";
import {DISABLED_MCP_TOOLS} from "../src/core/mcp/mcpToolPolicy.js";
import {registerProject} from "../src/core/project/projectRegistry.js";
import {grantProjectAccess,revokeProjectAccess} from "../src/core/project/projectAccessPolicy.js";
import {recordMcpIdentityPresence,clearMcpIdentityPresence} from "../src/core/mcp/mcpIdentityPresence.js";

describe("local-operator MCP full tool inventory authorization read model",()=>{
  const oldConfig=process.env.SUPERAGENT_CONFIG_DIR;
  const sandbox=fs.mkdtempSync(path.join(os.tmpdir(),"sa-tray-tool-catalog-"));
  const projectRoot=path.join(sandbox,"repository");
  const identity={mode:"oauth" as const,subject:"tray-tool-inventory-owner",scopes:["mcp:tools","mcp:tools:write"]};
  let handle="";
  beforeAll(()=>{
    process.env.SUPERAGENT_CONFIG_DIR=sandbox;
    fs.mkdirSync(projectRoot,{recursive:true});
    fs.writeFileSync(path.join(sandbox,"desktop-access-registry.json"),
      JSON.stringify({version:2,defaultEffect:"deny",rules:[]}));
    registerProject({id:"inventory-fixture",name:"Inventory fixture",type:"local",root:projectRoot});
    handle=recordMcpIdentityPresence(identity).identityHandle;
  });
  afterAll(()=>{
    clearMcpIdentityPresence();
    if(oldConfig===undefined)delete process.env.SUPERAGENT_CONFIG_DIR;
    else process.env.SUPERAGENT_CONFIG_DIR=oldConfig;
    fs.rmSync(sandbox,{recursive:true,force:true});
  });

  const find=(data:ReturnType<typeof buildTrayToolInventory>,name:string)=>{
    const tool=data.tools.find(item=>item.name===name);
    expect(tool,name).toBeDefined();
    return tool!;
  };

  it("lists all active tools exactly once with source-derived policies but never declares runtime execution",()=>{
    const result=buildTrayToolInventory();
    const active=MCP_TOOL_DEFINITIONS.filter(t=>!DISABLED_MCP_TOOLS.has(t.name));
    expect(result.scope).toBe("local_operator_advisory_catalog");
    expect(result.active).toBe(active.length);
    expect(result.active).toBeGreaterThanOrEqual(238);
    expect(result.disabled).toBe(DISABLED_MCP_TOOLS.size);
    expect(result.tools.map(t=>t.name).sort()).toEqual(active.map(t=>t.name).sort());
    expect(new Set(result.tools.map(t=>t.name)).size).toBe(result.active);
    expect(result.tools.every(t=>!Object.prototype.hasOwnProperty.call(t,"runnable"))).toBe(true);
    expect(result.hostPolicyActive).toBe(true);
    expect(result.counts.hostBlocked).toBeGreaterThan(0);
    const terminal=find(result,"superagent_exec_command");
    expect(terminal).toMatchObject({
      approvalKind:"project",capability:"execute",hostBlocked:true,
      hostReadiness:"uncertified",grantState:"choose_identity_project",
      operationStatus:"host_uncertified",
    });
    expect(terminal.oauthScopesRequired).toContain("mcp:tools:write");
    expect(find(result,"superagent_tool_execute").approvalKind).toBe("target_dependent");
    expect(find(result,"superagent_register_project").approvalKind).toBe("operator_admin");
    expect(find(result,"superagent_request_project_access").approvalKind).toBe("request_only");
    expect(find(result,"superagent_lan_capabilities").approvalKind).toBe("read_only");
    expect(find(result,"superagent_git_action").capabilitiesByAction)
      .toMatchObject({status:"read",diff:"read",commit:"git",clean:"git"});
    expect(result.note).toMatch(/runtime/i);
    expect(JSON.stringify(result)).not.toContain(projectRoot);
  });

  it("distinguishes missing, granted, revoked, and unknown identity/project without elevating host rights",()=>{
    const selection={identityHandle:handle,projectId:"inventory-fixture"};
    expect(find(buildTrayToolInventory(selection),"superagent_exec_command").grantState).toBe("missing");
    grantProjectAccess(identity,"inventory-fixture",["read","execute"]);
    try{
      const allowed=buildTrayToolInventory(selection);
      expect(allowed.grantedCapabilities).toEqual(expect.arrayContaining(["read","execute"]));
      const terminal=find(allowed,"superagent_exec_command");
      expect(terminal.grantState).toBe("granted");
      expect(terminal.hostBlocked).toBe(true); // A project Execute grant does not certify shell.
      const files=find(allowed,"superagent_read_files");
      expect(files.grantState).toBe("granted");
      expect(files.operationStatus).toBe("file_rules_required");
      expect(find(allowed,"superagent_write_files").grantState).toBe("missing");
      expect(find(allowed,"superagent_git_action").grantState).toBe("action_dependent");
      const unknown=buildTrayToolInventory({identityHandle:"idh_aaaaaaaaaaaaaaaa",projectId:"inventory-fixture"});
      expect(find(unknown,"superagent_exec_command").grantState).toBe("identity_unavailable");
      const missingProject=buildTrayToolInventory({identityHandle:handle,projectId:"missing"});
      expect(find(missingProject,"superagent_exec_command").grantState).toBe("project_unavailable");
    }finally{revokeProjectAccess(identity,"inventory-fixture");}
    expect(find(buildTrayToolInventory(selection),"superagent_exec_command").grantState).toBe("missing");
  });

  it("fails closed when the project grant store is malformed",()=>{
    const policyPath=path.join(sandbox,"project-access.json");
    fs.writeFileSync(policyPath,"{bad JSON", "utf8");
    try{
      const result=buildTrayToolInventory({identityHandle:handle,projectId:"inventory-fixture"});
      expect(result.permissionStoreAvailable).toBe(false);
      expect(result.grantedCapabilities).toEqual([]);
      expect(find(result,"superagent_exec_command").grantState).toBe("policy_unavailable");
    }finally{fs.rmSync(policyPath,{force:true});}
  });
});
