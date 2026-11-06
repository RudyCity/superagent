/**
 * Real Core HTTP -> authenticated loopback -> constrained Tray bridge.
 * Isolated process and config profile; no production Tray or MCP restart.
 */
import {describe,it,expect,afterAll} from "vitest";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {spawn,spawnSync,type ChildProcess} from "node:child_process";
import {requestCoreSupervisor} from "../src/core/runtime/coreSupervisor.js";
import {readCoreCheckpoint} from "../src/core/runtime/coreSupervisorCheckpoint.js";

const prior=process.env.SUPERAGENT_CONFIG_DIR;
const dir=fs.mkdtempSync(path.join(os.tmpdir(),"tray-core-http-e2e-"));
process.env.SUPERAGENT_CONFIG_DIR=dir;
let supervisor:ChildProcess|undefined,workerPid:number|undefined;
function kill(pid:number|undefined){
  if(!pid||!Number.isSafeInteger(pid)||pid===process.pid)return;
  try{
    if(process.platform==="win32")
      spawnSync("taskkill",["/F","/PID",String(pid)],{timeout:3500,stdio:"ignore"});
    else process.kill(pid,"SIGTERM");
  }catch{}
}
async function randomPort(){
  const server=net.createServer();
  return await new Promise<number>((resolve,reject)=>{
    server.once("error",reject);
    server.listen(0,"127.0.0.1",()=>{
      const address=server.address();
      if(!address||typeof address==="string")return reject(Error("No free port"));
      server.close(()=>resolve(address.port));
    });
  });
}
afterAll(async()=>{
  kill(workerPid);kill(supervisor?.pid);
  await new Promise(resolve=>setTimeout(resolve,700));
  if(prior===undefined)delete process.env.SUPERAGENT_CONFIG_DIR;
  else process.env.SUPERAGENT_CONFIG_DIR=prior;
  fs.rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:250});
});
describe("native lifecycle dashboard via actual authenticated Core",()=>{
  it("returns read-only profiles + dashboard and rejects unauthorized/remote/mutating requests",async()=>{
    const port=await randomPort();
    // The source CLI explicitly requires Bun; Node 24 cannot load .tsx entrypoints.
    supervisor=spawn(process.platform==="win32"?"bun.exe":"bun",[
      path.join(process.cwd(),"src","cli.tsx"),
      "core","start","--port",String(port)],{
      cwd:process.cwd(),stdio:"ignore",windowsHide:true,
      env:{...process.env,SUPERAGENT_CONFIG_DIR:dir,SUPERAGENT_CORE_STAGING:"1"},
    });
    supervisor.on("error",()=>{});
    let live:Awaited<ReturnType<typeof requestCoreSupervisor>>|null=null;
    for(let i=0;i<125;i++){
      try{
        const status=await requestCoreSupervisor("status",port,650);
        if(status.supervisorPid===supervisor.pid){live=status;break;}
      }catch{}
      await new Promise(resolve=>setTimeout(resolve,160));
    }
    if(!live)throw Error("Staging Core not ready");
    workerPid=live.active.pid;
    const token=readCoreCheckpoint(port).serverToken;
    expect(token.length).toBeGreaterThan(20);
    async function call(body:unknown,headers:Record<string,string>={}){
      const response=await fetch("http://127.0.0.1:"+port+"/api/desktop/lifecycle",{
        method:"POST",headers:{"Content-Type":"application/json",
          ...headers},body:JSON.stringify(body),signal:AbortSignal.timeout(16000),
      });
      return {code:response.status,data:await response.json() as any};
    }
    const unauthorized=await call({action:"profile"});
    expect(unauthorized.code).toBe(401);
    const auth={Authorization:"Bearer "+token};
    const profile=await call({action:"profile",service:"tray"},auth);
    expect(profile.code).toBe(200);
    expect(profile.data.success).toBe(true);
    expect(profile.data.data.profiles[0].service).toBe("tray");
    const dashboard=await call({action:"dashboard",service:"tray",limit:5},auth);
    expect(dashboard.code).toBe(200);
    expect(dashboard.data.data.summary.total).toBe(1);
    const remote=await call({action:"profile"},
      {...auth,"X-Forwarded-For":"203.0.113.1"});
    expect(remote.code).toBe(403);
    const bad=await call({action:"stop",service:"rest_tunnel",
      confirm:true,operationId:"native-stage-invalid"},auth);
    expect(bad.code).toBe(409);
    const blocked=await call({action:"watchdog",confirm:true},auth);
    expect(blocked.code).toBe(409);
    expect((await requestCoreSupervisor("status",port)).active.pid).toBe(workerPid);
  },130000);
});
