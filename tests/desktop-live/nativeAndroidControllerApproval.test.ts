import { describe, expect, it } from "vitest";
import {
  NativeAndroidControllerApproval,
  ANDROID_CONTROL_CHALLENGE_TTL_MS,
  ANDROID_CONTROL_LEASE_TTL_MS,
  type AndroidControlKind,
} from "../../src/core/desktopUi/nativeAndroidControllerApproval.js";
import type { LanDevice } from "../../src/core/lanRemote/controller.js";

const secret = Buffer.from("a6".repeat(32),"hex");
const deviceId = "123e4567-e89b-12d3-a456-426614174000";
const fingerprint = "af".repeat(32);
const otherId = "123e4567-e89b-12d3-a456-426614174111";
const device=(overrides:Partial<LanDevice>={}):LanDevice=>({
  id:deviceId,host:"192.168.1.20",port:17845,fingerprint,label:"Android",
  platform:"android",paired:true,connected:true,transport:"lan",...overrides,
});
function fixture(){
  let now=1_800_000_000_000;
  let devices=[device(),device({id:otherId})];
  let session="cd".repeat(32);
  const gate=new NativeAndroidControllerApproval(()=>secret,()=>devices,()=>now,()=>session);
  const approve=(kind:AndroidControlKind="mouse",id=deviceId)=>{
    const challenge=gate.challenge(id,kind);
    const mac=NativeAndroidControllerApproval.computeProofForTest(
      secret,challenge.nonce,id,challenge.fingerprint,kind);
    const grant=gate.confirm({deviceId:id,fingerprint:challenge.fingerprint,
      nonce:challenge.nonce,kind,mac});
    return {challenge,grant};
  };
  return {
    gate,approve,
    get now(){return now;},set now(x:number){now=x;},
    get devices(){return devices;},set devices(x:LanDevice[]){devices=x;},
    get session(){return session;},set session(x:string){session=x;},
  };
}
describe("Independent attended Android mouse and keyboard controller grants",()=>{
  it("viewer consent never grants mouse OR keyboard",()=>{
    const f=fixture();
    for(const kind of ["mouse","keyboard"] as const)
      expect(()=>f.gate.authorize(deviceId,"a".repeat(64),kind))
        .toThrow("ANDROID_CONTROLLER_APPROVAL_REQUIRED");
    expect(()=>f.gate.challenge(deviceId,"all"))
      .toThrow("ANDROID_CONTROLLER_INVALID_SCOPE");
  });

  it("a mouse approval cannot type, navigate, or revoke keyboard",()=>{
    const f=fixture();
    const {challenge,grant}=f.approve("mouse");
    expect(challenge).toMatchObject({kind:"mouse",deviceId,fingerprint});
    expect(challenge.expiresAt-f.now).toBe(ANDROID_CONTROL_CHALLENGE_TTL_MS);
    expect(grant).toMatchObject({kind:"mouse"});
    expect(grant.expiresAt-f.now).toBe(ANDROID_CONTROL_LEASE_TTL_MS);
    expect(()=>f.gate.authorize(deviceId,grant.controllerToken,"mouse")).not.toThrow();
    expect(()=>f.gate.authorize(deviceId,grant.controllerToken,"keyboard"))
      .toThrow("ANDROID_CONTROLLER_APPROVAL_REQUIRED");
    expect(()=>f.gate.revoke(grant.controllerToken,"keyboard"))
      .toThrow("ANDROID_CONTROLLER_REVOKE_PROOF_REQUIRED");
    expect(f.gate.status(deviceId,grant.controllerToken,"mouse").approved).toBe(true);
  });

  it("keyboard approval is independent, and a new mouse challenge preserves it",()=>{
    const f=fixture();
    const keyboard=f.approve("keyboard").grant.controllerToken;
    expect(()=>f.gate.authorize(deviceId,keyboard,"keyboard")).not.toThrow();
    const mouse=f.approve("mouse").grant.controllerToken;
    expect(mouse).not.toBe(keyboard);
    expect(()=>f.gate.authorize(deviceId,mouse,"mouse")).not.toThrow();
    expect(()=>f.gate.authorize(deviceId,keyboard,"keyboard")).not.toThrow();
    f.gate.revoke(mouse,"mouse");
    expect(f.gate.status(deviceId,mouse,"mouse").approved).toBe(false);
    expect(f.gate.status(deviceId,keyboard,"keyboard").approved).toBe(true);
  });

  it("scope tampering invalidates HMAC and burns the challenge",()=>{
    const f=fixture();
    const c=f.gate.challenge(deviceId,"mouse");
    const wrong=NativeAndroidControllerApproval.computeProofForTest(
      secret,c.nonce,deviceId,c.fingerprint,"keyboard");
    expect(()=>f.gate.confirm({deviceId,nonce:c.nonce,
      fingerprint:c.fingerprint,kind:"mouse",mac:wrong}))
      .toThrow("ANDROID_CONTROLLER_NATIVE_PROOF_INVALID");
    const good=NativeAndroidControllerApproval.computeProofForTest(
      secret,c.nonce,deviceId,c.fingerprint,"mouse");
    expect(()=>f.gate.confirm({deviceId,nonce:c.nonce,
      fingerprint:c.fingerprint,kind:"mouse",mac:good}))
      .toThrow("ANDROID_CONTROLLER_NATIVE_PROOF_REQUIRED");
  });

  it("binds each grant to exact live device, fingerprint, and support-session generation",()=>{
    const f=fixture();
    const mouse=f.approve("mouse").grant.controllerToken;
    expect(()=>f.gate.authorize(otherId,mouse,"mouse"))
      .toThrow("ANDROID_CONTROLLER_APPROVAL_REQUIRED");
    f.session="ef".repeat(32);
    expect(()=>f.gate.authorize(deviceId,mouse,"mouse"))
      .toThrow("ANDROID_CONTROLLER_DEVICE_CHANGED");
    f.session="cd".repeat(32);
    expect(f.gate.status(deviceId,mouse,"mouse").approved).toBe(false);
    const keyboard=f.approve("keyboard").grant.controllerToken;
    f.devices=[device({fingerprint:"bc".repeat(32)})];
    expect(()=>f.gate.authorize(deviceId,keyboard,"keyboard")).toThrow();
    f.devices=[device()];
    expect(f.gate.status(deviceId,keyboard,"keyboard").approved).toBe(false);
  });

  it("never sends private support-session proof to native dialog",()=>{
    const f=fixture();
    const c=f.gate.challenge(deviceId,"keyboard");
    expect(Object.keys(c).sort()).toEqual(
      ["nonce","deviceId","fingerprint","kind","expiresAt"].sort());
    expect(JSON.stringify(c)).not.toContain(f.session);
  });

  it("expires one scope independently of a separately approved newer scope",()=>{
    const f=fixture();
    const mouse=f.approve("mouse").grant.controllerToken;
    f.now+=60_000;
    const keyboard=f.approve("keyboard").grant.controllerToken;
    f.now+=60_000;
    expect(()=>f.gate.authorize(deviceId,mouse,"mouse"))
      .toThrow("ANDROID_CONTROLLER_APPROVAL_EXPIRED");
    expect(f.gate.status(deviceId,keyboard,"keyboard").approved).toBe(true);
  });

  it("rejects an old controller on clock regression and disconnected device",()=>{
    const f=fixture();
    const mouse=f.approve("mouse").grant.controllerToken;
    f.now-=1;
    expect(()=>f.gate.authorize(deviceId,mouse,"mouse"))
      .toThrow("ANDROID_CONTROLLER_HOST_CLOCK_INVALID");
    f.now+=1; // Restore a monotonic host clock before testing disconnection.
    const c=f.gate.challenge(deviceId,"keyboard");
    const mac=NativeAndroidControllerApproval.computeProofForTest(
      secret,c.nonce,deviceId,c.fingerprint,"keyboard");
    f.devices=[device({connected:false})];
    expect(()=>f.gate.confirm({deviceId,nonce:c.nonce,fingerprint:c.fingerprint,
      kind:"keyboard",mac})).toThrow("ANDROID_CONTROLLER_DEVICE_SESSION_UNAVAILABLE");
  });

  it("revokeDevice clears both, and invalid scope never succeeds",()=>{
    const f=fixture();
    const mouse=f.approve("mouse").grant.controllerToken;
    const keyboard=f.approve("keyboard").grant.controllerToken;
    expect(()=>f.gate.authorize(deviceId,keyboard,"all")).toThrow("ANDROID_CONTROLLER_INVALID_SCOPE");
    f.gate.revokeDevice(deviceId);
    expect(f.gate.status(deviceId,mouse,"mouse").approved).toBe(false);
    expect(f.gate.status(deviceId,keyboard,"keyboard").approved).toBe(false);
  });

  it("a forged token cannot revoke the other scope",()=>{
    const f=fixture();
    const mouse=f.approve("mouse").grant.controllerToken;
    const keyboard=f.approve("keyboard").grant.controllerToken;
    expect(()=>f.gate.revoke(mouse,"keyboard"))
      .toThrow("ANDROID_CONTROLLER_REVOKE_PROOF_REQUIRED");
    expect(()=>f.gate.authorize(deviceId,keyboard,"keyboard")).not.toThrow();
  });
});