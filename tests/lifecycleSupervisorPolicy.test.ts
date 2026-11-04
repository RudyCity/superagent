import {afterEach,describe,it,expect,vi} from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readLifecycleSettings,configureLifecycleProfile,dependencyOrder,canAutoRecover,
} from "../src/core/runtime/lifecycleProfiles.js";
import {
  readLifecycleEvents,recordLifecycleEvent,operationHashPrefix,
} from "../src/core/runtime/lifecycleTimeline.js";
import {
  readTrayReleaseState,promoteTrayRelease,restoreTrayReleaseState,
  releaseBinaryPath,fileSha256,
} from "../src/core/runtime/trayReleaseStore.js";

const roots:string[]=[];
function isolated(){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"lifecycle-policy-stage-"));
  roots.push(dir);return dir;
}
afterEach(()=>{
  vi.restoreAllMocks();
  for(const dir of roots.splice(0))
    fs.rmSync(dir,{recursive:true,force:true,maxRetries:8,retryDelay:200});
});
describe("lifecycle settings: strict dependencies, safe defaults and revision checks",()=>{
  it("orders 13 service profiles and disables surprise recovery and tunnel boot",()=>{
    const root=isolated(),state=readLifecycleSettings(root);
    expect(state.profiles).toHaveLength(13);
    expect(state.profiles.every(p=>!p.autoRecover&&!p.startOnBoot)).toBe(true);
    const order=dependencyOrder(state.profiles);
    expect(order.indexOf("core")).toBeLessThan(order.indexOf("transport"));
    expect(order.indexOf("channel_host")).toBeLessThan(order.indexOf("muse"));
    expect(canAutoRecover(state.profiles.find(p=>p.service==="tray")!,3,0)).toBe(false);
  });
  it("commits optimistic policy changes and refuses unsafe automatic public tunnel control",()=>{
    const root=isolated(),state=readLifecycleSettings(root);
    const next=configureLifecycleProfile({service:"tray",revision:state.revision,
      autoRecover:true,failureThreshold:4,maxRestartsPerHour:2},root);
    expect(next.revision).not.toBe(state.revision);
    expect(readLifecycleSettings(root).profiles.find(p=>p.service==="tray")?.autoRecover).toBe(true);
    expect(()=>configureLifecycleProfile({service:"tray",revision:state.revision},root))
      .toThrow("REVISION_CONFLICT");
    expect(()=>configureLifecycleProfile({service:"mcp",revision:next.revision,
      autoRecover:true},root)).toThrow("UNSAFE_SETTING");
    expect(()=>configureLifecycleProfile({service:"mcp",revision:next.revision,
      startOnBoot:true},root)).toThrow("UNSAFE_SETTING");
  });
});
describe("private event timeline contains metadata only",()=>{
  it("writes and filters bounded metadata without exposing raw operation ID",()=>{
    const root=isolated(),id="runtime-prod-operation-000123";
    recordLifecycleEvent({at:Date.now(),service:"tray",action:"restart",
      outcome:"planned",operationHashPrefix:operationHashPrefix(id)},root);
    recordLifecycleEvent({at:Date.now(),service:"core",action:"status",
      outcome:"observed"},root);
    const events=readLifecycleEvents({service:"tray",limit:10},root);
    expect(events).toHaveLength(1);
    expect(events[0].operationHashPrefix).toMatch(/^[a-f0-9]{16}$/);
    expect(fs.readFileSync(path.join(root,"lifecycle-events.jsonl"),"utf8"))
      .not.toContain(id);
    expect(()=>recordLifecycleEvent({at:Date.now(),service:"tray",action:"restart",
      outcome:"blocked",errorCode:"Bearer secret-token"} as any,root))
      .toThrow("INVALID_METADATA");
  });
});
describe("Tray immutable release state",()=>{
  it("promotes and restores verified content-addressed releases",()=>{
    const root=isolated(),initial=readTrayReleaseState(root);
    expect(initial.activeDigest).toBeNull();
    const a=Buffer.alloc(2048,65),b=Buffer.alloc(2048,66);
    const hashA=fileSha256Local(a),hashB=fileSha256Local(b);
    const slotA=releaseBinaryPath(hashA,root),slotB=releaseBinaryPath(hashB,root);
    fs.mkdirSync(path.dirname(slotA),{recursive:true});
    fs.writeFileSync(slotA,a);fs.writeFileSync(slotB,b);
    const first=promoteTrayRelease(hashA,initial.revision,root);
    const next=promoteTrayRelease(hashB,first.revision,root);
    expect(next.activeDigest).toBe(hashB);
    expect(next.previousDigest).toBe(hashA);
    const restored=restoreTrayReleaseState(first,next.revision,root);
    expect(restored.activeDigest).toBe(hashA);
    expect(readTrayReleaseState(root).revision).toBe(restored.revision);
    fs.writeFileSync(slotA,Buffer.alloc(2048,67));
    expect(()=>readTrayReleaseState(root)).toThrow("HASH_MISMATCH");
  });
});
function fileSha256Local(bytes:Buffer){
  return requireHash(bytes);
}
import crypto from "node:crypto";
function requireHash(bytes:Buffer){return crypto.createHash("sha256").update(bytes).digest("hex");}
