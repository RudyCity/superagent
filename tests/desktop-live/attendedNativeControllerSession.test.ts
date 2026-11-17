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
import { sha256 } from "../../src/core/desktopUi/png.js";
import { semanticElementHash } from "../../src/core/desktopUi/remoteInputGuard.js";
import type { DesktopUiElement, DesktopUiSchema } from "../../src/core/desktopUi/types.js";

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
const nowMs=1_800_000_000_000;
const image=Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZsAAAAASUVORK5CYII=",
  "base64",
);
const element:DesktopUiElement={
  id:"edit1",source:"accessibility",nativeRef:"automationId:TestInput",
  role:"textbox",label:"Test input",description:null,value:"",
  actionable:true,focused:true,confidence:1,
  bounds:{x:10,y:10,width:100,height:25},center:{x:60,y:22.5},
};
const schema:DesktopUiSchema={
  version:1,platform:"win32",
  screenshot:{
    revision:1,sha256:sha256(image),capturedAt:new Date(nowMs-20).toISOString(),
    width:1,height:1,pixelRatioX:1,pixelRatioY:1,
    targetWindow:{
      pid:hostScope.pid,nativeId:hostScope.nativeId,title:"Disposable test window",
      bounds:{x:0,y:0,width:800,height:600},active:true,
    },
  },
  windows:[],warnings:[],elements:[element],
};
const clickInput={
  kind:"click",sequence:1,expectedRevision:1,expectedHash:sha256(image),
  elementId:element.id,expectedElementHash:semanticElementHash(element),
};
function signature(challenge: RemoteControlChallenge) {
  return createHmac("sha256",secret).update(JSON.stringify(challenge)).digest("hex");
}

function setup() {
  let allowed=true;
  const viewer={ humanTakeover:vi.fn() };
  const nativeDispatch=vi.fn(async (_input:unknown,authorizeNow:()=>void)=>{
    authorizeNow();
  });
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
    captureFresh:async()=>({
      verifiedInsideCapture:true as const,png:image,schema,hostScope:{...hostScope},
    }),
    adapter,
    hostPlatform:"win32",
    viewer,
    now:()=>nowMs,
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
      ...clickInput,kind:"type",text:"unapproved",
    })).toEqual({status:"blocked",reason:"INPUT_DENIED"});
    expect(f.nativeDispatch).not.toHaveBeenCalled();
    expect(await f.session.input(principal,token,clickInput))
      .toEqual({status:"dispatched"});
    expect(f.nativeDispatch).toHaveBeenCalledOnce();
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
