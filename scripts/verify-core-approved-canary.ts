/**
 * Phase 5l real process smoke in an isolated source profile and fresh target.
 * No live Core, models, external tunnels, real users or production PIDs.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createCoreRecoveryEvidence } from "../src/core/runtime/coreRecoveryEvidence.js";
import { preflightIsolatedCoreCanary, runIsolatedCoreCanary } from "../src/core/runtime/coreRecoveryCanary.js";
const {Database}=createRequire(import.meta.url)("bun:sqlite") as {
  Database:new (file:string)=>{exec(sql:string):void;close():void}
};
const base=path.join(os.homedir(),".superagent-local-staging");
fs.mkdirSync(base,{recursive:true,mode:0o700});
const root=fs.mkdtempSync(path.join(base,"approved-canary-fixture-"));
const config=path.join(root,"source");
fs.mkdirSync(config,{recursive:true,mode:0o700});
const old=process.env.SUPERAGENT_CONFIG_DIR;
const oldSession=process.env.SUPERAGENT_SESSION_ID;
process.env.SUPERAGENT_CONFIG_DIR=config;
delete process.env.SUPERAGENT_SESSION_ID;
async function unusedPort():Promise<number>{
  return await new Promise((resolve,reject)=>{
    const srv=net.createServer();
    srv.once("error",reject);
    srv.listen(0,"127.0.0.1",()=>{
      const adr=srv.address();
      if(!adr||typeof adr==="string")throw new Error("No local port");
      const p=adr.port;
      srv.close(()=>resolve(p));
    });
  });
}
const checks:string[]=[];
function check(name:string,truthy:unknown){
  if(!truthy)throw new Error("Canary staging assertion failed: "+name);
  checks.push(name);
}
try{
  const originalPort=await unusedPort();
  let targetPort=await unusedPort();
  while(originalPort===targetPort||targetPort===7888)targetPort=await unusedPort();
  const source=path.join(config,"core-checkpoint-"+originalPort+".json");
  const original={
    version:1,port:originalPort,savedAt:Date.now(),clientMode:"tline",
    serverToken:crypto.randomBytes(24).toString("hex"),
    inspectToken:crypto.randomBytes(32).toString("hex"),
    activePid:99999991,
    workers:[{pid:99999991,port:originalPort+1<=65535?originalPort+1:59990,
      since:Date.now(),generationId:crypto.randomBytes(16).toString("hex"),drainEligible:true}],
    sessions:[],
  };
  fs.writeFileSync(source,JSON.stringify(original),{mode:0o600,flag:"wx"});
  const db=new Database(path.join(config,"history.db"));
  db.exec("CREATE TABLE chat_turns (state TEXT); INSERT INTO chat_turns VALUES ('completed');"+
    "CREATE TABLE sessions (id TEXT PRIMARY KEY);");
  db.close();
  const unchanged=fs.readFileSync(source);
  const evidence=await createCoreRecoveryEvidence(originalPort);
  check("offline_evidence_verification",evidence.restartAuthorized===false &&
    evidence.toolReplayAuthorized===false && evidence.database.integrity==="ok");
  const preview=await preflightIsolatedCoreCanary(evidence.folder,targetPort);
  check("alternate_port_only",preview.originalPort===originalPort &&
    preview.targetPort===targetPort && !preview.productionHandoverAuthorized);
  let refused=false;
  try{
    await runIsolatedCoreCanary({
      snapshotFolder:evidence.folder,targetPort,approved:"NOT_APPROVED",
      cliEntrypoint:path.join(import.meta.dir,"..","dist","cli.js"),
    });
  }catch(e){refused=String(e).includes("Operator approval");}
  check("unapproved_process_not_spawned",refused);
  refused=false;
  try{await preflightIsolatedCoreCanary(evidence.folder,originalPort);}
  catch{refused=true;}
  check("same_original_port_refused",refused);
  const result=await runIsolatedCoreCanary({
    snapshotFolder:evidence.folder,targetPort,
    approved:"START_ISOLATED_CANARY",
    cliEntrypoint:path.join(import.meta.dir,"..","dist","cli.js"),
    timeoutMs:40_000,
  });
  check("new_canary_supervisor_verified",result.passed && result.supervisorOwned && result.workerOwned);
  check("canary_stopped_after_authenticated_probe",result.ownerTerminatedAfterCheck);
  check("no_old_sessions_or_tools_replayed",!result.previousSessionsImported &&
    result.toolRequestsMade===0 && !result.productionHandoverAuthorized);
  check("source_checkpoint_unchanged",fs.readFileSync(source).equals(unchanged));
  check("snapshot_manifest_unchanged",fs.existsSync(path.join(evidence.folder,"manifest.json")));
  const report={
    phase:"core-recovery-isolated-approved-canary",ok:true,
    checks,verifiedChecks:checks.length,
    originalPort,targetPort,
    canaryRuntimeMs:result.elapsedMs,
    productionServicesTouched:false,externalToolCalls:0,automaticReplay:false,
    originalCheckpointUnchanged:true,stagingRoot:root,
  };
  const reportFile=path.join(root,"report.json");
  fs.writeFileSync(reportFile,JSON.stringify(report,null,2),{mode:0o600,flag:"wx"});
  console.log(JSON.stringify({ok:true,verifiedChecks:checks.length,
    checks,reportPath:reportFile,canaryRuntimeMs:result.elapsedMs},null,2));
}finally{
  if(old===undefined)delete process.env.SUPERAGENT_CONFIG_DIR;
  else process.env.SUPERAGENT_CONFIG_DIR=old;
  if(oldSession===undefined)delete process.env.SUPERAGENT_SESSION_ID;
  else process.env.SUPERAGENT_SESSION_ID=oldSession;
}
