import { describe, expect, it } from "vitest";
import {
  NativeAndroidControllerApproval,
  ANDROID_CONTROL_CHALLENGE_TTL_MS,
  ANDROID_CONTROL_LEASE_TTL_MS,
} from "../../src/core/desktopUi/nativeAndroidControllerApproval.js";
import type { LanDevice } from "../../src/core/lanRemote/controller.js";

const secret = Buffer.from("a6".repeat(32), "hex");
const deviceId = "123e4567-e89b-12d3-a456-426614174000";
const fingerprint = "af".repeat(32);
const otherId = "123e4567-e89b-12d3-a456-426614174111";
const device = (overrides: Partial<LanDevice> = {}): LanDevice => ({
  id:deviceId, host:"192.168.1.20",port:17845,
  fingerprint,label:"Test Android",platform:"android",
  paired:true,connected:true,transport:"lan", ...overrides,
});
function fixture() {
  let now = 1_800_000_000_000;
  let devices = [device(),device({id:otherId})];
  let supportSession = "cd".repeat(32);
  const gate = new NativeAndroidControllerApproval(
    () => secret,
    () => devices,
    () => now,
    () => supportSession,
  );
  const approve = (id=deviceId) => {
    const challenge = gate.challenge(id);
    const mac = NativeAndroidControllerApproval.computeProofForTest(
      secret,challenge.nonce,id,challenge.fingerprint,
    );
    return {challenge,grant:gate.confirm({
      deviceId:id,fingerprint:challenge.fingerprint,nonce:challenge.nonce,mac,
    })};
  };
  return {
    gate,approve,
    get now(){return now;},set now(value:number){now=value;},
    get devices(){return devices;},set devices(value:LanDevice[]){devices=value;},
    get supportSession(){return supportSession;},
    set supportSession(value:string){supportSession=value;},
  };
}

describe("Native Android input capability, separate from a Viewer", () => {
  it("does not treat a paired/connected viewer or a preview token as input permission", () => {
    const f=fixture();
    expect(() => f.gate.authorize(deviceId,"a".repeat(64)))
      .toThrow("ANDROID_CONTROLLER_APPROVAL_REQUIRED");
    const c=f.gate.challenge(deviceId);
    expect(c.expiresAt-f.now).toBe(ANDROID_CONTROL_CHALLENGE_TTL_MS);
    expect(() => f.gate.authorize(deviceId,c.nonce))
      .toThrow("ANDROID_CONTROLLER_APPROVAL_REQUIRED");
  });

  it("issues an unrelated controller bearer only after signed native approval", () => {
    const f=fixture();
    const {challenge,grant}=f.approve();
    expect(grant.controllerToken).toMatch(/^[a-f0-9]{64}$/);
    expect(grant.controllerToken).not.toBe(challenge.nonce);
    expect(grant.expiresAt-f.now).toBe(ANDROID_CONTROL_LEASE_TTL_MS);
    expect(() => f.gate.authorize(deviceId,grant.controllerToken)).not.toThrow();
    expect(f.gate.status(deviceId,grant.controllerToken)).toMatchObject({
      approved:true,secondsRemaining:120,
    });
  });

  it("burns a forged proof; the same challenge cannot be replayed", () => {
    const f=fixture();
    const c=f.gate.challenge(deviceId);
    expect(() => f.gate.confirm({
      deviceId,nonce:c.nonce,fingerprint:c.fingerprint,mac:"f".repeat(64),
    })).toThrow("ANDROID_CONTROLLER_NATIVE_PROOF_INVALID");
    const correct=NativeAndroidControllerApproval.computeProofForTest(
      secret,c.nonce,deviceId,c.fingerprint,
    );
    expect(() => f.gate.confirm({
      deviceId,nonce:c.nonce,fingerprint:c.fingerprint,mac:correct,
    })).toThrow("ANDROID_CONTROLLER_NATIVE_PROOF_REQUIRED");
  });

  it("binds input to the same exact live device and fingerprint", () => {
    const f=fixture();
    const {grant}=f.approve();
    expect(() => f.gate.authorize(otherId,grant.controllerToken))
      .toThrow("ANDROID_CONTROLLER_APPROVAL_REQUIRED");
    f.devices=[device({fingerprint:"bc".repeat(32)})];
    expect(() => f.gate.authorize(deviceId,grant.controllerToken)).toThrow();
    f.devices=[device()];
    expect(f.gate.status(deviceId,grant.controllerToken).approved).toBe(false);
  });

  it("expires previous controller after Android closes and reopens its support session", () => {
    const f=fixture();
    const {grant}=f.approve();
    f.supportSession="ef".repeat(32);
    expect(() => f.gate.authorize(deviceId,grant.controllerToken))
      .toThrow("ANDROID_CONTROLLER_DEVICE_CHANGED");
    f.supportSession="cd".repeat(32);
    expect(f.gate.status(deviceId,grant.controllerToken).approved).toBe(false);
  });

  it("never sends the support-session proof to the native approval dialog", () => {
    const f=fixture();
    const challenge=f.gate.challenge(deviceId);
    expect(Object.keys(challenge).sort()).toEqual(
      ["nonce","deviceId","fingerprint","expiresAt"].sort());
    expect(JSON.stringify(challenge)).not.toContain(f.supportSession);
  });

  it("revokes when session closes, expires, or the host clock regresses", () => {
    const f=fixture();
    const {grant}=f.approve();
    f.now+=ANDROID_CONTROL_LEASE_TTL_MS;
    expect(() => f.gate.authorize(deviceId,grant.controllerToken))
      .toThrow("ANDROID_CONTROLLER_APPROVAL_EXPIRED");
    const second=f.approve().grant.controllerToken;
    f.gate.revokeDevice(deviceId);
    expect(f.gate.status(deviceId,second).approved).toBe(false);
    const third=f.approve().grant.controllerToken;
    f.now-=1;
    expect(() => f.gate.authorize(deviceId,third))
      .toThrow("ANDROID_CONTROLLER_HOST_CLOCK_INVALID");
  });

  it("does not allow another bearer to revoke an approved controller", () => {
    const f=fixture();
    const {grant}=f.approve();
    expect(() => f.gate.revoke("0".repeat(64)))
      .toThrow("ANDROID_CONTROLLER_REVOKE_PROOF_REQUIRED");
    expect(() => f.gate.authorize(deviceId,grant.controllerToken)).not.toThrow();
    f.gate.revoke(grant.controllerToken);
    expect(() => f.gate.authorize(deviceId,grant.controllerToken)).toThrow();
  });

  it("rejects an old approval after the phone has been disconnected", () => {
    const f=fixture();
    const c=f.gate.challenge(deviceId);
    f.devices=[device({connected:false})];
    const mac=NativeAndroidControllerApproval.computeProofForTest(secret,
      c.nonce,deviceId,c.fingerprint);
    expect(() => f.gate.confirm({deviceId,nonce:c.nonce,fingerprint:c.fingerprint,mac}))
      .toThrow("ANDROID_CONTROLLER_DEVICE_SESSION_UNAVAILABLE");
  });
});
