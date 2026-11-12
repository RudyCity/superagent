import {afterAll,beforeAll,describe,it,expect} from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {manageServices} from "../src/core/runtime/serviceManager.js";
import {readManagedTrayOwner} from "../src/core/runtime/managedTrayControl.js";
import {readTrayReleaseState,trustedTrayBuild,fileSha256} from "../src/core/runtime/trayReleaseStore.js";
import {readListenerOwners} from "../src/core/runtime/coreMcpOwnershipAudit.js";

const previous={
  root:process.env.SUPERAGENT_CONFIG_DIR,
  binary:process.env.SUPERAGENT_TRAY_EXECUTABLE,
  smoke:process.env.SUPERAGENT_TRAY_LIFECYCLE_TEST,
};
const profile=fs.mkdtempSync(path.join(os.tmpdir(),"tray-release-e2e-"));
const installed=path.join(profile,"bin","superagent-tray.exe");
let testOwnedPid:number|undefined;
beforeAll(()=>{
  if(process.platform!=="win32")throw new Error("Tray release E2E requires Windows");
  if(process.env.VITEST===undefined)throw new Error("Vitest smoke guard required");
  const built=path.resolve("apps/superagent-tray/src-tauri/target/debug/superagent-tray.exe");
  if(!fs.existsSync(built))throw new Error("Build native Tray debug before release E2E");
  fs.mkdirSync(path.dirname(installed),{recursive:true});
  fs.copyFileSync(built,installed);
  // A PE overlay changes only the file digest, not the executable code;
  // simulates a verified, older native binary without touching live installs.
  fs.appendFileSync(installed,Buffer.from("superagent-release-test-legacy-overlay"));
  process.env.SUPERAGENT_CONFIG_DIR=profile;
  process.env.SUPERAGENT_TRAY_EXECUTABLE=installed;
  process.env.SUPERAGENT_TRAY_LIFECYCLE_TEST="1";
});
function args(plan:any){
  const keys=["service","action","port","operationId","expectedOwnerPid",
    "expectedInstanceId","expectedBuildDigest","expectedCurrentDigest",
    "expectedReleaseRevision","noCoreShutdown"];
  return Object.fromEntries([...keys.map(k=>[k,plan[k]]).filter(x=>x[1]!==undefined),
    ["confirm",true]]);
}
afterAll(async()=>{
  const owner=readManagedTrayOwner();
  if(testOwnedPid&&owner?.pid===testOwnedPid&&
     readListenerOwners()?.get(owner.controlPort)===testOwnedPid){
    try {
      if(process.platform==="win32")
        spawnSync("taskkill",["/F","/PID",String(testOwnedPid)],
          {stdio:"ignore",timeout:3000});
      else process.kill(testOwnedPid,"SIGTERM");
    }catch{}
  }
  await new Promise(r=>setTimeout(r,500));
  if(previous.root===undefined)delete process.env.SUPERAGENT_CONFIG_DIR;
  else process.env.SUPERAGENT_CONFIG_DIR=previous.root;
  if(previous.binary===undefined)delete process.env.SUPERAGENT_TRAY_EXECUTABLE;
  else process.env.SUPERAGENT_TRAY_EXECUTABLE=previous.binary;
  if(previous.smoke===undefined)delete process.env.SUPERAGENT_TRAY_LIFECYCLE_TEST;
  else process.env.SUPERAGENT_TRAY_LIFECYCLE_TEST=previous.smoke;
  fs.rmSync(profile,{recursive:true,force:true,maxRetries:12,retryDelay:250});
});
describe.skipIf(process.platform !== "win32")("Transactional authenticated Tray upgrade and rollback",()=>{
  it("upgrades from isolated legacy-style executable, attests new process, then rolls back",async()=>{
    const oldHash=fileSha256(installed);
    const newHash=trustedTrayBuild().digest;
    expect(oldHash).not.toBe(newHash);
    const initial=await manageServices({action:"plan",service:"tray",targetAction:"start"}) as any;
    const started=await manageServices(args(initial)) as any;
    testOwnedPid=started.ownerPid;
    expect(fileSha256(readManagedTrayOwner()!.executablePath)).toBe(oldHash);
    await new Promise(r=>setTimeout(r,1200));
    const upgrade=await manageServices({action:"plan",service:"tray",targetAction:"upgrade"}) as any;
    expect(upgrade.expectedBuildDigest).toBe(newHash);
    expect(upgrade.expectedCurrentDigest).toBe(oldHash);
    const updated=await manageServices(args(upgrade)) as any;
    testOwnedPid=updated.ownerPid;
    expect(updated.verified).toBe(true);
    expect(updated.activeBuildDigest).toBe(newHash);
    expect(updated.ownerPid).not.toBe(started.ownerPid);
    expect(readTrayReleaseState().activeDigest).toBe(newHash);
    expect(readTrayReleaseState().previousDigest).toBe(oldHash);
    expect((await manageServices(args(upgrade)) as any).replayed).toBe(true);
    await new Promise(r=>setTimeout(r,1200));
    const rollback=await manageServices({action:"plan",service:"tray",targetAction:"rollback"}) as any;
    const restored=await manageServices(args(rollback)) as any;
    testOwnedPid=restored.ownerPid;
    expect(restored.activeBuildDigest).toBe(oldHash);
    expect(readTrayReleaseState().activeDigest).toBe(oldHash);
    expect(fileSha256(readManagedTrayOwner()!.executablePath)).toBe(oldHash);
    expect((await manageServices(args(rollback)) as any).replayed).toBe(true);
    await new Promise(r=>setTimeout(r,1200));
    const stop=await manageServices({action:"plan",service:"tray",targetAction:"stop"}) as any;
    expect((await manageServices(args(stop)) as any).ownerPid).toBeNull();
    testOwnedPid=undefined;
  },120000);
});
