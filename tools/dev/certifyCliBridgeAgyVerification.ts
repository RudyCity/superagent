/**
 * Real AGY CLI Bridge verified-completion certification.
 * Uses disposable workspace/config. Never enables full-auto.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";

type R = { id:string; expected:string; observed:string; pass:boolean; jobId?:string; note?:string };

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "superagent-agy-cert-"));
const foreign = await fs.mkdtemp(path.join(os.tmpdir(), "superagent-agy-foreign-"));
const config = path.join(root, ".config");
const capacity = path.join(root, ".capacity");
process.env.SUPERAGENT_CONFIG_DIR = config;
process.env.SUPERAGENT_CLI_BRIDGE_CAPACITY_DIR = capacity;
process.env.SUPERAGENT_CLI_BRIDGE_MAX_JOBS = "4";

await fs.mkdir(path.join(config, "cli-bridge"), { recursive:true });
await fs.writeFile(path.join(config, "cli-bridge", "verification-profiles.json"), JSON.stringify({
  e3: { tests: ["node -e \"const fs=require('fs');const p='e3-verified.txt';process.exit(fs.existsSync(p)&&fs.readFileSync(p,'utf8').trim()==='E3_VERIFIED_OK'?0:3)\""] },
  e4_fail: { tests: ["node -e \"process.exit(7)\""] }
}, null, 2), "utf8");
await execa("git", ["init"], { cwd:root });
await execa("git", ["config","user.email","agy-cert@example.invalid"], { cwd:root });
await execa("git", ["config","user.name","AGY Certification"], { cwd:root });
await fs.writeFile(path.join(root, "README.md"), "# AGY certification scratch\n", "utf8");
await execa("git", ["add","README.md"], { cwd:root });
await execa("git", ["commit","-m","baseline"], { cwd:root });

const { cliBridgeTool } = await import("../../src/core/tools/cliBridgeTool.js");
const jobs = await import("../../src/core/tools/cliBridgeDelegateJobs.js");
const { persistJobShard, jobShardPath } = await import("../../src/core/tools/cliBridgeJobStore.js");
const { listDetailedCapacitySlots } = await import("../../src/core/tools/cliBridgeCapacity.js");

const results:R[] = [];
const started = new Set<string>();
function add(r:R){ results.push(r); console.log((r.pass ? "PASS " : "FAIL ") + r.id + ": " + r.observed); }
function idFrom(v:unknown){
  const id = String(v).match(/clj_\d+_[a-f0-9]+/)?.[0];
  if(!id) throw new Error("No job id in: " + String(v).slice(0,300));
  started.add(id);
  return id;
}
async function wait(id:string, ms=210000){
  const end = Date.now()+ms;
  while(Date.now()<end){
    const j = await jobs.getDelegateJob(id);
    if(j && !["starting","running","verifying","cancelling"].includes(j.status)) return j;
    await new Promise(r=>setTimeout(r,250));
  }
  throw new Error("Timeout waiting " + id);
}
async function agy(tag:string, prompt:string, extra:Record<string,unknown>={}){
  const out = await cliBridgeTool.execute({
    action:"delegate.start", cli:"agy", prompt, cwd:root,
    injectArtifacts:false, skillAutoDetect:false, timeoutMs:180000,
    idempotencyKey:"cert-"+stamp+"-"+tag, ...extra
  }, root);
  const id = idFrom(out);
  return { id, job:await wait(id) };
}

try {
  const e1 = await agy("e1", "Do not use tools. Reply exactly AGY_E1_OK and finish.", { permissionMode:"plan" });
  add({ id:"E1", expected:"PROCESS_OK / UNVERIFIED", observed:e1.job.status+"/"+e1.job.completionState,
    pass:e1.job.status==="succeeded" && e1.job.completionState==="unverified", jobId:e1.id });

  const foreignView = String(await cliBridgeTool.execute({ action:"delegate.get", jobId:e1.id }, foreign));
  add({ id:"E10", expected:"cross-workspace hidden", observed:foreignView.slice(0,160),
    pass:/not found in the authorized workspace/i.test(foreignView) && !foreignView.includes(e1.id), jobId:e1.id });

  const e2 = await agy("e2",
    "Create e2-artifact.txt containing exactly E2_ARTIFACT_OK using a file editing/write tool, not shell. Then finish.",
    { permissionMode:"accept-edits", expectedArtifacts:["e2-artifact.txt"] });
  add({ id:"E2", expected:"artifacts_verified", observed:e2.job.status+"/"+e2.job.completionState,
    pass:e2.job.status==="succeeded" && e2.job.completionState==="artifacts_verified", jobId:e2.id });

  const e3 = await agy("e3",
    "Create e3-verified.txt containing exactly E3_VERIFIED_OK using a file editing/write tool, not shell. Then finish.",
    { permissionMode:"accept-edits", acceptanceContract:{
      artifacts:[{path:"e3-verified.txt",minBytes:10}], verificationProfile:"e3"
    }});
  add({ id:"E3", expected:"verified", observed:e3.job.status+"/"+e3.job.completionState,
    pass:e3.job.status==="succeeded" && e3.job.completionState==="verified", jobId:e3.id });

  const e4 = await agy("e4",
    "Create e4-verifier-fail.txt containing exactly E4_AGENT_OK using a file editing/write tool, not shell. Then finish.",
    { permissionMode:"accept-edits", acceptanceContract:{
      artifacts:[{path:"e4-verifier-fail.txt"}], verificationProfile:"e4_fail"
    }});
  add({ id:"E4", expected:"verification_failed", observed:e4.job.status+"/"+e4.job.completionState,
    pass:e4.job.exitCode===0 && e4.job.completionState==="verification_failed", jobId:e4.id });

  const e5 = await agy("e5",
    "Do not create files and do not use tools. Reply exactly E5_NO_ARTIFACT and finish.",
    { permissionMode:"plan", acceptanceContract:{ artifacts:[{path:"e5-missing.txt"}] } });
  add({ id:"E5", expected:"missing artifact fails", observed:e5.job.status+"/"+e5.job.completionState,
    pass:e5.job.exitCode===0 && e5.job.completionState==="verification_failed" &&
      /required artifact/i.test(e5.job.verificationResult?.failureReason || ""), jobId:e5.id });

  const e6 = await agy("e6",
    "Use the command/shell tool to run exactly git diff --stat . Then report it and finish. Do not bypass a permission prompt.",
    { permissionMode:"accept-edits" });
  const e6ok = e6.job.status==="permission_blocked" && e6.job.completionState==="permission_blocked";
  add({ id:"E6", expected:"permission_blocked if command approval required",
    observed:e6.job.status+"/"+e6.job.completionState, pass:e6ok, jobId:e6.id,
    note:e6ok ? undefined : "AGY policy did not emit denied_actions on this machine." });

  const tj = await jobs.startDelegateJob({ cliAlias:"cert-timeout", binary:process.execPath, prompt:"timeout",
    cwd:root, workspaceRoot:root, args:["-e","setTimeout(()=>{},5000)"], timeoutMs:1000 });
  started.add(tj.jobId);
  const tf = await wait(tj.jobId,10000);
  const cj = await jobs.startDelegateJob({ cliAlias:"cert-cancel", binary:process.execPath, prompt:"cancel",
    cwd:root, workspaceRoot:root, args:["-e","setTimeout(()=>{},10000)"], timeoutMs:30000 });
  started.add(cj.jobId);
  await jobs.cancelDelegateJob(cj.jobId);
  const cf = await wait(cj.jobId,10000);
  add({ id:"E7", expected:"timeout/cancel never verified",
    observed:"timeout="+tf.status+"/"+tf.completionState+" cancel="+cf.status+"/"+cf.completionState,
    pass:tf.completionState==="timed_out" && cf.completionState==="cancelled" });

  const staleId = "clj_"+Date.now()+"_feedbeef";
  const jobsDir = path.join(config, "cli-bridge", "delegations");
  await persistJobShard(jobsDir, {
    jobId:staleId, cliAlias:"stale-cert", binary:process.execPath, cwd:root, workspaceRoot:root,
    ownerPid:2147483000, pid:2147483001, status:"running", completionState:"pending",
    startedAt:Date.now(), updatedAt:Date.now(), exitCode:null, timedOut:false, timeoutMs:30000,
    outputTail:"", outputBytes:0, logPath:path.join(root,"stale.log")
  });
  const rv = String(await cliBridgeTool.execute({ action:"delegate.get", jobId:staleId }, root));
  add({ id:"E8", expected:"REVIEW_REQUIRED no replay", observed:(rv.match(/Task outcome: .*/)?.[0] || rv.slice(0,150)),
    pass:rv.includes("Task outcome: REVIEW_REQUIRED") && rv.includes("unknown_outcome_review_required"), jobId:staleId });
  await fs.rm(jobShardPath(jobsDir,staleId), { recursive:true, force:true });

  const four = await Promise.all(["ALPHA","BETA","GAMMA","DELTA"].map(async label => {
    const out = await cliBridgeTool.execute({
      action:"delegate.start", cli:"agy", prompt:"Do not use tools. Reply exactly AGY_E9_"+label+" and finish.",
      cwd:root, injectArtifacts:false, skillAutoDetect:false, permissionMode:"plan", timeoutMs:180000,
      idempotencyKey:"cert-"+stamp+"-e9-"+label.toLowerCase()
    }, root);
    return wait(idFrom(out));
  }));
  const slots = await listDetailedCapacitySlots(4,{capacityDir:capacity});
  add({ id:"E9", expected:"4 AGY jobs and zero leaked slots",
    observed:four.map(j=>j.status+"/"+j.completionState).join(";"),
    pass:four.length===4 && four.every(j=>j.status==="succeeded" && j.completionState==="unverified") &&
      slots.every(s=>!s.occupied) });

  const summary = { schemaVersion:1, generatedAt:new Date().toISOString(),
    branch:"fix/agy-verified-completion-20261028", permissionPolicy:"No full-auto used",
    results, passed:results.filter(r=>r.pass).length, failed:results.filter(r=>!r.pass).length,
    allPassed:results.every(r=>r.pass) };
  const reportDir = path.resolve("build","reports");
  const report = path.join(reportDir,"cli-bridge-agy-verification-"+stamp+".json");
  await fs.mkdir(reportDir,{recursive:true});
  await fs.writeFile(report,JSON.stringify(summary,null,2),"utf8");
  console.log("REPORT "+report);
  console.log("SUMMARY "+summary.passed+"/"+results.length+" passed");
  process.exitCode = summary.allPassed ? 0 : 2;
} finally {
  for(const id of started){
    const j = await jobs.getDelegateJob(id).catch(()=>null);
    if(j && ["starting","running","verifying","cancelling"].includes(j.status)){
      await jobs.cancelDelegateJob(id).catch(()=>{});
    }
  }
  await fs.rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100}).catch(()=>{});
  await fs.rm(foreign,{recursive:true,force:true,maxRetries:8,retryDelay:100}).catch(()=>{});
}
