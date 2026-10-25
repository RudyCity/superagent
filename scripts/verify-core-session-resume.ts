/**
 * Local-only supervisor and dead-worker explicit session rebind acceptance.
 * Never contacts a model, starts external connectors, or kills a non-owned PID.
 */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";

const repo = path.resolve(import.meta.dir, "..");
const entry = path.join(repo, "dist", "cli.js");
if (!fs.existsSync(entry)) throw new Error("Run bun run build first");
const base = path.join(os.homedir(), ".superagent-local-staging");
fs.mkdirSync(base, { recursive: true, mode: 0o700 });
const root = fs.mkdtempSync(path.join(base, "core-session-" + crypto.randomBytes(4).toString("hex") + "-"));
const profile = path.join(root, "config");
const workspace = path.join(root, "workspace");
fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
const previousConfig = process.env.SUPERAGENT_CONFIG_DIR;
const env: NodeJS.ProcessEnv = { ...process.env };
for (const key of Object.keys(env)) {
  if (/(?:_KEY|_TOKEN|_PASSWORD|_SECRET|_CREDENTIAL)$/i.test(key) ||
      /^(?:SUPERAGENT_CORE_|SUPERAGENT_MUSE_|SUPERAGENT_SESSION_ID$)/.test(key)) delete env[key];
}
env.SUPERAGENT_CONFIG_DIR = profile;
env.SUPERAGENT_CORE_STAGING = "1";
env.HOME = root;
env.USERPROFILE = root;
process.env.SUPERAGENT_CONFIG_DIR = profile;
delete process.env.SUPERAGENT_SESSION_ID;
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function port() {
  const srv = net.createServer();
  await new Promise<void>((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = srv.address();
  const p = addr && typeof addr !== "string" ? addr.port : 0;
  await new Promise<void>(resolve => srv.close(() => resolve()));
  if (p <= 0 || p === 7888 || p === 7666 || p === 9864) throw new Error("Unsafe test port");
  return p;
}
function killOwned(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/F", "/PID", String(pid)], {
        encoding:"utf8", windowsHide: true, timeout: 5000,
      });
    } else process.kill(pid, "SIGKILL");
  } catch {}
}
async function eventually<T>(f: () => Promise<T | null>, limit = 40_000): Promise<T> {
  const start = Date.now();
  let last = "";
  while (Date.now() - start < limit) {
    try { const result = await f(); if (result !== null) return result; }
    catch (err) { last = String(err).slice(0, 190); }
    await wait(250);
  }
  throw new Error("Stage timed out: " + last);
}
async function api(p: number, token: string, route: string, data?: object) {
  const response = await fetch("http://127.0.0.1:" + p + route, {
    method: data ? "POST" : "GET",
    headers: { Authorization: "Bearer " + token, "x-client-mode":"tline",
      ...(data ? {"Content-Type":"application/json"} : {}) },
    body: data ? JSON.stringify(data) : undefined, signal: AbortSignal.timeout(5500),
  });
  return { status:response.status, body:await response.json().catch(() => ({})) as Record<string, any> };
}
const checks: string[] = [];
function check(name: string, yes: unknown) {
  if (!yes) throw new Error("Stage assertion failed: " + name);
  checks.push(name);
}
const owned = new Set<number>();
let supervisor: ChildProcess | null = null;
let stderr = "";
try {
  const { requestCoreSupervisor } = await import("../src/core/runtime/coreSupervisor.js");
  const { readCoreAgentSessionReceipt } = await import("../src/core/runtime/coreAgentSessionCheckpoint.js");
  const { saveSessionToDb } = await import("../src/core/storage/historyDb.js");
  const { acceptChatTurn } = await import("../src/core/utils/chatRuntimeLedger.js");
  const p = await port();
  supervisor = spawn(process.execPath, [entry, "core", "start",
    "--port", String(p), "--client-mode", "tline"], {
    cwd: workspace, env, stdio:["ignore","ignore","pipe"], windowsHide:true,
  });
  if (!supervisor.pid) throw new Error("No staging supervisor PID");
  owned.add(supervisor.pid);
  supervisor.stderr?.on("data", data => { stderr = (stderr + String(data)).slice(-800); });
  const first = await eventually(async () => {
    const status = await requestCoreSupervisor("status",p,1200);
    return status.supervisorPid === supervisor?.pid ? status : null;
  });
  owned.add(first.active.pid);
  const token = JSON.parse(fs.readFileSync(path.join(profile,"server-info-"+p+".json"),"utf8")).authToken;
  const id = "checkpoint_" + crypto.randomBytes(6).toString("hex");
  const unsafe = "pending_" + crypto.randomBytes(6).toString("hex");
  for (const sid of [id,unsafe]) {
    const result = await api(p,token,"/api/init",{sessionId:sid,workspace,mode:"single"});
    check("initial_session_created_"+sid.slice(0,8),
      result.status===200 && result.body.sessionId===sid);
    const receipt=readCoreAgentSessionReceipt(sid);
    check("fresh_session_receipt_"+sid.slice(0,8),
      receipt?.sessionId===sid && receipt.workspace===workspace);
  }
  const switched="switch_"+crypto.randomBytes(6).toString("hex");
  const switchResult=await api(p,token,"/api/switch-workspace",{
    sessionId:switched,workspace,mode:"single",
  });
  check("switch_workspace_creates_durable_receipt",
    switchResult.status===200 &&
    readCoreAgentSessionReceipt(switched)?.sessionId===switched);
  const unsaved = acceptChatTurn({
    turnId:"unsafe_"+crypto.randomBytes(8).toString("hex"),
    sessionId:unsafe,workspace,clientMode:"tline",message:"staging metadata only",
  });
  check("unsafe_turn_is_still_durable",unsaved.turn.state==="accepted");
  const next=await requestCoreSupervisor("restart",p,28000);
  owned.add(next.active.pid);
  check("second_worker_healthy",next.active.pid!==first.active.pid);
  const beforeCrash=await api(p,token,"/api/status?sessionId="+id);
  check("original_worker_keeps_session_until_crash",
    beforeCrash.status===200 && beforeCrash.body.sessionId===id);
  killOwned(first.active.pid);
  await eventually(async () => {
    const response=await api(p,token,"/api/status?sessionId="+id);
    return response.status===503 ? true : null;
  },18000);
  check("dead_worker_requests_fail_closed",true);
  const forbidden=await api(p,token,"/api/init",{sessionId:id,workspace,mode:"single"});
  check("implicit_migration_denied",forbidden.status===503);
  const missing=await api(p,token,"/api/init",{sessionId:id,resume:id,workspace,mode:"single"});
  check("missing_durable_history_denied",
    missing.status===409 && String(missing.body.error).includes("history_missing"));
  const blocked=await api(p,token,"/api/init",{sessionId:unsafe,resume:unsafe,workspace,mode:"single"});
  check("pending_turn_denied_without_replay",
    blocked.status===409 && String(blocked.body.error).includes("history_missing"));
  const unsafeHistoryFile=path.join(profile,"history","single",unsafe,unsafe+".json");
  fs.mkdirSync(path.dirname(unsafeHistoryFile),{recursive:true});
  fs.writeFileSync(unsafeHistoryFile,"{}",{mode:0o600});
  const savedAt=Date.now();
  saveSessionToDb({
    id:unsafe,filePath:unsafeHistoryFile,displayName:"unsafe staging review",
    messageCount:1,lastModified:savedAt,preview:"review",workingDirectory:workspace,
  },[{sessionId:unsafe,role:"user",content:"unsafe turn must not replay",timestamp:savedAt,sequenceOrder:0}]);
  const blockedWithHistory=await api(p,token,"/api/init",{
    sessionId:unsafe,resume:unsafe,workspace,mode:"single",
  });
  check("ambiguous_turn_denied_even_with_saved_history",
    blockedWithHistory.status===409 &&
    String(blockedWithHistory.body.error).includes("requires_review"));
  const fakeHistoryFile=path.join(profile,"history","single",id,id+".json");
  fs.mkdirSync(path.dirname(fakeHistoryFile),{recursive:true});
  fs.writeFileSync(fakeHistoryFile,"{}",{mode:0o600});
  const now=Date.now();
  saveSessionToDb({
    id,filePath:fakeHistoryFile,displayName:"staging safe history",messageCount:1,
    lastModified:now,preview:"staging",workingDirectory:workspace,
  },[{sessionId:id,role:"user",content:"staging safe saved context",timestamp:now,sequenceOrder:0}]);
  const wrongWorkspace=await api(p,token,"/api/init",{
    sessionId:id,resume:id,workspace:path.join(root,"other"),mode:"single",
  });
  check("workspace_scope_mismatch_denied",wrongWorkspace.status!==200);
  const recovered=await api(p,token,"/api/init",{sessionId:id,resume:id,workspace,mode:"single"});
  check("explicit_resume_from_verified_history",
    recovered.status===200 && recovered.body.sessionId===id);
  const pinned = await requestCoreSupervisor("status",p,2000);
  check("atomic_affinity_routed_to_new_worker",
    pinned.affinitySessions===3 && pinned.active.pid===next.active.pid);
  const activeNow=await api(p,token,"/api/status?sessionId="+id);
  check("old_session_accessible_after_explicit_resume",
    activeNow.status===200 && activeNow.body.sessionId===id);
  const readUnsafe=await api(p,token,"/api/chat",{sessionId:unsafe,message:"another message"});
  check("unsafe_session_not_migrated_for_chat",readUnsafe.status===503);
  const switchedResult=await api(p,token,"/api/switch-workspace",{
    sessionId:switched,workspace,mode:"single",
  });
  check("switch_workspace_cannot_implicitly_rebind_dead_session",
    switchedResult.status===503);
  const report={ok:true,phase:"core-session-explicit-resume",root,port:p,
    verifiedChecks:checks.length,checks,externalToolsCalled:0,notificationsSent:0,
    verifiedOldWorkerExited:true,implicitReplay:false,createdAt:Date.now()};
  fs.writeFileSync(path.join(root,"report.json"),JSON.stringify(report,null,2),{mode:0o600,flag:"wx"});
  console.log(JSON.stringify(report,null,2));
} catch (err) {
  console.error("CORE_SESSION_STAGE_FAILED: " + String(err) + " " + stderr.slice(-330));
  process.exitCode=1;
} finally {
  if (supervisor?.pid) killOwned(supervisor.pid);
  for (const pid of owned) killOwned(pid);
  if (previousConfig===undefined) delete process.env.SUPERAGENT_CONFIG_DIR;
  else process.env.SUPERAGENT_CONFIG_DIR=previousConfig;
}
