import {describe,it,expect,afterAll} from "vitest";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {spawn,spawnSync,type ChildProcess} from "node:child_process";
import {requestCoreSupervisor} from "../src/core/runtime/coreSupervisor.js";
import {manageServices} from "../src/core/runtime/serviceManager.js";
import {inspectDaemonScheduler} from "../src/core/runtime/managedDaemonControl.js";

const old=process.env.SUPERAGENT_CONFIG_DIR;
const dir=fs.mkdtempSync(path.join(os.tmpdir(),"managed-daemon-e2e-"));
process.env.SUPERAGENT_CONFIG_DIR=dir;
let owner:ChildProcess|undefined,workerPid:number|undefined;
const kill=(pid:number|undefined)=>{
  if(!pid||pid===process.pid)return;
  try {
    if(process.platform==="win32")
      spawnSync("taskkill",["/F","/PID",String(pid)],{stdio:"ignore",timeout:3000});
    else process.kill(pid,"SIGTERM");
  }catch{}
};
async function freePort(){
  const server=net.createServer();
  return new Promise<number>((resolve,reject)=>{
    server.once("error",reject);
    server.listen(0,"127.0.0.1",()=>{
      const a=server.address();
      if(!a||typeof a==="string")return reject(new Error("no free port"));
      server.close(()=>resolve(a.port));
    });
  });
}
afterAll(async()=>{
  kill(workerPid);kill(owner?.pid);
  await new Promise(resolve=>setTimeout(resolve,700));
  if(old===undefined)delete process.env.SUPERAGENT_CONFIG_DIR;
  else process.env.SUPERAGENT_CONFIG_DIR=old;
  fs.rmSync(dir,{recursive:true,force:true,maxRetries:12,retryDelay:250});
});
describe("authenticated Core daemon/cron lifecycle via unified service manager",()=>{
  it("starts, restarts, stops, and replay-protects only the embedded scheduler",async()=>{
    const port=await freePort();
    owner=spawn(process.execPath,[path.join(process.cwd(),"src","cli.tsx"),
      "core","start","--port",String(port)],{
      cwd:process.cwd(),stdio:"ignore",windowsHide:true,
      env:{...process.env,SUPERAGENT_CONFIG_DIR:dir,SUPERAGENT_CORE_STAGING:"1"},
    });
    owner.on("error",()=>{});
    let supervisor:Awaited<ReturnType<typeof requestCoreSupervisor>>|undefined;
    for(let i=0;i<120;i++){
      try{
        const x=await requestCoreSupervisor("status",port,700);
        if(x.supervisorPid===owner.pid){supervisor=x;break;}
      }catch{}
      await new Promise(resolve=>setTimeout(resolve,160));
    }
    if(!supervisor)throw new Error("isolated Core unavailable");
    workerPid=supervisor.active.pid;
    const current=await inspectDaemonScheduler(port);
    expect(current.verified).toBe(true);
    expect(current.workerPid).toBe(workerPid);
    const values=(plan:any)=>({
      action:plan.action,service:"daemon",port,confirm:true,
      operationId:plan.operationId,
      expectedSupervisorPid:plan.expectedSupervisorPid,
      expectedWorkerPid:plan.expectedWorkerPid,
      expectedRunning:plan.expectedRunning,noActiveJobs:true,
    });
    const first=await manageServices({action:"plan",service:"daemon",
      port,targetAction:"start"}) as any;
    const started=await manageServices(values(first)) as any;
    expect(started.running).toBe(true);
    expect(started.workerPid).toBe(workerPid);
    expect((await manageServices(values(first)) as any).replayed).toBe(true);
    await new Promise(resolve=>setTimeout(resolve,1150));
    const next=await manageServices({action:"plan",service:"daemon",
      port,targetAction:"restart"}) as any;
    expect((await manageServices(values(next)) as any).running).toBe(true);
    await new Promise(resolve=>setTimeout(resolve,1150));
    const stop=await manageServices({action:"plan",service:"daemon",
      port,targetAction:"stop"}) as any;
    expect((await manageServices(values(stop)) as any).running).toBe(false);
    expect((await manageServices(values(stop)) as any).replayed).toBe(true);
    const after=await requestCoreSupervisor("status",port);
    expect(after.supervisorPid).toBe(owner.pid);
    expect(after.active.pid).toBe(workerPid);
  },125000);
  it("does not manage a daemon attached to an unsupervised or absent Core",async()=>{
    await expect(manageServices({action:"plan",service:"daemon",
      port:19981,targetAction:"stop"})).rejects.toThrow();
    await expect(manageServices({action:"start",service:"daemon",
      port:19981,confirm:true})).rejects.toThrow("SERVICE_DAEMON_PLAN_REQUIRED");
  },15000);
});
