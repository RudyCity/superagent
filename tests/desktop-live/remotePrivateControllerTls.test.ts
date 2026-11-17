import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { createHash, createHmac, X509Certificate } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RemotePrivateControllerTlsHost,
} from "../../src/core/desktopUi/remotePrivateControllerTls.js";
import { RemotePrivateControllerClient } from "../../src/core/desktopUi/remotePrivateControllerClient.js";
import { AttendedNativeControllerSession } from "../../src/core/desktopUi/attendedNativeControllerSession.js";
import { sha256 } from "../../src/core/desktopUi/png.js";
import { semanticElementHash } from "../../src/core/desktopUi/remoteInputGuard.js";
import type { RemoteControlChallenge, RemoteHostScope } from "../../src/core/desktopUi/remoteControlAuthority.js";
import type { DesktopUiElement, DesktopUiSchema } from "../../src/core/desktopUi/types.js";

let dir="";
let cert!:Buffer,key!:Buffer,pin="";
beforeAll(()=>{
  dir=mkdtempSync(join(tmpdir(),"superagent-attended-control-"));
  const windowsGit="C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe";
  const executable=process.platform==="win32"&&existsSync(windowsGit)?windowsGit:"openssl";
  const result=spawnSync(executable,[
    "req","-x509","-newkey","rsa:2048","-nodes","-days","1",
    "-keyout","private.key","-out","private.crt",
    "-subj","/CN=viewer.private.test",
    "-addext","subjectAltName=DNS:viewer.private.test",
    "-addext","extendedKeyUsage=serverAuth,clientAuth",
  ],{cwd:dir,encoding:"utf8",timeout:20000,windowsHide:true});
  if(result.status!==0)throw Error("Disposable mTLS certificate unavailable");
  cert=readFileSync(join(dir,"private.crt"));
  key=readFileSync(join(dir,"private.key"));
  pin=createHash("sha256").update(new X509Certificate(cert).raw).digest("hex");
},30000);
afterAll(()=>{
  key?.fill(0);
  if(dir)rmSync(dir,{recursive:true,force:true});
});
const png=Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZsAAAAASUVORK5CYII=",
  "base64",
);
const element:DesktopUiElement={
  id:"typed",nativeRef:"automationId:TestInput",source:"accessibility",
  role:"textbox",label:"Approved input",description:null,value:"",
  actionable:true,focused:true,confidence:1,
  bounds:{x:10,y:10,width:100,height:25},center:{x:60,y:22.5},
};
const click={
  kind:"click",sequence:1,expectedRevision:1,expectedHash:sha256(png),
  elementId:"typed",expectedElementHash:semanticElementHash(element),
};
function setup(approval=true){
  const now=Date.now();
  let viewerActive=true;
  const credential={
    sessionId:"1".repeat(64),viewerChallenge:"2".repeat(64),
    viewerKey:"3".repeat(64),hostId:"trusted-os-host-00001",
    viewerId:"pinned-viewer-00001",expectedOrigin:"https://viewer.private.test",
    pinnedViewerCertSha256:pin,expiresAt:now+60_000,
  };
  const scope:RemoteHostScope={
    platform:"win32",pid:735,nativeId:"hwnd:735",
    processBirthId:"started-at-t42",osUserId:"S-1-test-user",
    hostSessionId:"session:1",hostGeneration:42,viewSessionId:credential.sessionId,
  };
  const schema:DesktopUiSchema={
    version:1,platform:"win32",
    screenshot:{
      revision:1,sha256:sha256(png),capturedAt:new Date(now-20).toISOString(),
      width:1,height:1,pixelRatioX:1,pixelRatioY:1,
      targetWindow:{
        pid:scope.pid,nativeId:scope.nativeId,title:"Test Window",
        bounds:{x:0,y:0,width:800,height:600},active:true,
      },
    },
    windows:[],warnings:[],elements:[element],
  };
  const nativeDispatch=vi.fn(async (_input:unknown,authorizeNow:()=>void)=>{authorizeNow();});
  const controller=new AttendedNativeControllerSession({
    hostTrust:{
      currentScope:()=>scope,
      authorizeCaller:()=>true,
      verifyNativeControlApproval:(c:RemoteControlChallenge,proof:unknown)=>
        typeof proof==="string"&&
        proof===createHmac("sha256","native-host-only-test-key")
          .update(JSON.stringify(c)).digest("hex"),
    },
    captureFresh:async()=>({verifiedInsideCapture:true as const,png,schema,hostScope:scope}),
    adapter:{platform:"win32",nativeRefOnly:true,dispatchVerifiedNativeRef:nativeDispatch},
    viewer:{humanTakeover:()=>{}},hostPlatform:"win32",now:()=>Date.now(),
  });
  const approveNative=vi.fn(async(c:RemoteControlChallenge)=>
    approval?createHmac("sha256","native-host-only-test-key")
      .update(JSON.stringify(c)).digest("hex"):"forged-proof");
  const host=new RemotePrivateControllerTlsHost({
    material:{
      privateAddress:"127.0.0.1",port:0,serverCertificate:cert,
      serverKey:key,viewerCa:cert,
    },
    credential,controller,approveNative,
    isApprovedViewerActive:sessionId=>viewerActive&&sessionId===credential.sessionId,
  });
  const connect=async()=>{
    const address=await host.start();
    const client=await RemotePrivateControllerClient.connect({
      privateAddress:address.address,port:address.port,
      credential,pinnedServerCertSha256:pin,
      clientCert:cert,clientKey:key,trustedCa:cert,
    });
    return client;
  };
  return {host,connect,controller,credential,nativeDispatch,approveNative,
    setViewerActive:(active:boolean)=>{viewerActive=active;},
  };
}

