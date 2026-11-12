import {describe,it,expect,afterAll} from "vitest";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {manageServices} from "../src/core/runtime/serviceManager.js";
import {readTransportOwner} from "../src/core/runtime/transportHost.js";
import {readChannelHostDiscovery} from "../src/core/runtime/channelHost.js";
import {readListenerOwners} from "../src/core/runtime/coreMcpOwnershipAudit.js";

const profileBefore=process.env.SUPERAGENT_CONFIG_DIR;
const testProfile=fs.mkdtempSync(path.join(os.tmpdir(),"managed-sidecar-e2e-"));
process.env.SUPERAGENT_CONFIG_DIR=testProfile;
const own=new Map<number,number>();
async function randomPort(){
  const server=net.createServer();
  return new Promise<number>((resolve,reject)=>{
    server.once("error",reject);
    server.listen(0,"127.0.0.1",()=>{
      const address=server.address();
      if(!address||typeof address==="string")return reject(new Error("No isolated port"));
      server.close(()=>resolve(address.port));
    });
  });
}
function ownedCleanup(pid:number) {
  if(!Number.isSafeInteger(pid)||pid<=0||pid===process.pid)return;
  try {
    if(process.platform==="win32")
      spawnSync("taskkill",["/PID",String(pid),"/F"],{stdio:"ignore",timeout:2500});
    else process.kill(pid,"SIGTERM");
  }catch{}
}
afterAll(async()=>{
  for(const [port,pid] of own) {
    if(readListenerOwners()?.get(port)===pid)ownedCleanup(pid);
  }
  await new Promise(resolve=>setTimeout(resolve,450));
  if(profileBefore===undefined)delete process.env.SUPERAGENT_CONFIG_DIR;
  else process.env.SUPERAGENT_CONFIG_DIR=profileBefore;
  fs.rmSync(testProfile,{recursive:true,force:true,maxRetries:10,retryDelay:250});
});
async function prepare(service:"transport"|"channel_host",port:number,targetAction:"start"|"stop"|"restart"){
  return await manageServices({
    service,port,action:"plan",targetAction,
    ...(service==="transport"?{corePort:18888}: {channelMode:"idle",wsPort:19225}),
  }) as any;
}
async function execute(plan:any){
  const {service,action,port,operationId,expectedOwnerPid,expectedInstanceId,
    corePort,channelMode,wsPort,noPublicIngress}=plan;
  return await manageServices({service,action,port,operationId,expectedOwnerPid,
    expectedInstanceId,corePort,channelMode,wsPort,noPublicIngress,confirm:true}) as any;
}
describe("SuperAgent opt-in owned sidecar lifecycle integration",()=>{
  it("starts, restarts, stops and safely replays an independent T-Line Transport",async()=>{
    const port=await randomPort();
    const start=await prepare("transport",port,"start");
    expect(start.expectedOwnerPid).toBe(0);
    const opened=await execute(start);
    own.set(port,opened.ownerPid);
    expect(opened.ownerPid).toBeGreaterThan(0);
    expect(readTransportOwner(port)?.pid).toBe(opened.ownerPid);
    expect((await manageServices({action:"status",service:"transport",port}) as any)
      .services[0].ownershipVerified).toBe(true);
    const repeated=await execute(start);
    expect(repeated.replayed).toBe(true);
    expect(repeated.ownerPid).toBe(opened.ownerPid);
    await expect(prepare("transport",port,"start")).rejects.toThrow("SIDECAR_STALE_OR_ACTIVE_OWNER_RECORD");
    await new Promise(resolve=>setTimeout(resolve,1250));
    const restart=await prepare("transport",port,"restart");
    const swapped=await execute(restart);
    own.set(port,swapped.ownerPid);
    expect(swapped.ownerPid).not.toBe(opened.ownerPid);
    expect((await execute(restart)).replayed).toBe(true);
    await new Promise(resolve=>setTimeout(resolve,1250));
    const stop=await prepare("transport",port,"stop");
    expect((await execute(stop)).ownerPid).toBeNull();
    expect((await execute(stop)).replayed).toBe(true);
    expect(readTransportOwner(port)).toBeNull();
    own.delete(port);
  },90000);
  it("starts/stops idle Channel Host without connecting to Muse or Telegram",async()=>{
    const port=await randomPort();
    const start=await prepare("channel_host",port,"start");
    const opened=await execute(start);
    own.set(port,opened.ownerPid);
    expect(readChannelHostDiscovery(port).pid).toBe(opened.ownerPid);
    const status=(await manageServices({action:"status",service:"channel_host",port}) as any).services[0];
    expect(status.ownershipVerified).toBe(true);
    expect(status.details.mode).toBe("idle");
    // Production ledger deliberately enforces a 1-second cooldown between mutations.
    await new Promise(resolve => setTimeout(resolve, 1100));
    const stop=await prepare("channel_host",port,"stop");
    expect((await execute(stop)).ownerPid).toBeNull();
    expect((await execute(stop)).replayed).toBe(true);
    own.delete(port);
  },90000);
  it("never adopts foreign listeners or runs unsupported service process kills",async()=>{
    const listener=net.createServer();
    const port=await randomPort();
    await new Promise<void>(resolve=>listener.listen(port,"127.0.0.1",()=>resolve()));
    try{
      await expect(prepare("transport",port,"start")).rejects.toThrow();
    }finally{await new Promise<void>(resolve=>listener.close(()=>resolve()));}
    await expect(manageServices({action:"stop",service:"vision",port,confirm:true}))
      .rejects.toThrow("SERVICE_VISION_PLAN_REQUIRED");
  },30000);
});
