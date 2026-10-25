/**
 * Real local API supervisor smoke test. Uses a unique temporary profile, cwd and
 * port; never touches globally installed SuperAgent, MCP, Muse or Telegram.
 * Kills ONLY subprocess PIDs obtained from this script's own supervisor run.
 */
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { Database } from "bun:sqlite";

const repo = path.resolve(import.meta.dir, "..");
const cli = path.join(repo, "dist", "cli.js");
const stage = fs.mkdtempSync(path.join(os.tmpdir(), "superagent-chat-core-stage-"));
const profile = path.join(stage, "config");
const workspace = path.join(stage, "workspace");
fs.mkdirSync(profile, {recursive: true});
fs.mkdirSync(workspace, {recursive: true});
const env = {...process.env};
for (const key of Object.keys(env)) {
  if (/(?:_KEY|_TOKEN|_PASSWORD|_SECRET|_CREDENTIAL)$/i.test(key) ||
      /^SUPERAGENT_CORE_|^SUPERAGENT_SESSION_ID$/.test(key)) delete env[key];
}
env.SUPERAGENT_CONFIG_DIR = profile;
env.SUPERAGENT_CORE_STAGING = "1";
let supervisor: ChildProcess | undefined;
const ownedPids = new Set<number>();
let stdoutTail = "";
let stderrTail = "";
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const assert = (ok: any, message: string) => { if (!ok) throw new Error(message); };

