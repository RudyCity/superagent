import {afterEach,describe,expect,it} from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {ManagedSidecarLedger,sidecarOperationFingerprint} from "../src/core/runtime/managedSidecarLedger.js";
import {readTrayReleaseState,releaseBinaryPath} from "../src/core/runtime/trayReleaseStore.js";
import {parseNativeTrayLifecycleRequest} from "../src/core/runtime/nativeTrayLifecycleBridge.js";

/** Offline-only audit. Never imports lifecycle execution helpers or targets live processes. */
const previousConfig=process.env.SUPERAGENT_CONFIG_DIR;
const roots:string[]=[];
function sandbox() {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"tray-deployment-safety-"));
  roots.push(root);
  process.env.SUPERAGENT_CONFIG_DIR=root;
  return root;
}
function journal(port:45321|45322) {
  sandbox();
  return new ManagedSidecarLedger("tray",port);
}
const fingerprint=()=>sidecarOperationFingerprint({service:"tray",action:"upgrade",test:true});
afterEach(()=>{
  if(previousConfig===undefined)delete process.env.SUPERAGENT_CONFIG_DIR;
  else process.env.SUPERAGENT_CONFIG_DIR=previousConfig;
  for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true});
});
describe("Tray deployment safety audit (pure offline fixtures)",()=>{
  it("separates lifecycle and release journals",()=>{
    const root=sandbox();
    const normal=new ManagedSidecarLedger("tray",45321);
    const release=new ManagedSidecarLedger("tray",45322);
    expect(normal.file).not.toBe(release.file);
    expect(normal.file).toBe(path.join(root,"service-owner-tray-45321.json"));
    expect(release.file).toBe(path.join(root,"service-owner-tray-45322.json"));
  });
  it("keeps unknown upgrade pending and blocks unrelated operations",()=>{
    const ledger=journal(45322),id=crypto.randomUUID(),fp=fingerprint();
    ledger.begin(id,fp);
    expect(()=>ledger.lookup(id,fp)).toThrow("SIDECAR_OPERATION_UNCERTAIN_PENDING");
    expect(()=>ledger.begin(crypto.randomUUID(),fp)).toThrow("SIDECAR_OPERATION_UNCERTAIN_PENDING");
    expect(ledger.inspect()).toMatchObject([{state:"pending"}]);
  });
  it("requires verified absence and explicit approval to review",()=>{
    const ledger=journal(45322),id=crypto.randomUUID(),fp=fingerprint();
    ledger.begin(id,fp);
    expect(()=>ledger.reconcile(id,false,true)).toThrow("SIDECAR_RECONCILE_REQUIRES_OWNER_ABSENCE_AND_APPROVAL");
    expect(()=>ledger.reconcile(id,true,false)).toThrow("SIDECAR_RECONCILE_REQUIRES_OWNER_ABSENCE_AND_APPROVAL");
    expect(ledger.inspect()[0].state).toBe("pending");
  });
  it("honors 120-second cooldown even after operator approval",()=>{
    const ledger=journal(45322),id=crypto.randomUUID();
    ledger.begin(id,fingerprint());
    expect(()=>ledger.reconcile(id,true,true)).toThrow("SIDECAR_RECONCILE_COOLDOWN_120_SECONDS");
  });
  it("review is non-replayable and does not convert ambiguity to completion",()=>{
    const ledger=journal(45322),id=crypto.randomUUID(),fp=fingerprint();
    ledger.begin(id,fp);
    const data=JSON.parse(fs.readFileSync(ledger.file,"utf8"));
    data.receipts[0].startedAt=Date.now()-121_000;
    fs.writeFileSync(ledger.file,JSON.stringify(data));
    expect(ledger.reconcile(id,true,true)).toMatchObject({state:"reviewed",executedAgain:false});
    expect(()=>ledger.lookup(id,fp)).toThrow("SIDECAR_OPERATION_REVIEWED_NOT_REPLAYABLE");
    expect(ledger.inspect()[0].state).toBe("reviewed");
    expect(fs.existsSync(ledger.file)).toBe(true);
  });
  it("rejects a mismatched fingerprint rather than silently adopting a receipt",()=>{
    const ledger=journal(45322),id=crypto.randomUUID();
    ledger.begin(id,fingerprint());
    expect(()=>ledger.lookup(id,sidecarOperationFingerprint({action:"rollback"})))
      .toThrow("SIDECAR_OPERATION_ID_CONFLICT");
  });
  it("rejects malformed release metadata in a private fixture",()=>{
    const root=sandbox();
    fs.writeFileSync(path.join(root,"tray-release-state.json"),JSON.stringify({
      version:1,revision:"bad",activeDigest:null,previousDigest:null,updatedAt:Date.now(),
    }));
    expect(()=>readTrayReleaseState(root)).toThrow("TRAY_RELEASE_MANIFEST_INVALID");
  });
  it("does not trust a substituted release slot",()=>{
    const root=sandbox(),digest="a".repeat(64);
    const file=releaseBinaryPath(digest,root);
    fs.mkdirSync(path.dirname(file),{recursive:true});
    fs.writeFileSync(file,Buffer.alloc(2048,7));
    fs.writeFileSync(path.join(root,"tray-release-state.json"),JSON.stringify({
      version:1,revision:"b".repeat(24),activeDigest:digest,previousDigest:null,updatedAt:Date.now(),
    }));
    expect(()=>readTrayReleaseState(root)).toThrow("TRAY_RELEASE_HASH_MISMATCH");
  });
  it("requires exact review intent at the native UI boundary",()=>{
    expect(()=>parseNativeTrayLifecycleRequest({action:"reconcile",service:"tray",confirm:true,reviewed:true,arbitrary:"kill"}))
      .toThrow("SERVICE_UNEXPECTED_ARGUMENT");
    expect(()=>parseNativeTrayLifecycleRequest({action:"reconcile",service:"tray",reviewed:true}))
      .toThrow("DESKTOP_LIFECYCLE_EXPLICIT_CONFIRMATION_REQUIRED");
    expect(parseNativeTrayLifecycleRequest({action:"reconcile",service:"tray",confirm:true,reviewed:true,operationId:crypto.randomUUID(),targetAction:"upgrade"}))
      .toMatchObject({action:"reconcile",service:"tray",targetAction:"upgrade"});
  });
});
