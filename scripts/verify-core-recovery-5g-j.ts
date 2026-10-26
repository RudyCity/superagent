/**
 * Phase 5j bounded offline chaos smoke. Runs tests under their OWN isolated
 * profiles/ports, never sends signals to unrelated running services.
 * Example: bun scripts/verify-core-recovery-5g-j.ts --cycles 2
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
const index=process.argv.indexOf("--cycles");
const cycles=index<0?2:Number(process.argv[index+1]);
if(!Number.isInteger(cycles)||cycles<1||cycles>5) throw new Error("Cycles must be 1..5");
const root=path.join(os.homedir(),".superagent-local-staging");
fs.mkdirSync(root,{recursive:true,mode:0o700});
const filename=path.join(root,"core-recovery-5g-j-"+crypto.randomBytes(5).toString("hex")+".json");
const checks:Array<{name:string;pass:boolean;durationMs:number;detail?:string}>=[];
const run=(name:string,args:string[],limit=100000)=>{
  const start=Date.now();
  const result=spawnSync(process.execPath,args,{cwd:path.resolve(import.meta.dir,".."),
    stdio:"pipe",encoding:"utf8",timeout:limit,windowsHide:true,maxBuffer:1024*1024});
  const pass=result.status===0&&!result.error;
  checks.push({name,pass,durationMs:Date.now()-start,
    ...(pass?{}:{detail:String(result.error||result.stderr||result.stdout).slice(-600)})});
  if(!pass) throw new Error(name+" failed (see local staging report)");
};
let ok=false;
try {
  for(let i=1;i<=cycles;i++){
    run("phase_5g_j_fault_matrix_cycle_"+i,[
      "--bun","x","vitest","run","--maxWorkers=2",
      "tests/coreRecoveryPhase5gToJ.test.ts",
      "tests/corePhase5d.test.ts","tests/corePhase5e.test.ts"],90000);
  }
  run("owned_guardian_core_and_frontdoor_fault_injection",
    ["scripts/verify-core-guardian.ts"],105000);
  run("owned_worker_session_no_replay_fault_injection",
    ["scripts/verify-core-session-resume.ts"],105000);
  ok=true;
} catch(e){console.error(String(e));process.exitCode=1;}
finally {
  const report={version:1,phase:"core-recovery-5g-j-local-staging",
    ok,cycles,checks,verifiedChecks:checks.length,
    externalProcessesSignalled:false,externalChannelRestarts:false,
    automaticToolReplay:false,createdAt:Date.now()};
  fs.writeFileSync(filename,JSON.stringify(report,null,2),{flag:"wx",mode:0o600});
  console.log(JSON.stringify({ok,cycles,passed:checks.filter(x=>x.pass).length,
    failed:checks.filter(x=>!x.pass).length,reportPath:filename,
    phase:"core-recovery-5g-j-local-staging"},null,2));
}
