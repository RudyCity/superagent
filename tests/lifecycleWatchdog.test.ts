import {afterAll,beforeAll,describe,it,expect} from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {runLifecycleWatchdog,watchdogStatePath}
  from "../src/core/runtime/lifecycleWatchdog.js";
import {readLifecycleSettings,configureLifecycleProfile}
  from "../src/core/runtime/lifecycleProfiles.js";
import {manageServices} from "../src/core/runtime/serviceManager.js";
import {ManagedSidecarLedger,sidecarOperationFingerprint}
  from "../src/core/runtime/managedSidecarLedger.js";

const previous=process.env.SUPERAGENT_CONFIG_DIR;
const smoke=process.env.SUPERAGENT_TRAY_LIFECYCLE_TEST;
const root=fs.mkdtempSync(path.join(os.tmpdir(),"watchdog-supervisor-qa-"));
beforeAll(()=>{
  process.env.SUPERAGENT_CONFIG_DIR=root;
  process.env.SUPERAGENT_TRAY_LIFECYCLE_TEST="1";
});
afterAll(()=>{
  if(previous===undefined)delete process.env.SUPERAGENT_CONFIG_DIR;
  else process.env.SUPERAGENT_CONFIG_DIR=previous;
  if(smoke===undefined)delete process.env.SUPERAGENT_TRAY_LIFECYCLE_TEST;
  else process.env.SUPERAGENT_TRAY_LIFECYCLE_TEST=smoke;
  fs.rmSync(root,{recursive:true,force:true,maxRetries:8,retryDelay:200});
});
describe("opt-in runtime watchdog",()=>{
  it("does not start anything when all recovery profiles default off",async()=>{
    const result=await runLifecycleWatchdog({execute:false,service:"tray",root});
    expect(result.readOnly).toBe(true);
    expect(result.services).toHaveLength(1);
    expect(fs.existsSync(watchdogStatePath(root))).toBe(false);
  },20000);
  it("persists health counters, honors thresholds and never starts with a zero restart budget",async()=>{
    const current=readLifecycleSettings(root);
    configureLifecycleProfile({revision:current.revision,service:"tray",
      autoRecover:true,maxRestartsPerHour:0,failureThreshold:2,intervalSeconds:10},root);
    const base=Date.now();
    const a=await runLifecycleWatchdog({execute:true,service:"tray",root,now:base});
    expect(a.readOnly).toBe(false);
    expect(a.services.some(x=>x.action==="started")).toBe(false);
    expect(fs.existsSync(watchdogStatePath(root))).toBe(true);
    const b=await runLifecycleWatchdog({execute:true,service:"tray",root,now:base+12000});
    expect(b.services.some(x=>x.action==="started")).toBe(false);
    const c=await runLifecycleWatchdog({execute:true,service:"tray",root,now:base+24000});
    expect(c.services.some(x=>x.action==="started")).toBe(false);
  },35000);
  it("has a fail-closed operator-only reconciliation flow for unknown sidecar operation",async()=>{
    const id="tray-uncertain-stage-0001",fingerprint=sidecarOperationFingerprint({
      service:"tray",action:"start",test:true,
    });
    const ledger=new ManagedSidecarLedger("tray",45321);
    ledger.begin(id,fingerprint);
    await expect(manageServices({action:"reconcile",service:"tray",operationId:id,
      confirm:true,reviewed:true})).rejects.toThrow("COOLDOWN");
    // No bypass of receipt age; only verify deterministic time-dependent gate.
    expect(ledger.inspect().some(x=>x.state==="pending")).toBe(true);
  },20000);
  it("exposes structured profile, dashboard, and bounded timeline through same tool",async()=>{
    const profile=await manageServices({action:"profile"}) as any;
    expect(profile.profiles).toHaveLength(13);
    const health=await manageServices({action:"health",service:"tray"}) as any;
    expect(health.checks).toHaveLength(1);
    const dashboard=await manageServices({action:"dashboard",service:"tray",limit:5}) as any;
    expect(dashboard.summary.total).toBe(1);
    expect(dashboard.timeline.length).toBeLessThanOrEqual(5);
    const logs=await manageServices({action:"logs",service:"tray",limit:5}) as any;
    expect(logs.events.length).toBeLessThanOrEqual(5);
  },35000);
});
