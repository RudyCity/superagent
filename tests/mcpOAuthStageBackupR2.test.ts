import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import {afterEach,describe,expect,it} from "vitest";
import {McpDurableOAuthStore} from "../src/core/mcp/mcpDurableOAuthStore.js";
import {
 backupOfflineNewOAuthStageR2,restoreOfflineNewOAuthStageR2,
} from "../src/core/mcp/mcpOAuthStageBackupR2.js";

const stageRoot=path.join(os.homedir(),".superagent-local-staging");
fs.mkdirSync(stageRoot,{recursive:true});
const cleanups:string[]=[];
function stage():string{
 const d=fs.mkdtempSync(path.join(stageRoot,"r2-backup-test-"));
 cleanups.push(d);
 return d;
}
afterEach(()=>{for(const dir of cleanups.splice(0))fs.rmSync(dir,{force:true,recursive:true})});
const issuer="https://r2-backup.test.example";
const uri="https://new-client.example/cb";
function createFixture(mode:"raw-test"|"windows-dpapi"){
 const base=stage(),source=path.join(base,"issuer"),backup=path.join(base,"backup"),dest=path.join(base,"restored");
 fs.mkdirSync(source);
 const store=new McpDurableOAuthStore(source,issuer,{keyMode:mode});
 store.registerClient("new-client",[uri]);
 const verifier=crypto.randomBytes(32).toString("base64url");
 const codeChallenge=crypto.createHash("sha256").update(verifier).digest("base64url");
 const req=store.createAuthorizationRequest({clientId:"new-client",redirectUri:uri,codeChallenge,
  codeChallengeMethod:"S256",scope:["mcp:tools"],state:"canary",resource:issuer+"/mcp"});
 const approval=store.approveAuthorizationRequest(req.requestId,true);
 if(!approval.ok)throw Error("No code");
 const exchanged=store.exchangeCode({code:approval.code,clientId:"new-client",redirectUri:uri,
  codeVerifier:verifier,resource:issuer+"/mcp"});
 if(!exchanged.ok)throw Error("No tokens");
 return {base,source,backup,dest,store,refresh:exchanged.refreshToken};
}
function save(f:ReturnType<typeof createFixture>,keyMode:"raw-test"|"windows-dpapi"){
 return backupOfflineNewOAuthStageR2({source:f.source,backupDestination:f.backup,issuer,keyMode});
}
function restore(f:ReturnType<typeof createFixture>,keyMode:"raw-test"|"windows-dpapi"){
 return restoreOfflineNewOAuthStageR2({backupSource:f.backup,freshDestination:f.dest,issuer,keyMode});
}
describe("R2 isolated-only offline paired OAuth backup and restore",()=>{
 it("restores persisted new-only refresh token to fresh profile with original issuer identity",()=>{
  const f=createFixture("raw-test");
  expect(save(f,"raw-test")).toMatchObject({status:"isolated_backup_created",files:3});
  expect(restore(f,"raw-test")).toMatchObject({status:"isolated_restore_verified",files:2});
  const resumed=new McpDurableOAuthStore(f.dest,issuer,{keyMode:"raw-test"});
  expect(resumed.getClient("new-client")?.redirectUris).toEqual([uri]);
  expect(resumed.rotateRefreshToken(f.refresh,issuer+"/mcp").ok).toBe(true);
 });
 it("refuses changing issuer, replacing target or overwritten client profile",()=>{
  const f=createFixture("raw-test");
  save(f,"raw-test");
  expect(()=>restoreOfflineNewOAuthStageR2({backupSource:f.backup,freshDestination:f.dest,
   issuer:"https://other-issuer.example",keyMode:"raw-test"})).toThrow(/issuer/);
  fs.mkdirSync(f.dest);
  expect(()=>restore(f,"raw-test")).toThrow(/fresh/);
  expect(()=>save(f,"raw-test")).toThrow(/fresh/);
 });
 it("detects manifest and snapshot tampering and does not create destination",()=>{
  const f=createFixture("raw-test");save(f,"raw-test");
  const statePath=path.join(f.backup,"oauth-state.json");
  fs.appendFileSync(statePath," ");
  expect(()=>restore(f,"raw-test")).toThrow(/checksum mismatch/);
  expect(fs.existsSync(f.dest)).toBe(false);
 });
 it("refuses active writer locks and does not produce backup artifacts",()=>{
  const f=createFixture("raw-test");
  fs.writeFileSync(path.join(f.source,"oauth-state.json.writer-lock"),"active",{flag:"wx"});
  expect(()=>save(f,"raw-test")).toThrow(/lock/);
  expect(fs.existsSync(f.backup)).toBe(false);
 });
 it("refuses a profile outside the private staging root",()=>{
  const f=createFixture("raw-test");
  const outside=fs.mkdtempSync(path.join(os.tmpdir(),"r2-outside-"));
  try{
   expect(()=>backupOfflineNewOAuthStageR2({
    source:f.source,backupDestination:path.join(outside,"backup"),issuer,keyMode:"raw-test"
   })).toThrow(/isolated/);
   expect(()=>backupOfflineNewOAuthStageR2({
    source:outside,backupDestination:f.backup,issuer,keyMode:"raw-test"
   })).toThrow(/isolated/);
  }finally{fs.rmSync(outside,{recursive:true,force:true})}
 });
 it("rejects symlinked or multi-linked OAuth state on source",()=>{
  const f=createFixture("raw-test");
  const original=path.join(f.source,"oauth-state.json");
  const hard=path.join(f.base,"state-hardlink");
  fs.linkSync(original,hard);
  expect(()=>save(f,"raw-test")).toThrow(/Unsafe|Untrusted/);
  fs.unlinkSync(hard);
 });
 it("refuses backing up an issuer that still owns a live loopback port on Windows",async()=>{
  if(process.platform!=="win32")return;
  const server=net.createServer();
  await new Promise<void>((resolve,reject)=>{
   server.once("error",reject);server.listen(0,"127.0.0.1",resolve);
  });
  try{
   const address=server.address();
   if(!address||typeof address==="string")throw Error("Missing TCP port");
   const port=address.port;
   const liveIssuer="http://127.0.0.1:"+port;
   const base=stage(),source=path.join(base,"issuer"),backup=path.join(base,"backup");
   fs.mkdirSync(source);
   new McpDurableOAuthStore(source,liveIssuer,{keyMode:"raw-test"});
   expect(()=>backupOfflineNewOAuthStageR2({
    source,backupDestination:backup,issuer:liveIssuer,keyMode:"raw-test",
   })).toThrow(/listener is running/);
   expect(fs.existsSync(backup)).toBe(false);
  }finally{
   await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
  }
 },25000);
 it("round-trips same-user Windows DPAPI key without plaintext downgrade",()=>{
  if(process.platform!=="win32")return;
  const f=createFixture("windows-dpapi");
  save(f,"windows-dpapi");
  restore(f,"windows-dpapi");
  expect(fs.existsSync(path.join(f.dest,"oauth-state.key"))).toBe(false);
  expect(new McpDurableOAuthStore(f.dest,issuer,{keyMode:"windows-dpapi"})
   .rotateRefreshToken(f.refresh,issuer+"/mcp").ok).toBe(true);
 },30000);
});
