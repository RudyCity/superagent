import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {afterEach,describe,expect,it} from "vitest";
import {
 APPROVE_MANAGED_MCP,assertManagedMcpPort,assertManagedMcpDirectory,
 readManagedMcpLease,writeOwnedMcpLease,requestOwnedMcpStop,
 matchesOwnedMcpStop,cleanOwnMcpLease,type ManagedMcpLease,
} from "../src/core/runtime/mcpOwnerStagingLease.js";
import {assessMcpOAuthMigration,type McpOAuthMigrationEvidence}
 from "../src/core/runtime/mcpOAuthMigrationPolicy.js";
const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))fs.rmSync(root,{
 recursive:true,force:true,maxRetries:3,retryDelay:50,
});});
function fixture(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"mcp-owner-lease-"));
 roots.push(root);const dir=path.join(root,"owner");fs.mkdirSync(dir);
 const lease:ManagedMcpLease={
  version:1,kind:"managed_mcp_staging",pid:123456,port:55111,
  nonce:crypto.randomBytes(32).toString("hex"),createdAt:Date.now(),
  auth:"private_bearer",modelAutostart:false,publicTunnel:false,
 };
 return {root,dir,lease};
}
describe("Phase 5n owner persisted lease and stop nonce",()=>{
 it("rejects production ports and symlinked/foreign profiles",()=>{
  expect(APPROVE_MANAGED_MCP).toBe("START_STAGING_MCP_OWNER");
  for(const p of [6759,6789,7888,7892,9877,0,65536]){
   expect(()=>assertManagedMcpPort(p)).toThrow();
  }
  const {root,dir}=fixture();
  expect(()=>assertManagedMcpDirectory(dir,root)).not.toThrow();
  expect(()=>assertManagedMcpDirectory(path.join(root,".."),root)).toThrow();
 });
 it("preserves same-process nonce and denies forged stop",()=>{
  const {dir,lease}=fixture();
  writeOwnedMcpLease(dir,lease);
  expect(readManagedMcpLease(dir)).toEqual(lease);
  expect(matchesOwnedMcpStop(dir,lease)).toBe(false);
  requestOwnedMcpStop(dir,{...lease,nonce:crypto.randomBytes(32).toString("hex")});
  expect(matchesOwnedMcpStop(dir,lease)).toBe(false);
  expect(()=>requestOwnedMcpStop(dir,lease)).toThrow();
  cleanOwnMcpLease(dir,lease);
  expect(readManagedMcpLease(dir)).toBeNull();
  expect(fs.existsSync(path.join(dir,"managed-stop.json"))).toBe(true);
 });
 it("accepts only exact authenticated cleanup and removes matching stop marker",()=>{
  const {dir,lease}=fixture();
  writeOwnedMcpLease(dir,lease);
  requestOwnedMcpStop(dir,lease);
  expect(matchesOwnedMcpStop(dir,lease)).toBe(true);
  cleanOwnMcpLease(dir,lease);
  expect(fs.readdirSync(dir)).toEqual([]);
 });
 it("fails closed on malformed persisted lease",()=>{
  const {dir,lease}=fixture();
  fs.writeFileSync(path.join(dir,"managed-owner.json"),JSON.stringify({
   ...lease,nonce:"short",
  }));
  expect(()=>readManagedMcpLease(dir)).toThrow(/corrupt/);
 });
});
const safe:McpOAuthMigrationEvidence={
 sharedLegacyCoreOwner:false,independentOwnerVerified:true,
 newIssuerConfigured:true,publicMcpEndpointMatched:true,
 clientsReauthorized:true,activeLegacySessions:0,pendingToolEffects:0,
 rollbackPathVerified:true,operatorApproved:true,
};
describe("Phase 5n OAuth migration safety policy",()=>{
 it("refuses transfer from shared Core/MCP PID even with otherwise safe evidence",()=>{
  const blocked=assessMcpOAuthMigration({...safe,sharedLegacyCoreOwner:true});
  expect(blocked.status).toBe("blocked");
  expect(blocked.blockers).toContain("LEGACY_CORE_AND_MCP_SHARE_PROCESS");
  expect(blocked.legacyProcessTerminationPermitted).toBe(false);
  expect(blocked.tokenExportPermitted).toBe(false);
 });
 it("requires client reauthorization and explicit zero-ambiguity reviews",()=>{
  const d=assessMcpOAuthMigration({...safe,clientsReauthorized:false,
   activeLegacySessions:null,pendingToolEffects:1});
  expect(d.status).toBe("blocked");
  expect(d.blockers).toContain("CLIENTS_MUST_REAUTHORIZE");
  expect(d.blockers).toContain("LEGACY_SESSION_DRAIN_NOT_PROVEN");
  expect(d.blockers).toContain("UNKNOWN_EXTERNAL_TOOL_EFFECTS");
 });
 it("even fully evidenced migration remains manual, never token-copy or auto-cutover",()=>{
  const d=assessMcpOAuthMigration(safe);
  expect(d.status).toBe("manual_reconnect_candidate");
  expect(d.automaticCutoverPermitted).toBe(false);
  expect(d.liveSessionTransferPermitted).toBe(false);
  expect(d.sessionReauthorizationRequired).toBe(true);
  expect(()=>assessMcpOAuthMigration({...safe,activeLegacySessions:-1})).toThrow();
 });
});
