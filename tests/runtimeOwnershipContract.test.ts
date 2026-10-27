import {describe,it,expect} from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {readMcpStateInventory} from "../src/core/runtime/coreMcpOwnershipAudit.js";
import {assessRuntimeOwnership,captureRuntimeOwnership,
  type RuntimeOwnershipEvidence} from "../src/core/runtime/runtimeOwnershipContract.js";
import type {McpStateInventory} from "../src/core/runtime/coreMcpOwnershipAudit.js";
const inventory:McpStateInventory={directory:"present",rejected:0,
  records:[{port:6789,pid:13424,authMode:"oauth"},
    {port:9877,pid:10060,authMode:"oauth"}]};
const connected=new Map([[7888,13424],[6789,13424],[9877,10060]]);
const base:RuntimeOwnershipEvidence={
  corePort:7888,listenerBefore:connected,listenerAfter:connected,
  stateInventory:inventory,authenticatedCore:null,
};
describe("R0 strict MCP state file inventory",()=>{
  it("ignores unrelated MCP configuration but reports malformed server registrations",()=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),"mcp-r0-state-"));
    try {
      fs.writeFileSync(path.join(dir,"mcp-tool-exposure.json"),JSON.stringify({mode:"gateway"}));
      fs.writeFileSync(path.join(dir,"mcp-6789.json"),JSON.stringify({
        port:6789,pid:12345,authMode:"oauth",
        publicUrl:"https://secret.example/mcp",workspace:"D:/sensitive",
      }));
      fs.writeFileSync(path.join(dir,"mcp-6792.json"),"{");
      fs.writeFileSync(path.join(dir,"mcp-6792-bad.json"),"{}");
      const result=readMcpStateInventory(dir);
      expect(result.directory).toBe("present");
      expect(result.records).toEqual([{port:6789,pid:12345,authMode:"oauth"}]);
      expect(result.rejected).toBe(2);
      expect(JSON.stringify(result)).not.toContain("secret.example");
      expect(JSON.stringify(result)).not.toContain("sensitive");
    }finally{fs.rmSync(dir,{recursive:true,force:true});}
  });
  it("distinguishes absent metadata from corrupt or untrusted directory",()=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),"mcp-r0-dir-"));
    try {
      expect(readMcpStateInventory(path.join(dir,"nonexistent")).directory).toBe("absent");
      const file=path.join(dir,"not-a-directory");
      fs.writeFileSync(file,"");
      expect(readMcpStateInventory(file)).toEqual({records:[],rejected:1,directory:"unverified"});
    }finally{fs.rmSync(dir,{recursive:true,force:true});}
  });
});
describe("R0 versioned runtime ownership contract",()=>{
 it("blocks live shared Core and MCP PID even when the Core is not supervised",async()=>{
  const r=await assessRuntimeOwnership(base);
  expect(r.schemaVersion).toBe(1);
  expect(r.ownershipTopology).toBe("shared_owner_do_not_cutover");
  expect(r.blockers).toContain("CORE_AND_MCP_SHARE_KERNEL_PID");
  expect(r.core.listenerPid).toBe(13424);
  expect(r.core.state).toBe("unverified");
  expect(r.mcp).toHaveLength(2);
  expect(r.mcp[0].authenticationVerified).toBe(false);
  expect(JSON.stringify(r)).not.toContain("oauth-client-secret");
  expect([r.canRestartCore,r.canStopMcp,r.canTransferOAuth,
    r.canMigrateSessions,r.automaticToolReplayAllowed,r.signalsSent,r.filesChanged])
    .toEqual([false,false,false,false,false,false,false]);
 });
 it("validates authenticated supervisor PID against kernel, not saved status alone",async()=>{
  const evidence={...base,
    listenerBefore:new Map([[7888,101],[6789,202]]),
    listenerAfter:new Map([[7888,101],[6789,202]]),
    stateInventory:{...inventory,records:[{port:6789,pid:202,authMode:"oauth" as const}]},
    authenticatedCore:{publicPort:7888,supervisorPid:999,activePid:888},
  };
  const r=await assessRuntimeOwnership(evidence);
  expect(r.core.state).toBe("identity_mismatch");
  expect(r.blockers).toContain("CORE_SUPERVISOR_PID_MISMATCH");
  expect(r.ownershipTopology).toBe("unverified_do_not_cutover");
 });
  it("treats valid independent supervised and MCP PIDs as review-only",async()=>{
   const listeners=new Map([[7888,101],[6789,202]]);
   const r=await assessRuntimeOwnership({...base,
     listenerBefore:listeners,listenerAfter:listeners,
     stateInventory:{...inventory,records:[{port:6789,pid:202,authMode:"oauth"}]},
     authenticatedCore:{publicPort:7888,supervisorPid:101,activePid:103},
   });
   expect(r.core.state).toBe("verified_supervisor");
   expect(r.ownershipTopology).toBe("separate_owners_needs_operator_review");
   expect(r.blockers).toContain("MCP_OAUTH_AND_DRAIN_STATE_NOT_AUTHENTICATED");
   expect(r.canStopMcp).toBe(false);
  });
  it("authenticates a managed MCP owner without requiring it to drain",async()=>{
   const listeners=new Map([[7888,101],[6789,202]]);
   const r=await assessRuntimeOwnership({...base,
     listenerBefore:listeners,listenerAfter:listeners,
     stateInventory:{directory:"present",rejected:0,records:[{
       port:6789,pid:202,authMode:"oauth",oauthStatePersistent:true,
     }]},
     authenticatedCore:{publicPort:7888,supervisorPid:101,activePid:103},
     authenticatedMcp:new Map([[6789,{
       port:6789,pid:202,oauthEnabled:true,publicTunnelStarted:true,
       draining:false,activeSessions:1,inFlightRequests:0,
     }]]),
   });
   expect(r.mcp[0]).toMatchObject({
     authenticationVerified:true,sessionsDrainVerified:false,
     publicTunnelVerified:true,oauthStatePersistent:true,
   });
   expect(r.blockers).toContain("MCP_OAUTH_AND_DRAIN_STATE_NOT_AUTHENTICATED");
  });
  it("never upgrades to safe on kernel PID reuse, race, or missing netstat",async()=>{
   for(const before of [null,new Map([[7888,909],[6789,13424]])]){
     const r=await assessRuntimeOwnership({...base,listenerBefore:before,
       authenticatedCore:{publicPort:7888,supervisorPid:13424,activePid:100}});
     expect(r.listenerSamplesStable).toBe(false);
     expect(r.core.state).toBe("unverified");
     expect(r.blockers).toContain("KERNEL_LISTENER_EVIDENCE_UNSTABLE_OR_UNAVAILABLE");
   }
  });
  it("reports rejected MCP discovery records and missing owner lists instead of silently ignoring",async()=>{
   const r=await assessRuntimeOwnership({...base,
     stateInventory:{directory:"unverified",rejected:4,records:[]}});
   expect(r.stateFiles).toEqual({directory:"unverified",rejected:4});
   expect(r.blockers).toContain("MCP_STATE_FILES_MALFORMED_OR_UNREADABLE");
   expect(r.blockers).toContain("NO_AUTHENTICATED_MCP_OWNER_INVENTORY");
  });
 it("rejects inconsistent, duplicated and forged MCP process records",async()=>{
  await expect(assessRuntimeOwnership({...base,
    stateInventory:{...inventory,records:[inventory.records[0],inventory.records[0]]},
  })).rejects.toThrow(/Duplicate/);
  await expect(assessRuntimeOwnership({...base,
    stateInventory:{...inventory,records:[{port:6789,pid:-1,authMode:"oauth"}]},
  })).rejects.toThrow(/malformed/);
  await expect(assessRuntimeOwnership({...base,corePort:1})).rejects.toThrow();
 });
 it("captures exact two kernel samples and one read-only authenticated status",async()=>{
  let calls=0,read=0;
  const out=await captureRuntimeOwnership(7888,{
    listenerOwners:()=>{calls++;return connected;},
    mcpInventory:()=>inventory,
    authenticatedCore:async()=>{read++;return null;},
  });
  expect(calls).toBe(2);
  expect(read).toBe(1);
  expect(out.nextAction).toBe("OPERATOR_REVIEW_ONLY");
 });
 it("never exposes OAuth URLs, bearer or workspace fields in the contracted output",async()=>{
  const extra={...base,issuerUrl:"https://secret.example/mcp",
    token:"oauth-client-secret",workspace:"C:/private-workspace"};
  const value=JSON.stringify(await assessRuntimeOwnership(extra));
  expect(value).not.toContain("secret.example");
  expect(value).not.toContain("oauth-client-secret");
  expect(value).not.toContain("private-workspace");
 });
});
