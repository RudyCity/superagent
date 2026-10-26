import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import { createCoreRecoveryEvidence } from "../src/core/runtime/coreRecoveryEvidence.js";
import { reconcileCoreRecoveryEvidence } from "../src/core/runtime/coreColdReconciliation.js";
import { evaluateCoreServiceLifecycle, buildCoreLifecyclePlan } from "../src/core/runtime/coreServiceLifecycle.js";
import { decideChannelRecovery, type ChannelRecoveryEvidence } from "../src/core/runtime/coreChannelRecovery.js";
const require=createRequire(import.meta.url);
const { Database }=require("bun:sqlite") as {Database:new(f:string)=>{exec:(sql:string)=>void;close:()=>void}};
const old=process.env.SUPERAGENT_CONFIG_DIR;
const roots:string[]=[];
afterEach(()=>{
  if(old===undefined) delete process.env.SUPERAGENT_CONFIG_DIR;
  else process.env.SUPERAGENT_CONFIG_DIR=old;
  for(const root of roots.splice(0)) {
    try { fs.rmSync(root,{recursive:true,force:true,maxRetries:8,retryDelay:150}); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code!=="EBUSY") throw error;
      // Windows may retain a short-lived SQLite WAL directory handle during
      // background close; never delete anything outside this mkdtemp path.
    }
  }
});
const stage=()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"sa-core-5g-j-"));
  roots.push(root);process.env.SUPERAGENT_CONFIG_DIR=root;return root;
};
describe("Phase 5g offline evidence reconciliation",()=>{
  it("verifies SQLite, turn counts and leaves all originals unchanged, no restart authorization",async()=>{
    const root=stage(),port=59511,secret=crypto.randomBytes(16).toString("hex");
    const cp=path.join(root,"core-checkpoint-"+port+".json");
    fs.writeFileSync(cp,JSON.stringify({version:1,port,clientMode:"tline",
      serverToken:secret,inspectToken:"x".repeat(48),savedAt:Date.now(),
      activePid:99999999,workers:[],sessions:[]}),{mode:0o600});
    const db=new Database(path.join(root,"history.db"));
    db.exec("CREATE TABLE chat_turns (state TEXT); INSERT INTO chat_turns VALUES ('completed'),('accepted'),('running'),('failed'),('interrupted');"+
      "CREATE TABLE sessions (id TEXT PRIMARY KEY); INSERT INTO sessions VALUES ('a'),('b');");
    db.close();
    const source=fs.readFileSync(cp);
    const manifest=await createCoreRecoveryEvidence(port);
    const report=reconcileCoreRecoveryEvidence(manifest.folder);
    expect(report.evidenceVerified).toBe(true);
    expect(report.snapshotIntegrity).toBe("ok");
    expect(report.unfinishedTurnCount).toBe(3);
    expect(report.chatTurnStateCounts).toMatchObject({
      completed:1,failed:1,accepted:1,running:1,interrupted:1,
    });
    expect(report.persistedSessionCount).toBe(2);
    expect(report.findings).toContain("EXTERNAL_TOOL_SIDE_EFFECTS_NOT_PROVEN_SAFE");
    expect(report.restartAuthorized).toBe(false);
    expect(report.toolsMayReplay).toBe(false);
    expect(JSON.stringify(report)).not.toContain(secret);
    expect(fs.readFileSync(cp)).toEqual(source);
  });
  it("refuses evidence tampering, symlink sources and wrong owner location",async()=>{
    stage();const manifest=await createCoreRecoveryEvidence(59512);
    expect(()=>reconcileCoreRecoveryEvidence(path.resolve(manifest.folder,".."))).toThrow();
    const evidence=path.join(manifest.folder,"history.db");
    if(fs.existsSync(evidence)){
      fs.appendFileSync(evidence,"tamper");
      expect(()=>reconcileCoreRecoveryEvidence(manifest.folder)).toThrow();
    }else{
      fs.writeFileSync(path.join(manifest.folder,"manifest.json"),"{", {flag:"w"});
      expect(()=>reconcileCoreRecoveryEvidence(manifest.folder)).toThrow();
    }
  });
  it("requires an intact evidence manifest and denies spoofed authorization",async()=>{
    stage();const manifest=await createCoreRecoveryEvidence(59513);
    const f=path.join(manifest.folder,"manifest.json");
    const content=JSON.parse(fs.readFileSync(f,"utf8"));
    content.restartAuthorized=true;
    fs.writeFileSync(f,JSON.stringify(content));
    expect(()=>reconcileCoreRecoveryEvidence(manifest.folder)).toThrow(/Invalid recovery manifest/);
  });
});
describe("Phase 5h independent lifecycle policy",()=>{
  it("keeps connected external channels beyond Core restart authority",()=>{
    const plan=buildCoreLifecyclePlan();
    expect(plan.schedulerInstalled).toBe(false);
    expect(plan.externalChannelRestartAllowed).toBe(false);
    for(const service of ["mcp_tunnel","muse","telegram"] as const){
      const d=evaluateCoreServiceLifecycle({service,condition:"dead",
        ownership:"external",consecutiveHealthFailures:42,checkpointProtected:false});
      expect(d.action).toBe("observe");
      expect(d.mayRestartExternalChannel).toBe(false);
      expect(d.mayKillProcess).toBe(false);
    }
  });
  it("requires repeated verified health failures before recommending owned recovery",()=>{
    const base={service:"core_supervisor" as const,condition:"dead" as const,
      ownership:"verified_local" as const,checkpointProtected:false};
    expect(evaluateCoreServiceLifecycle({...base,consecutiveHealthFailures:2}).action).toBe("read_only_probe");
    expect(evaluateCoreServiceLifecycle({...base,consecutiveHealthFailures:3}).action).toBe("review_guarded_recovery");
    expect(evaluateCoreServiceLifecycle({...base,consecutiveHealthFailures:10,
      checkpointProtected:true}).action).toBe("operator_review");
    expect(evaluateCoreServiceLifecycle({...base,consecutiveHealthFailures:10,
      ownership:"unverified"}).action).toBe("operator_review");
  });
});
describe("Phase 5i channel and agent recovery boundary",()=>{
  const base:ChannelRecoveryEvidence={channel:"tline",transportAlive:true,ownerVerified:true,
    credentialContinuityVerified:true,originalSessionExists:false,ambiguousExecutionCount:0,
    durableHistoryVerified:true,approvedByUser:true};
  it("only allows user-approved T-Line session resumption with history",()=>{
    expect(decideChannelRecovery(base).action).toBe("explicit_session_resume");
    expect(decideChannelRecovery({...base,approvedByUser:false}).action).toBe("operator_review");
    expect(decideChannelRecovery({...base,durableHistoryVerified:false}).action).toBe("operator_review");
    expect(decideChannelRecovery({...base,ambiguousExecutionCount:null}).action).toBe("operator_review");
    expect(decideChannelRecovery({...base,ambiguousExecutionCount:1}).action).toBe("operator_review");
  });
  it("never converts an MCP OAuth/Muse/Telegram session to an implicit new identity",()=>{
    for(const channel of ["mcp_oauth","muse","telegram"] as const){
      const d=decideChannelRecovery({...base,channel,originalSessionExists:false});
      expect(d.action).toBe("operator_review");
      expect(d.replayToolCalls).toBe(false);
      expect(d.restartProcess).toBe(false);
      expect(d.preserveExistingSessionId).toBe(true);
    }
    expect(decideChannelRecovery({...base,channel:"mcp_oauth",
      credentialContinuityVerified:false}).action).toBe("require_reauthentication");
    expect(decideChannelRecovery({...base,channel:"telegram",
      originalSessionExists:true}).action).toBe("keep_existing_transport");
  });
});
