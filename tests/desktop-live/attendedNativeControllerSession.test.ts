import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  AttendedNativeControllerSession,
} from "../../src/core/desktopUi/attendedNativeControllerSession.js";
import type {
  RemoteControlChallenge, RemoteHostScope, RemotePrincipal,
} from "../../src/core/desktopUi/remoteControlAuthority.js";
import type {
  RemoteNativeSemanticAdapter,
} from "../../src/core/desktopUi/remoteNativeInputDispatch.js";

const principal: RemotePrincipal = {
  principalId:"trusted-operator",connectionId:"private-mtls-connection",
  viewSessionId:"native-view-session",
};
const hostScope: RemoteHostScope = {
  platform:"win32",pid:735,nativeId:"hwnd:735",
  processBirthId:"created-at-42",osUserId:"local-user-sid",
  hostSessionId:"interactive-os-session",hostGeneration:5,
  viewSessionId:principal.viewSessionId,
};
const secret="test-attended-native-scope-key";
function signature(challenge: RemoteControlChallenge) {
  return createHmac("sha256",secret).update(JSON.stringify(challenge)).digest("hex");
}

function setup() {
  let allowed=true;
  const viewer={ humanTakeover:vi.fn() };
  const nativeDispatch=vi.fn(async (_input:unknown,_authorizeNow:()=>void)=>{});
  const adapter:RemoteNativeSemanticAdapter={
    platform:"win32",nativeRefOnly:true,
    dispatchVerifiedNativeRef:nativeDispatch,
  };
  const trust={
    currentScope:()=>hostScope,
    authorizeCaller:()=>allowed,
    verifyNativeControlApproval:(challenge:RemoteControlChallenge,proof:unknown)=>
      typeof proof==="string" && proof===signature(challenge),
  };
  const session=new AttendedNativeControllerSession({
    hostTrust:trust,
    captureFresh:async()=>null,
    adapter,
    hostPlatform:"win32",
    viewer,
    now:()=>1_800_000_000_000,
  });
  const grant=(scope:"mouse"|"keyboard")=>{
    const challenge=session.requestScope(principal,scope);
    const token=session.confirmScope(challenge.nonce,signature(challenge)).token;
    return {challenge,token};
  };
  return {session,viewer,grant,nativeDispatch,set allowed(v:boolean){allowed=v;}};
}

describe("host-only attended native controller lifecycle",()=>{
  it("never promotes a view-only token or a mouse grant into keyboard",async()=>{
    const f=setup();
    expect(await f.session.input(principal,"0".repeat(64),{kind:"click"}))
      .toEqual({status:"blocked",reason:"INPUT_DENIED"});
    const {challenge,token}=f.grant("mouse");
    expect(challenge.kinds).toEqual(["click","scroll"]);
    expect(await f.session.input(principal,token,{
      kind:"type",sequence:1,text:"unapproved",
    })).toEqual({status:"blocked",reason:"INPUT_DENIED"});
    expect(f.nativeDispatch).not.toHaveBeenCalled();
    expect(()=>f.session.requestScope(principal,"keyboard")).toThrow(/already exists/);
  });

  it("requires a new attended proof after revoking mouse before keyboard",()=>{
    const f=setup();
    const old=f.grant("mouse");
    f.session.revokeController();
    const next=f.grant("keyboard");
    expect(next.challenge.kinds).toEqual(["type","key"]);
    expect(next.token).not.toBe(old.token);
    expect(f.viewer.humanTakeover).not.toHaveBeenCalled();
    expect(()=>f.session.confirmScope(old.challenge.nonce,signature(old.challenge))).toThrow();
  });

  it("revokes only the matched controller connection while keeping view-only",()=>{
    const f=setup();
    f.grant("mouse");
    f.session.controllerDisconnected("some-other-connection");
    expect(()=>f.session.requestScope(principal,"keyboard")).toThrow(/already exists/);
    f.session.controllerDisconnected(principal.connectionId);
    const next=f.grant("keyboard");
    expect(next.challenge.kinds).toEqual(["type","key"]);
    expect(f.viewer.humanTakeover).not.toHaveBeenCalled();
  });

  it.each(["viewerDisconnected","hostRestarted","identityChanged","humanTakeover"] as const)(
    "%s terminates input and the private viewer exactly once",async action=>{
      const f=setup();
      const approved=f.grant("mouse");
      f.session[action]();
      expect(f.session.isClosed).toBe(true);
      expect(f.viewer.humanTakeover).toHaveBeenCalledOnce();
      expect(()=>f.session.requestScope(principal,"mouse")).toThrow(/CLOSED/);
      expect(await f.session.input(principal,approved.token,{kind:"click"}))
        .toEqual({status:"blocked",reason:"INPUT_DENIED"});
      f.session.humanTakeover();
      expect(f.viewer.humanTakeover).toHaveBeenCalledOnce();
      expect(f.nativeDispatch).not.toHaveBeenCalled();
    },
  );

  it("latches off native input even if viewer cleanup throws",async()=>{
    const f=setup();const approved=f.grant("mouse");
    f.viewer.humanTakeover.mockImplementation(()=>{throw Error("already stopped");});
    expect(()=>f.session.humanTakeover()).not.toThrow();
    expect(await f.session.input(principal,approved.token,{kind:"click"}))
      .toEqual({status:"blocked",reason:"INPUT_DENIED"});
  });

  it("refuses partial/native adapter provisioning instead of creating a listener",()=>{
    const f=setup();
    expect(()=>new AttendedNativeControllerSession({
      hostTrust:{
        currentScope:()=>hostScope,
        authorizeCaller:()=>true,
        verifyNativeControlApproval:()=>true,
      },
      captureFresh:async()=>null,
      adapter:{platform:"win32",nativeRefOnly:true} as never,
      hostPlatform:"win32",
      viewer:{humanTakeover:()=>{}},
    })).toThrow(/UNAVAILABLE/);
    expect(f.session.isClosed).toBe(false);
  });
});
