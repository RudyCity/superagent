import {describe,it,expect,afterAll} from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import {spawnSync} from "node:child_process";
import {manageServices} from "../src/core/runtime/serviceManager.js";
import {inspectManagedVision,readVisionOwner} from "../src/core/runtime/managedVisionControl.js";
import {readListenerOwners} from "../src/core/runtime/coreMcpOwnershipAudit.js";

const original=process.env.PYTHONPATH;
const oldProfile=process.env.SUPERAGENT_CONFIG_DIR;
const testProfile=fs.mkdtempSync(path.join(os.tmpdir(),"managed-vision-e2e-"));
process.env.SUPERAGENT_CONFIG_DIR=testProfile;
const fixture=fs.mkdtempSync(path.join(os.tmpdir(),"vision-stub-"));
const owned=new Map<number,number>();
async function freePort(){
  const server=net.createServer();
  return new Promise<number>((resolve,reject)=>{
    server.once("error",reject);
    server.listen(0,"127.0.0.1",()=>{
      const addr=server.address();
      if(!addr||typeof addr==="string")return reject(new Error("No port"));
      server.close(()=>resolve(addr.port));
    });
  });
}
const operation=async(plan:any)=>{
  const {service,action,port,operationId,expectedOwnerPid,expectedInstanceId,
    noPublicIngress}=plan;
  return await manageServices({service,action,port,operationId,
    expectedOwnerPid,expectedInstanceId,noPublicIngress,confirm:true}) as any;
};
afterAll(()=>{
  for(const [port,pid] of owned){
    if(readVisionOwner(port)?.pid===pid&&readListenerOwners()?.get(port)===pid)
      try{
        if(process.platform==="win32")
          spawnSync("taskkill",["/F","/PID",String(pid)],{stdio:"ignore",timeout:2500});
        else process.kill(pid,"SIGTERM");
      }catch{}
  }
  if(original===undefined)delete process.env.PYTHONPATH;
  else process.env.PYTHONPATH=original;
  if(oldProfile===undefined)delete process.env.SUPERAGENT_CONFIG_DIR;
  else process.env.SUPERAGENT_CONFIG_DIR=oldProfile;
  fs.rmSync(fixture,{recursive:true,force:true,maxRetries:10,retryDelay:250});
  fs.rmSync(testProfile,{recursive:true,force:true,maxRetries:10,retryDelay:250});
});
describe("Vision independent owner lifecycle",()=>{
  it("rejects any attempt to stop an unsupervised/legacy Vision process",async()=>{
    const port=await freePort();
    await expect(manageServices({action:"plan",service:"vision",port,targetAction:"stop"}))
      .rejects.toThrow("VISION_UNOWNED_OR_UNVERIFIED");
    await expect(manageServices({action:"stop",service:"vision",port,confirm:true}))
      .rejects.toThrow("SERVICE_VISION_PLAN_REQUIRED");
  });
  it("starts and stops a Python Vision server with private auth and safe idempotency",async()=>{
    // Only the RFDETR heavyweight model is stubbed, never the server/control code.
    const pkg=path.join(fixture,"rfdetr");
    fs.mkdirSync(pkg,{recursive:true});
    fs.writeFileSync(path.join(pkg,"__init__.py"),"");
    fs.writeFileSync(path.join(pkg,"detr.py"),"class RFDETRMedium:\n    pass\n");
    // This test verifies private HTTP ownership, not ML inference.
    // Stub only heavy ML imports; Pillow/numpy and the actual Vision server
    // remain real and are provided by the CI Python media dependencies.
    fs.writeFileSync(path.join(fixture,"torch.py"),
      "def set_num_threads(n): pass\ndef set_num_interop_threads(n): pass\ndef set_grad_enabled(v): pass\ndef inference_mode(): return lambda fn: fn\n");
    fs.writeFileSync(path.join(fixture,"transformers.py"),"BackboneConfigMixin = object\n");
    fs.writeFileSync(path.join(fixture,"huggingface_hub.py"),
      "def hf_hub_download(*args, **kwargs): raise RuntimeError('model inference not exercised in lifecycle test')\n");
    process.env.PYTHONPATH=fixture;
    // Preflight the ACTUAL script (not only torch/transformers imports). Any
    // Python traceback must surface in CI instead of a 35s opaque PID timeout.
    const python=process.env.SUPERAGENT_VISION_PYTHON||"python";
    const importProbe=spawnSync(python,["-c",
      "import runpy; runpy.run_path('scripts/vision_server.py', run_name='managed_vision_import_probe')"],{
      cwd:process.cwd(),env:process.env,windowsHide:true,
      encoding:"utf8",timeout:20000,stdio:["ignore","pipe","pipe"],
    });
    expect(importProbe.status, String(importProbe.stderr||importProbe.error||"Python Vision module import failed").slice(-3000)).toBe(0);
    const port=await freePort();
    const plan=await manageServices({action:"plan",service:"vision",port,targetAction:"start"}) as any;
    expect(plan.expectedOwnerPid).toBe(0);
    const started=await operation(plan);
    owned.set(port,started.ownerPid);
    expect(started.ownerPid).toBeGreaterThan(0);
    const owner=readVisionOwner(port);
    expect(owner?.pid).toBe(started.ownerPid);
    const status=await inspectManagedVision(port);
    expect(status.verified).toBe(true);
    expect((await operation(plan)).replayed).toBe(true);
    const denied=await fetch("http://127.0.0.1:"+port+"/_superagent/vision/lifecycle",{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({action:"stop",instanceId:owner!.instanceId}),
    });
    expect(denied.status).toBe(401);
    // The durable sidecar ledger requires a 1-second pause between distinct
    // mutations; replaying the same operation above remains immediately safe.
    await new Promise(resolve=>setTimeout(resolve,1100));
    const stopPlan=await manageServices({action:"plan",service:"vision",port,targetAction:"stop"}) as any;
    const stopped=await operation(stopPlan);
    expect(stopped.changed).toBe(true);
    expect((await operation(stopPlan)).replayed).toBe(true);
    expect(readVisionOwner(port)).toBeNull();
    owned.delete(port);
  },145000);
});
