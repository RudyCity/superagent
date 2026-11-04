import {describe,it,expect,afterAll} from "vitest";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {spawn,spawnSync,type ChildProcess} from "node:child_process";
import {requestCoreSupervisor} from "../src/core/runtime/coreSupervisor.js";
import {manageServices} from "../src/core/runtime/serviceManager.js";
import {readManagedGuardianOwner} from "../src/core/runtime/managedGuardianEntry.js";
import {readCoreGuardianLease} from "../src/core/runtime/coreGuardian.js";

const old=process.env.SUPERAGENT_CONFIG_DIR;
const temp=fs.mkdtempSync(path.join(os.tmpdir(),"managed-guardian-e2e-"));
process.env.SUPERAGENT_CONFIG_DIR=temp;
let core:ChildProcess|undefined;
let guardianPid:number|undefined;
let workerPid:number|undefined;
const sleepers:Array<()=>Promise<void>>=[];
function killOwned(pid:number|undefined) {
  if(!pid||!Number.isSafeInteger(pid)||pid===process.pid)return;
  try{
    if(process.platform==="win32")
      spawnSync("taskkill",["/PID",String(pid),"/F"],{timeout:3200,stdio:"ignore"});
    else process.kill(pid,"SIGTERM");
  }catch{}
}
async function freePort(){
  const sock=net.createServer();
  return new Promise<number>((res,rej)=>{
    sock.once("error",rej);sock.listen(0,"127.0.0.1",()=>{
      const a=sock.address();
      if(!a||typeof a==="string")return rej(new Error("no port"));
      sock.close(()=>res(a.port));
    });
  });
}
afterAll(async()=>{
  for(const close of sleepers.reverse())await close().catch(()=>{});
  killOwned(guardianPid);
  killOwned(workerPid);
  killOwned(core?.pid);
  await new Promise(resolve=>setTimeout(resolve,900));
  if(old===undefined)delete process.env.SUPERAGENT_CONFIG_DIR;
  else process.env.SUPERAGENT_CONFIG_DIR=old;
  fs.rmSync(temp,{recursive:true,force:true,maxRetries:12,retryDelay:250});
});
describe("Independent managed Guardian via unified MCP/agent service manager",()=>{
  it("attaches, restarts and stops Guardian only; Core supervisor remains alive",async()=>{
    const port=await freePort();
    core=spawn(process.execPath,[path.join(process.cwd(),"src","cli.tsx"),
      "core","start","--port",String(port)],{
      cwd:process.cwd(),stdio:"ignore",windowsHide:true,
      env:{...process.env,SUPERAGENT_CONFIG_DIR:temp,SUPERAGENT_CORE_STAGING:"1"},
    });
    core.on("error",()=>{});
    let status:Awaited<ReturnType<typeof requestCoreSupervisor>>|undefined;
    for(let i=0;i<110;i++){
      try{
        const s=await requestCoreSupervisor("status",port,700);
        if(s.supervisorPid===core.pid){status=s;break;}
      }catch{}
      await new Promise(resolve=>setTimeout(resolve,150));
    }
    if(!status)throw new Error("Test-owned supervised Core not ready");
    workerPid=status.active.pid;
    const plan=await manageServices({action:"plan",service:"guardian",
      port,targetAction:"start"}) as any;
    expect(plan.expectedSupervisorPid).toBe(core.pid);
    const args=(plan:any)=>({
      service:"guardian",action:plan.action,port,confirm:true,
      operationId:plan.operationId,expectedSupervisorPid:plan.expectedSupervisorPid,
      expectedOwnerPid:plan.expectedOwnerPid,
      expectedInstanceId:plan.expectedInstanceId,noCoreShutdown:true,
    });
    const started=await manageServices(args(plan)) as any;
    guardianPid=started.ownerPid;
    expect(guardianPid).toBeGreaterThan(0);
    expect(readManagedGuardianOwner(port)?.pid).toBe(guardianPid);
    expect(readCoreGuardianLease(port)?.pid).toBe(guardianPid);
    expect((await manageServices(args(plan)) as any).replayed).toBe(true);
    await new Promise(resolve=>setTimeout(resolve,1150));
    const next=await manageServices({action:"plan",service:"guardian",
      port,targetAction:"restart"}) as any;
    const restarted=await manageServices(args(next)) as any;
    guardianPid=restarted.ownerPid;
    expect(restarted.previousPid).toBe(started.ownerPid);
    expect(restarted.ownerPid).not.toBe(started.ownerPid);
    expect((await requestCoreSupervisor("status",port)).supervisorPid).toBe(core.pid);
    await new Promise(resolve=>setTimeout(resolve,1150));
    const stop=await manageServices({action:"plan",service:"guardian",
      port,targetAction:"stop"}) as any;
    const stopped=await manageServices(args(stop)) as any;
    expect(stopped.coreUnaffected).toBe(true);
    expect(readManagedGuardianOwner(port)).toBeNull();
    expect(readCoreGuardianLease(port)).toBeNull();
    expect((await manageServices(args(stop)) as any).replayed).toBe(true);
    guardianPid=undefined;
    expect((await requestCoreSupervisor("status",port)).active.pid).toBe(status.active.pid);
  },120000);
  it("never attaches to an unsupervised or missing Core",async()=>{
    await expect(manageServices({action:"plan",service:"guardian",
      port:19981,targetAction:"start"})).rejects.toThrow();
    await expect(manageServices({action:"stop",service:"guardian",
      port:19981,confirm:true})).rejects.toThrow("SERVICE_GUARDIAN_PLAN_REQUIRED");
  },15000);
});
