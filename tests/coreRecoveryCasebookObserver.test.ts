import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import { createCoreRecoveryEvidence } from "../src/core/runtime/coreRecoveryEvidence.js";
import { createCoreRecoveryCasebook } from "../src/core/runtime/coreRecoveryCasebook.js";
import { observeCoreLifecycle } from "../src/core/runtime/coreLifecycleObserver.js";
import type { CoreRuntimeStatus } from "../src/core/runtime/coreSupervisor.js";
const { Database }=createRequire(import.meta.url)("bun:sqlite") as {
 Database:new(file:string)=>{exec(sql:string):void;close():void}
};
const original=process.env.SUPERAGENT_CONFIG_DIR;
const dirs:string[]=[];
afterEach(()=>{
 if(original===undefined)delete process.env.SUPERAGENT_CONFIG_DIR;
 else process.env.SUPERAGENT_CONFIG_DIR=original;
 for(const dir of dirs.splice(0)){
   try { fs.rmSync(dir,{recursive:true,force:true,maxRetries:8,retryDelay:150}); }
   catch(e){ if((e as NodeJS.ErrnoException).code!=="EBUSY")throw e; }
 }
});
function fresh(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"core-cases-"));
 dirs.push(dir);process.env.SUPERAGENT_CONFIG_DIR=dir;return dir;
}
function fixture():{dir:string;sessionId:string;foreignId:string;dbPath:string}{
 const dir=fresh(),sessionId="sess_safe_xyz",foreignId="sess_unfinished_xyz";
 const dbPath=path.join(dir,"history.db");
 const db=new Database(dbPath);
 db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY);"+
  "INSERT INTO sessions VALUES ('"+sessionId+"'),('"+foreignId+"');"+
  "CREATE TABLE chat_turns (session_id TEXT, state TEXT, message_json TEXT, workspace TEXT);"+
  "INSERT INTO chat_turns VALUES ('"+sessionId+"','completed','PRIVATE_CHAT_MESSAGE','D:/Private');"+
  "INSERT INTO chat_turns VALUES ('"+foreignId+"','running','PRIVATE_TOOL_INPUT','D:/Private');"+
  "INSERT INTO chat_turns VALUES ('"+foreignId+"','accepted','PRIVATE_TOOL_INPUT2','D:/Private');");
 db.close();
 const digest=crypto.createHash("sha256").update(sessionId).digest("hex");
 const bucket=path.join(dir,"core-session-receipts",digest.slice(0,2));
 fs.mkdirSync(bucket,{recursive:true,mode:0o700});
 fs.writeFileSync(path.join(bucket,digest+".json"),JSON.stringify({
  version:1,sessionId,workspace:"D:/Private",mode:"single",clientMode:"tline",createdAt:Date.now()
 }),{mode:0o600});
 return {dir,sessionId,foreignId,dbPath};
}
const okStatus=(pid=41414):CoreRuntimeStatus=>({
 supervisorPid:pid,publicPort:59777,active:{pid:41415,port:59778,since:1},retained:[]
});
describe("Phase 5k anonymized cold-start recovery casebook",()=>{
 it("groups existing sessions and ambiguous work without leaking chat, owner or credentials",async()=>{
  const f=fixture(),evidence=await createCoreRecoveryEvidence(59888);
  const out=createCoreRecoveryCasebook(evidence.folder);
  expect(out.evidenceVerified).toBe(true);
  expect(out.totalCases).toBe(2);
  expect(out.cases).toHaveLength(2);
  expect(out.cases.find(c=>c.status==="incomplete_turn_review")?.turnStates)
   .toMatchObject({running:1,accepted:1});
  expect(out.cases.find(c=>c.status==="external_effect_review")?.receiptPresent).toBe(true);
  expect(out.cases.every(c=>!c.replayAuthorized&&!c.resumeAuthorized)).toBe(true);
  const raw=JSON.stringify(out);
  for(const secret of [f.sessionId,f.foreignId,"PRIVATE_CHAT_MESSAGE","PRIVATE_TOOL_INPUT","D:/Private"])
   expect(raw).not.toContain(secret);
  expect(fs.existsSync(f.dbPath)).toBe(true);
 });
 it("reports missing durable history from receipt, never silently fabricates recovery",async()=>{
  const f=fixture(),db=new Database(f.dbPath);
  db.exec("DELETE FROM sessions WHERE id='"+f.sessionId+"'");
  db.close();
  const evidence=await createCoreRecoveryEvidence(59889);
  const out=createCoreRecoveryCasebook(evidence.folder);
  const problem=out.cases.find(c=>c.status==="missing_history");
  expect(problem?.requiredActions).toContain("RECOVER_DURABLE_HISTORY_BEFORE_ANY_RESUME");
  expect(out.restartAuthorized).toBe(false);
 });
 it("bounds result pages and explicitly reports truncation",async()=>{
  fixture();
  const evidence=await createCoreRecoveryEvidence(59890);
  const out=createCoreRecoveryCasebook(evidence.folder,1);
  expect(out.returnedCases).toBe(1);
  expect(out.totalCases).toBe(2);
  expect(out.truncated).toBe(true);
  expect(out.nextOffset).toBe(1);
  const pageTwo=createCoreRecoveryCasebook(evidence.folder,1,out.nextOffset!);
  expect(pageTwo.cases).toHaveLength(1);
  expect(pageTwo.cases[0].sessionRef).not.toBe(out.cases[0].sessionRef);
  expect(pageTwo.truncated).toBe(false);
  expect(pageTwo.nextOffset).toBeNull();
  expect(()=>createCoreRecoveryCasebook(evidence.folder,1,-1)).toThrow();
  expect(()=>createCoreRecoveryCasebook(evidence.folder,0)).toThrow();
  expect(()=>createCoreRecoveryCasebook(evidence.folder,501)).toThrow();
 });
 it("fails closed on tampered snapshots, symlinked files and forged receipt identity",async()=>{
  const f=fixture();
  const evidence=await createCoreRecoveryEvidence(59891);
  const manifest=JSON.parse(fs.readFileSync(path.join(evidence.folder,"manifest.json"),"utf8"));
  const receipt=manifest.files.find((x:{name:string})=>x.name.startsWith("receipts/"));
  const target=path.join(evidence.folder,...receipt.name.split("/"));
  fs.writeFileSync(target,JSON.stringify({version:1,sessionId:"mismatched_session"}));
  expect(()=>createCoreRecoveryCasebook(evidence.folder)).toThrow();
  expect(fs.readFileSync(f.dbPath)).toBeDefined();
 });
});
describe("Phase 5k authenticated read-only lifecycle observer",()=>{
 it("requires three stable authenticated samples for verified owner",async()=>{
  let calls=0;
  const out=await observeCoreLifecycle({port:59777,samples:3,intervalMs:100,
   pause:async()=>{},status:async()=>{calls++;return okStatus()}});
  expect(calls).toBe(3);
  expect(out.ownership).toBe("verified_local");
  expect(out.assessment.action).toBe("observe");
  expect(out.sentSignals).toBe(false);
  expect(out.sampledMethods).toEqual(["GET"]);
 });
 it("refuses owner trust on stale identity or alternating worker PIDs",async()=>{
  let calls=0;
  const out=await observeCoreLifecycle({port:59777,samples:3,intervalMs:100,
   pause:async()=>{},status:async()=>okStatus(++calls+41414)});
  expect(out.ownerStable).toBe(false);
  expect(out.ownership).toBe("unverified");
  expect(out.assessment.action).toBe("operator_review");
 });
 it("never schedules an auto-restart after three failures or foreign state",async()=>{
  const out=await observeCoreLifecycle({port:59777,samples:3,intervalMs:100,
   pause:async()=>{},status:async()=>{throw new Error("offline")}});
  expect(out.failedSamples).toBe(3);
  expect(out.assessment.action).toBe("operator_review");
  expect(out.assessment.mayKillProcess).toBe(false);
  expect(out.externalChannelsTouched).toBe(false);
 });
 it("rejects unbounded sampling and respects malformed authenticated status",async()=>{
  await expect(observeCoreLifecycle({port:59777,samples:99})).rejects.toThrow();
  const out=await observeCoreLifecycle({port:59777,samples:1,intervalMs:100,
   status:async()=>({...okStatus(),publicPort:1234})});
  expect(out.ownership).toBe("unverified");
 });
});
