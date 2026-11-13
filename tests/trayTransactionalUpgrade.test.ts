import {afterAll,beforeAll,describe,it,expect} from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
async function stopIsolatedTestOwner() {
  // Only this file's disposable profile is eligible. Never adopt or close a
  // native Tray associated with the user's primary SuperAgent profile.
  if (process.env.SUPERAGENT_CONFIG_DIR !== profile) {
    throw new Error("TRAY_TEST_PROFILE_CHANGED: refusing process cleanup");
  }
  const owner = readManagedTrayOwner();
  if (!owner) {
    if (testOwnedPid && isProcessAlive(testOwnedPid)) {
      throw new Error("TRAY_TEST_OWNER_MISSING: test child may still be running");
    }
    return;
  }
  const ownedPath = fs.realpathSync.native(owner.executablePath).toLowerCase();
  const testRoot = fs.realpathSync.native(profile).toLowerCase() + path.sep;
  if (!ownedPath.startsWith(testRoot) ||
      readListenerOwners()?.get(owner.controlPort) !== owner.pid) {
    throw new Error("TRAY_TEST_OWNER_NOT_VERIFIED: refusing process cleanup");
  }
  const endpoint = `http://127.0.0.1:${owner.controlPort}`;
  const headers = {Authorization: `Bearer ${owner.token}`};
  const health = await fetch(endpoint + "/tray/health", {
    headers, signal: AbortSignal.timeout(2500),
  });
  const identity = await health.json() as Record<string, unknown>;
  if (!health.ok || identity.service !== "superagent-tray" ||
      identity.ownerVerified !== true || identity.pid !== owner.pid ||
      identity.instanceId !== owner.instanceId ||
      identity.controlPort !== owner.controlPort) {
    throw new Error("TRAY_TEST_HEALTH_IDENTITY_MISMATCH: refusing process cleanup");
  }
  const stopped = await fetch(endpoint + "/tray/control", {
    method: "POST", headers: {...headers, "Content-Type": "application/json"},
    body: JSON.stringify({action:"stop", instanceId:owner.instanceId}),
    signal: AbortSignal.timeout(4500),
  });
  const result = await stopped.json() as Record<string, unknown>;
  if (!stopped.ok || result.ok !== true || result.coreUnaffected !== true) {
    throw new Error("TRAY_TEST_GRACEFUL_STOP_REFUSED");
  }
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    if (!isProcessAlive(owner.pid) && !fs.existsSync(path.join(profile,"tray-lifecycle-owner.json"))) {
      testOwnedPid = undefined;
      return;
    }
    await new Promise(resolve=>setTimeout(resolve,150));
  }
  throw new Error("TRAY_TEST_GRACEFUL_STOP_UNCERTAIN: retaining test profile");
}
function isProcessAlive(pid:number) {
  try {process.kill(pid,0);return true;}
  catch (error) {return (error as NodeJS.ErrnoException).code !== "ESRCH";}
}
afterAll(async()=>{
  try {
    if (process.env.SUPERAGENT_CONFIG_DIR === profile) {
      await stopIsolatedTestOwner();
    }
    fs.rmSync(profile,{recursive:true,force:true,maxRetries:12,retryDelay:250});
  } finally {
    if(previous.root===undefined)delete process.env.SUPERAGENT_CONFIG_DIR;
    else process.env.SUPERAGENT_CONFIG_DIR=previous.root;
    if(previous.binary===undefined)delete process.env.SUPERAGENT_TRAY_EXECUTABLE;
    else process.env.SUPERAGENT_TRAY_EXECUTABLE=previous.binary;
    if(previous.smoke===undefined)delete process.env.SUPERAGENT_TRAY_LIFECYCLE_TEST;
    else process.env.SUPERAGENT_TRAY_LIFECYCLE_TEST=previous.smoke;
  }
});
describe.skipIf(process.platform !== "win32")("Transactional authenticated Tray upgrade and rollback",()=>{
  it("upgrades from isolated legacy-style executable, attests new process, then rolls back",async()=>{
    const oldHash=fileSha256(installed);
    const trusted=trustedTrayBuild();
    expect(trusted.kind).toBe("debug");
    const newHash=trusted.digest;
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