async function availablePort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((resolve,reject) => {
    srv.once("error",reject);
    srv.listen(0,"127.0.0.1",()=>resolve());
  });
  const address = srv.address();
  assert(address && typeof address !== "string", "No staging port reserved");
  const port = (address as net.AddressInfo).port;
  await new Promise<void>(resolve => srv.close(()=>resolve()));
  return port;
}
async function occupied(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket=net.createConnection({host:"127.0.0.1",port});
    socket.setTimeout(700);
    socket.once("connect",()=>{socket.destroy();resolve(true)});
    socket.once("timeout",()=>{socket.destroy();resolve(false)});
    socket.once("error",()=>{socket.destroy();resolve(false)});
  });
}
async function waitFor<T>(getValue: () => Promise<T | undefined>, ms=28000): Promise<T> {
  const begin=Date.now();
  while(Date.now()-begin<ms){
    const value=await getValue().catch(()=>undefined);
    if(value!==undefined) return value;
    if(supervisor && supervisor.exitCode!==null) throw new Error(
      "Staging supervisor stopped early: "+stderrTail.slice(-600));
    await pause(220);
  }
  throw new Error("Staging readiness timed out: "+stderrTail.slice(-600));
}
function notePid(status: {active:{pid:number};retained:{pid:number}[]}) {
  ownedPids.add(status.active.pid);
  for(const worker of status.retained) ownedPids.add(worker.pid);
}
async function requestJson(port: number, token: string, url: string, init?: RequestInit) {
  const headers = new Headers(init?.headers);
  headers.set("authorization", "Bearer "+token);
  headers.set("x-client-mode","chrome-extension");
  if(init?.body) headers.set("Content-Type","application/json");
  const result=await fetch("http://127.0.0.1:"+port+url,{
    ...init, headers, signal:AbortSignal.timeout(9000)});
  return {code:result.status, data:await result.json().catch(()=>null)};
}
async function cleanDir() {
  for(let n=0;n<12;n++){
    try {fs.rmSync(stage,{recursive:true,force:true}); return;}
    catch(e:any){if(!["EBUSY","EPERM","ENOTEMPTY"].includes(e?.code))throw e;await pause(80+n*50);}
  }
  console.warn("[core-stage] temp directory remains locked; no user profile was modified");
}
const sentinelPorts=[7888,9864,7666];
const sentinelBefore=await Promise.all(sentinelPorts.map(occupied));
let port=0;
try {
  assert(fs.existsSync(cli),"Build dist/cli.js first (bun run build)");
  port=await availablePort();
  assert(!sentinelPorts.includes(port),"Staging port may not overlap live services");
  supervisor=spawn(process.execPath,[cli,"core","start","--port",String(port),
    "--client-mode","chrome-extension"], {
      cwd:workspace,env,windowsHide:true,stdio:["ignore","pipe","pipe"],
    });
  supervisor.stdout?.on("data",part=>{stdoutTail=(stdoutTail+String(part)).slice(-2000)});
  supervisor.stderr?.on("data",part=>{stderrTail=(stderrTail+String(part)).slice(-2000)});
  process.env.SUPERAGENT_CONFIG_DIR=profile;
  const {requestCoreSupervisor}=await import("../src/core/runtime/coreSupervisor.js");
  const initial=await waitFor(async()=>{
    const s=await requestCoreSupervisor("status",port,1200);
    return s?.active?.pid?s:undefined;
  });
  notePid(initial);
  assert(initial.retained.length===0,"Initial staging supervisor unexpectedly has retained workers");
  const serverInfo=JSON.parse(fs.readFileSync(path.join(profile,"server-info-"+port+".json"),"utf8"));
  const authToken=serverInfo.authToken as string;
  assert(typeof authToken==="string"&&authToken.length>=40,"Isolated token missing");
  const initialStatus=await requestJson(port,authToken,"/api/status");
  assert(initialStatus.code===200,"Initial core status unavailable");
  console.log("[core-stage] startup PASS: isolated profile and bearer auth");

  // A fresh staging workspace is safe: no LLM prompt is ever dispatched.
  const id="stage-chat-"+crypto.randomUUID();
  const init=await requestJson(port,authToken,"/api/init",{
    method:"POST",body:JSON.stringify({mode:"single",workspace,sessionId:id})});
  assert(init.code===200&&init.data?.success&&init.data?.sessionId,
    "Staging session init failed: HTTP "+init.code+" "+JSON.stringify(init.data).slice(0,250));
  const sessionId=init.data.sessionId as string;
  const sessionStatus=await requestJson(port,authToken,"/api/status?sessionId="+encodeURIComponent(sessionId));
  assert(sessionStatus.code===200&&sessionStatus.data?.sessionId===sessionId,
    "Staging selected session not resolved");
  const originalPid=initial.active.pid;
  // Establish an actual authenticated SSE connection that stays open over a restart.
  const streamAbort=new AbortController();
  const stream=await fetch("http://127.0.0.1:"+port+"/api/events?sessionId="+encodeURIComponent(sessionId), {
    headers:{Authorization:"Bearer "+authToken,"x-client-mode":"chrome-extension"},
    signal:streamAbort.signal
  });
  assert(stream.ok&&!!stream.body,"Original session SSE stream did not open");
  const reader=stream.body!.getReader();
  const streamFirst=await Promise.race([
    reader.read(),pause(4000).then(()=>{throw new Error("SSE handshake timeout")})
  ]);
  assert(!streamFirst.done,"SSE closed before restart");
  console.log("[core-stage] session init / session affinity / SSE handshake PASS");

  // Simulate a durable in-progress turn owned by the old worker without ever
  // invoking a provider or a tool. New generations must not crash-recover it.
  const sentinelTurn="staging-running-"+crypto.randomUUID();
  const historyPath=path.join(profile,"history.db");
  const stateDb=new Database(historyPath);
  const now=Date.now();
  stateDb.prepare(`INSERT INTO chat_turns
    (turn_id,session_id,workspace,client_mode,digest,message_json,state,created_at,updated_at,started_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(sentinelTurn,sessionId,workspace,
      "chrome-extension","staging-synthetic","\"synthetic only\"","running",now,now,now);
  stateDb.close();

  const afterRestart=await requestCoreSupervisor("restart",port,30000);
  notePid(afterRestart);
  assert(afterRestart.active.pid!==originalPid&&
    afterRestart.retained.some(w=>w.pid===originalPid),
    "Restart failed to preserve old worker");
  const stillPinned=await requestJson(port,authToken,"/api/status?sessionId="+encodeURIComponent(sessionId));
  assert(stillPinned.code===200&&stillPinned.data?.sessionId===sessionId,
    "Old chat lost session affinity on restart");
  const newStatus=await requestJson(port,authToken,"/api/status");
  assert(newStatus.code===200,"New worker did not serve status");
  const readDb=new Database(historyPath);
  const synthetic=readDb.prepare("SELECT state FROM chat_turns WHERE turn_id=?")
    .get(sentinelTurn) as {state:string}|undefined;
  readDb.close();
  assert(synthetic?.state==="running",
    "New core worker incorrectly marked a still-running turn interrupted");
  const nextId="stage-chat-"+crypto.randomUUID();
  const nextInit=await requestJson(port,authToken,"/api/init",{
    method:"POST",body:JSON.stringify({mode:"single",workspace,sessionId:nextId})});
  assert(nextInit.code===200&&nextInit.data?.success&&nextInit.data?.sessionId,
    "New generation failed to initialize its own chat");
  const nextSessionId=nextInit.data.sessionId as string;
  const newSessionStatus=await requestJson(port,authToken,
    "/api/status?sessionId="+encodeURIComponent(nextSessionId));
  assert(newSessionStatus.code===200&&newSessionStatus.data?.sessionId===nextSessionId,
    "New generation did not retain its own chat");
  const heartbeat=await Promise.race([
    reader.read(),pause(18000).then(()=>{throw new Error("Old SSE heartbeat timed out after core restart")}),
  ]);
  assert(!heartbeat.done,"Original SSE stream closed across restart");
  console.log("[core-stage] restart PASS: both chat generations alive, SSE heartbeat received, running turn untouched");

  const afterRollback=await requestCoreSupervisor("rollback",port,30000);
  notePid(afterRollback);
  assert(afterRollback.active.pid===originalPid,
    "Rollback did not reactivate original worker");
  const postRollback=await requestJson(port,authToken,"/api/status?sessionId="+encodeURIComponent(sessionId));
  assert(postRollback.code===200&&postRollback.data?.sessionId===sessionId,
    "Rollback lost session identity");
  const postRollbackNew=await requestJson(port,authToken,
    "/api/status?sessionId="+encodeURIComponent(nextSessionId));
  assert(postRollbackNew.code===200&&postRollbackNew.data?.sessionId===nextSessionId,
    "Rollback lost a chat pinned to the newer retained worker");
  console.log("[core-stage] rollback PASS: both previous and newer sessions retained");

  streamAbort.abort();
  try {await reader.cancel();} catch {}
  const sentinelAfter=await Promise.all(sentinelPorts.map(occupied));
  assert(sentinelBefore.every((before,i)=>!before||sentinelAfter[i]),
    "A pre-existing SuperAgent/MCP listener unexpectedly disappeared");
  console.log("[core-stage] existing endpoints PASS: ports 7888, 9864, 7666 unchanged");
  console.log("[core-stage] RESULT PASS");
} catch(error:any) {
  console.error("[core-stage] RESULT FAIL: "+String(error?.message||error));
  if(stderrTail) console.error("[core-stage] supervisor error tail: "+stderrTail.slice(-750));
  process.exitCode=1;
} finally {
  // Do not kill unknown processes. These worker PIDs came only from the
  // authenticated supervisor started by this very harness in its own profile.
  if (supervisor?.pid) {
    try{supervisor.kill()}catch{}
  }
  for (const pid of ownedPids) {
    if(pid>0&&pid!==process.pid&&pid!==supervisor?.pid) {
      try{process.kill(pid,"SIGTERM")}catch{}
    }
  }
  await pause(500);
  const alive = (pid: number) => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  };
  for (let attempt=0;attempt<8;attempt++) {
    const live=[...ownedPids].filter(alive);
    if (live.length===0) break;
    for (const pid of live) {
      try { process.kill(pid,"SIGTERM"); } catch {}
    }
    await pause(120);
  }
  const remaining=[...ownedPids].filter(alive);
  if (remaining.length) {
    console.error("[core-stage] cleanup FAIL: staged worker processes remain; PIDs: "+remaining.join(","));
    process.exitCode=1;
  } else {
    console.log("[core-stage] cleanup PASS: isolated workers terminated");
  }
  await cleanDir();
}
