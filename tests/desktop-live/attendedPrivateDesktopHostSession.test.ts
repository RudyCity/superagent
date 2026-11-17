import { describe, expect, it, vi } from "vitest";
import {
  AttendedPrivateDesktopHostSession,
} from "../../src/core/desktopUi/attendedPrivateDesktopHostSession.js";
import { RemotePrivateHostOperator } from "../../src/core/desktopUi/remotePrivateOperator.js";
import type {
  RemotePrivateHostTlsListener,
} from "../../src/core/desktopUi/remotePrivateHostTlsListener.js";
import type {
  AttendedNativeControllerSession,
} from "../../src/core/desktopUi/attendedNativeControllerSession.js";

const startArg={
  nativeWindow:{
    hostId:"attended-host",viewerId:"private-viewer",
    expectedOrigin:"https://viewer.private.test",
    window:{
      pid:901,nativeId:"901",title:"Approved Window",application:"Test App",
      bounds:{x:0,y:0,width:600,height:480},
    },
  },
  nativeRemoteProof:"separate-native-signed-proof",
  localPreviewToken:"a".repeat(64),
};

function fixture(operator=new RemotePrivateHostOperator()) {
  const log:string[]=[];
  let endHook: {viewerDisconnected():void} | null = null;
  let releaseStart: (()=>void) | null = null;
  let waiting=false;
  const result={
    address:"127.0.0.1",port:10004,expiresAt:100000,
    viewerCredential:{viewerKey:"b".repeat(64)},
  };
  const controller={
    isClosed:false,
    humanTakeover:vi.fn(()=>{
      if(!controller.isClosed) log.push("input-revoked");
      controller.isClosed=true;
    }),
    viewerDisconnected:vi.fn(()=>{
      if(!controller.isClosed)log.push("viewer-disconnected-revokes-input");
      controller.isClosed=true;
    }),
  };
  const listener={
    isStopped:false,
    isViewing:false,
    registerControllerEndHook:vi.fn((hook:{viewerDisconnected():void})=>{
      if(endHook)throw Error("already installed");
      endHook=hook;
    }),
    start:vi.fn(async()=>{
      if(waiting)await new Promise<void>(resolve=>{releaseStart=resolve;});
      if(listener.isStopped)throw Error("stopped during host start");
      listener.isViewing=true;
      return result;
    }),
    stop:vi.fn(()=>{
      if(listener.isStopped)return;
      listener.isStopped=true;
      listener.isViewing=false;
      log.push("viewer-stopped");
      endHook?.viewerDisconnected();
    }),
    humanTakeover:()=>listener.stop(),
  };
  const host=new AttendedPrivateDesktopHostSession({
    listener:listener as unknown as RemotePrivateHostTlsListener,
    controller:controller as unknown as AttendedNativeControllerSession,
    operator,
  });
  return {
    host,operator,controller,listener,log,result,
    setPending:()=>{waiting=true;},
    release:()=>{releaseStart?.();},
  };
}

describe("one native Desktop Live host: mTLS viewer + scoped input lifecycle",()=>{
  it("registers host permissions before start and tears down input first",async()=>{
    const f=fixture();
    expect(f.listener.registerControllerEndHook).toHaveBeenCalledOnce();
    expect(f.listener.start).not.toHaveBeenCalled();
    expect(f.host.isViewing).toBe(false);
    expect(await f.host.start(startArg)).toEqual(f.result);
    expect(f.host.isViewing).toBe(true);
    f.host.humanTakeover();
    expect(f.host.isStopped).toBe(true);
    expect(f.log[0]).toBe("input-revoked");
    expect(f.log).toContain("viewer-stopped");
    expect(f.controller.humanTakeover).toHaveBeenCalledOnce();
    expect(f.listener.stop).toHaveBeenCalled();
    f.host.stop();
    expect(f.controller.humanTakeover).toHaveBeenCalledOnce();
  });

  it("peer mTLS disconnection revokes every controller grant even without Tray UI",async()=>{
    const f=fixture();
    await f.host.start(startArg);
    f.listener.stop();
    expect(f.controller.viewerDisconnected).toHaveBeenCalledOnce();
    expect(f.controller.isClosed).toBe(true);
    expect(f.host.isStopped).toBe(true);
    await expect(f.host.start(startArg)).rejects.toThrow(/DENIED/);
  });

  it("cannot resurrect a host when local takeover races with native approval",async()=>{
    const f=fixture();
    f.setPending();
    const future=f.host.start(startArg);
    f.host.humanTakeover();
    f.release();
    await expect(future).rejects.toThrow(/FAILED/);
    expect(f.host.isStopped).toBe(true);
    expect(f.controller.isClosed).toBe(true);
    expect(f.listener.isStopped).toBe(true);
  });

  it("refuses duplicate host registration without terminating the existing host",async()=>{
    const operator=new RemotePrivateHostOperator();
    const first=fixture(operator);
    const secondController={isClosed:false,
      humanTakeover:vi.fn(),
      viewerDisconnected:vi.fn()};
    const secondListener={isStopped:false,
      registerControllerEndHook:vi.fn(),
      stop:vi.fn(),
      start:vi.fn(),
      humanTakeover:vi.fn(),
    };
    expect(()=>new AttendedPrivateDesktopHostSession({
      listener:secondListener as unknown as RemotePrivateHostTlsListener,
      controller:secondController as unknown as AttendedNativeControllerSession,
      operator,
    })).toThrow(/REGISTRATION_FAILED/);
    expect(secondController.humanTakeover).toHaveBeenCalledOnce();
    expect(secondListener.stop).toHaveBeenCalledOnce();
    expect(first.host.isStopped).toBe(false);
    expect(first.controller.humanTakeover).not.toHaveBeenCalled();
    first.host.stop();
  });

  it("fails closed if the private listener or controller was already terminated",()=>{
    const f=fixture();
    f.host.stop();
    expect(()=>new AttendedPrivateDesktopHostSession({
      listener:f.listener as unknown as RemotePrivateHostTlsListener,
      controller:f.controller as unknown as AttendedNativeControllerSession,
      operator:new RemotePrivateHostOperator(),
    })).toThrow(/NOT_ATTESTED/);
  });
});