describe("separately approved private mTLS controller (no Core HTTP/MCP)",()=>{
  it("uses distinct mouse/keyboard approvals and dispatches only verified nativeRef input",async()=>{
    const f=setup();
    let client:RemotePrivateControllerClient|undefined;
    try{
      client=await f.connect();
      expect(client.isConnected).toBe(true);
      await expect(client.sendInput(click)).rejects.toThrow();
      expect(await client.requestScope("mouse")).toBe(true);
      expect(await client.sendInput(click)).toEqual({status:"dispatched"});
      expect(f.nativeDispatch).toHaveBeenCalledTimes(1);
      await expect(client.sendInput({...click,kind:"type",text:"blocked"})).rejects.toThrow();
      expect(await client.requestScope("keyboard")).toBe(true);
      expect(await client.sendInput({...click,kind:"type",text:"allowed"}))
        .toEqual({status:"dispatched"});
      expect(f.nativeDispatch).toHaveBeenCalledTimes(2);
      expect(f.approveNative).toHaveBeenCalledTimes(2);
      expect(await client.revokeScope("mouse")).toBe(true);
      await expect(client.sendInput(click)).rejects.toThrow();
      expect(await client.sendInput({...click,kind:"type",sequence:2,text:"still allowed"}))
        .toEqual({status:"dispatched"});
      expect(f.nativeDispatch).toHaveBeenCalledTimes(3);
    }finally{client?.close();f.host.stop();}
  },20000);

  it("rejects forged native approval without revealing a controller token",async()=>{
    const f=setup(false);
    let client:RemotePrivateControllerClient|undefined;
    try{
      client=await f.connect();
      expect(await client.requestScope("mouse")).toBe(false);
      await expect(client.sendInput(click)).rejects.toThrow();
      expect(f.nativeDispatch).not.toHaveBeenCalled();
      expect(f.approveNative).toHaveBeenCalledOnce();
    }finally{client?.close();f.host.stop();}
  },12000);

  it("terminally rejects reconnection using an already used viewer credential",async()=>{
    const f=setup();
    let client:RemotePrivateControllerClient|undefined;
    try{
      const address=await f.host.start();
      client=await RemotePrivateControllerClient.connect({
        privateAddress:address.address,port:address.port,
        credential:f.credential,pinnedServerCertSha256:pin,
        clientCert:cert,clientKey:key,trustedCa:cert,
      });
      expect(client.isConnected).toBe(true);
      client.close();
      await vi.waitFor(()=>expect(f.host.isStopped).toBe(true));
      await expect(RemotePrivateControllerClient.connect({
        privateAddress:address.address,port:address.port,
        credential:f.credential,pinnedServerCertSha256:pin,
        clientCert:cert,clientKey:key,trustedCa:cert,
      })).rejects.toThrow();
    }finally{client?.close();f.host.stop();}
  },12000);

  it("terminates the one-use listener and aborts a native approval on viewer disconnect",async()=>{
    const f=setup();
    let client:RemotePrivateControllerClient|undefined;
    let finishApproval:((proof:string)=>void)|undefined;
    f.approveNative.mockImplementation((challenge:RemoteControlChallenge)=>
      new Promise<string>(resolve=>{
        finishApproval=proof=>resolve(proof);
      }));
    try{
      client=await f.connect();
      const approval=client.requestScope("mouse");
      await vi.waitFor(()=>expect(f.approveNative).toHaveBeenCalledOnce());
      await expect(client.requestScope("keyboard")).rejects.toThrow(/BUSY_OR_DENIED/);
      client.close();
      await expect(approval).rejects.toThrow();
      await vi.waitFor(()=>expect(f.host.isStopped).toBe(true));
      expect(f.nativeDispatch).not.toHaveBeenCalled();
      finishApproval?.(createHmac("sha256","native-host-only-test-key")
        .update(JSON.stringify(f.approveNative.mock.calls[0]?.[0])).digest("hex"));
      await Promise.resolve();
      expect(f.host.isStopped).toBe(true);
      expect(f.nativeDispatch).not.toHaveBeenCalled();
    }finally{client?.close();f.host.stop();}
  },12000);

  it("revokes in-flight native input if private controller disconnects mid-action",async()=>{
    const f=setup();
    let client:RemotePrivateControllerClient|undefined;
    let releaseNative:(()=>void)|undefined;
    let nativeCheckpoint=vi.fn();
    f.nativeDispatch.mockImplementation(async(_input:unknown,authorizeNow:()=>void)=>{
      await new Promise<void>(resolve=>{releaseNative=resolve;});
      nativeCheckpoint();
      authorizeNow(); // Host lease must reject this after controller disconnect.
    });
    try{
      client=await f.connect();
      expect(await client.requestScope("mouse")).toBe(true);
      const input=client.sendInput(click);
      await vi.waitFor(()=>expect(f.nativeDispatch).toHaveBeenCalledOnce());
      client.close();
      await expect(input).rejects.toThrow();
      await vi.waitFor(()=>expect(f.host.isStopped).toBe(true));
      releaseNative?.();
      await vi.waitFor(()=>expect(nativeCheckpoint).toHaveBeenCalledOnce());
      expect(f.controller.isClosed).toBe(false); // View may survive; input lease is revoked.
      await expect(client.sendInput(click)).rejects.toThrow();
    }finally{releaseNative?.();client?.close();f.host.stop();}
  },12000);

  it("refuses to start a control socket without authoritative live viewer membership",async()=>{
    const f=setup();
    f.setViewerActive(false);
    await expect(f.host.start()).rejects.toThrow(/DENIED/);
    expect(f.host.isStopped).toBe(false);
    f.host.stop();
  });

  it("revokes a valid controller when the approved viewer session disappears",async()=>{
    const f=setup();
    let client:RemotePrivateControllerClient|undefined;
    try{
      client=await f.connect();
      expect(await client.requestScope("mouse")).toBe(true);
      f.setViewerActive(false);
      await expect(client.sendInput(click)).rejects.toThrow();
      await vi.waitFor(()=>expect(f.host.isStopped).toBe(true));
      expect(f.nativeDispatch).not.toHaveBeenCalled();
      await expect(client.sendInput(click)).rejects.toThrow();
    }finally{client?.close();f.host.stop();}
  },12000);

  it("denies public and wildcard listener interfaces before opening a socket",()=>{
    const f=setup();
    expect(()=>new RemotePrivateControllerTlsHost({
      material:{
        privateAddress:"0.0.0.0",port:0,serverCertificate:cert,
        serverKey:key,viewerCa:cert,
      },
      credential:f.credential,controller:f.controller,
      isApprovedViewerActive:()=>true,
      approveNative:async()=>true,
    })).toThrow(/DENIED/);
    f.host.stop();
  });
});
