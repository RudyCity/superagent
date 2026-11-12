import {afterAll,beforeAll,describe,it,expect} from "vitest";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {manageServices} from "../src/core/runtime/serviceManager.js";
import {inspectManagedTray,readManagedTrayOwner}
  from "../src/core/runtime/managedTrayControl.js";
import {readListenerOwners} from "../src/core/runtime/coreMcpOwnershipAudit.js";

const oldRoot=process.env.SUPERAGENT_CONFIG_DIR;
const oldBinary=process.env.SUPERAGENT_TRAY_EXECUTABLE;
const oldSmoke=process.env.SUPERAGENT_TRAY_LIFECYCLE_TEST;
const temp=fs.mkdtempSync(path.join(os.tmpdir(),"managed-tray-e2e-"));
const binary=path.resolve("apps/superagent-tray/src-tauri/target/debug/superagent-tray.exe");
let ownedPid:number|undefined;
beforeAll(()=>{
  expect(fs.existsSync(binary)).toBe(true);
  expect(process.env.VITEST).toBeTruthy();
  process.env.SUPERAGENT_CONFIG_DIR=temp;
  process.env.SUPERAGENT_TRAY_EXECUTABLE=binary;
  process.env.SUPERAGENT_TRAY_LIFECYCLE_TEST="1";
});
afterAll(async()=>{
  const owner=readManagedTrayOwner();
  // Cleanup only the exact test-created debug child; no normal desktop process
  // and no Core/Cloudflare PID is eligible for this test cleanup.
  if(ownedPid&&owner?.pid===ownedPid &&
    readListenerOwners()?.get(owner.controlPort)===ownedPid){
    if(process.platform==="win32")
      spawnSync("taskkill",["/PID",String(ownedPid),"/F"],
        {timeout:3000,stdio:"ignore"});
    else try{process.kill(ownedPid,"SIGTERM");}catch{}
  }
  await new Promise(r=>setTimeout(r,500));
  if(oldRoot===undefined)delete process.env.SUPERAGENT_CONFIG_DIR;
  else process.env.SUPERAGENT_CONFIG_DIR=oldRoot;
  if(oldBinary===undefined)delete process.env.SUPERAGENT_TRAY_EXECUTABLE;
  else process.env.SUPERAGENT_TRAY_EXECUTABLE=oldBinary;
  if(oldSmoke===undefined)delete process.env.SUPERAGENT_TRAY_LIFECYCLE_TEST;
  else process.env.SUPERAGENT_TRAY_LIFECYCLE_TEST=oldSmoke;
  fs.rmSync(temp,{force:true,recursive:true,maxRetries:12,retryDelay:250});
});
async function plan(targetAction:"start"|"stop"|"restart"){
  return await manageServices({action:"plan",service:"tray",targetAction}) as any;
}
async function perform(p:any){
  const {operationId,service,action,expectedOwnerPid,expectedInstanceId,
    expectedBuildDigest,port,noCoreShutdown}=p;
  return await manageServices({operationId,service,action,
    expectedOwnerPid,expectedInstanceId,expectedBuildDigest,
    ...(port?{port}:{}),noCoreShutdown,confirm:true}) as any;
}
describe.skipIf(process.platform !== "win32" || !fs.existsSync(binary))("native Tauri Tray: authentic owner-scoped lifecycle",()=>{
  it("fails closed without a plan, and refuses a stale or forged owner",async()=>{
    await expect(manageServices({action:"stop",service:"tray",confirm:true}))
      .rejects.toThrow("SERVICE_TRAY_PLAN_REQUIRED");
    const forged={version:1,pid:12345678,controlPort:38812,
      instanceId:"a".repeat(32),token:"b".repeat(64),
      executablePath:binary};
    fs.writeFileSync(path.join(temp,"tray-lifecycle-owner.json"),JSON.stringify(forged));
    await expect(plan("stop")).rejects.toThrow("TRAY_NO_VERIFIED_KERNEL_OWNER");
    await expect(plan("start")).rejects.toThrow("TRAY_OWNER_RECORD_EXISTS");
    fs.rmSync(path.join(temp,"tray-lifecycle-owner.json"));
  });
  it("starts, restarts and stops a genuine debug native owner without GUI",async()=>{
    const beginning=await plan("start");
    expect(beginning.expectedOwnerPid).toBe(0);
    expect(beginning.expectedInstanceId).toBe("absent");
    const launched=await perform(beginning);
    ownedPid=launched.ownerPid;
    expect(ownedPid).toBeGreaterThan(0);
    const original=readManagedTrayOwner();
    expect(original?.pid).toBe(ownedPid);
    expect((await inspectManagedTray()).verified).toBe(true);
    const status=await manageServices({action:"status",service:"tray"}) as any;
    expect(status.services[0].ownershipVerified).toBe(true);
    const invalid=await fetch("http://127.0.0.1:"+original!.controlPort+"/tray/health",{
      headers:{"Authorization":"Bearer "+"0".repeat(64)},
      signal:AbortSignal.timeout(2500),
    });
    expect(invalid.status).toBe(401);
    const refused=await fetch("http://127.0.0.1:"+original!.controlPort+"/tray/control",{
      method:"POST",headers:{
        "Authorization":"Bearer "+original!.token,"Content-Type":"application/json",
      },body:JSON.stringify({action:"kill-core",instanceId:original!.instanceId}),
      signal:AbortSignal.timeout(2500),
    });
    expect(refused.status).toBe(400);
    expect((await perform(beginning)).replayed).toBe(true);
    await new Promise(r=>setTimeout(r,1200));
    const next=await plan("restart");
    const restarted=await perform(next);
    ownedPid=restarted.ownerPid;
    expect(restarted.previousPid).toBe(original!.pid);
    expect(restarted.ownerPid).not.toBe(original!.pid);
    expect((await perform(next)).replayed).toBe(true);
    await new Promise(r=>setTimeout(r,1200));
    const stop=await plan("stop");
    const stopped=await perform(stop);
    expect(stopped.ownerPid).toBeNull();
    expect(stopped.coreUnaffected).toBe(true);
    expect((await perform(stop)).replayed).toBe(true);
    expect(readManagedTrayOwner()).toBeNull();
    ownedPid=undefined;
  },90000);
});
