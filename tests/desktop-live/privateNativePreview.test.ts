import { describe, expect, it } from "vitest";
import {
  NativeWindowPreviewManager, PRIVATE_PREVIEW_INTERVAL_MS, PRIVATE_PREVIEW_TTL_MS,
} from "../../src/core/desktopUi/livePreview.js";
import type {
  DesktopDiscoveredWindow, DesktopUiAdapter, DesktopUiCapabilities, NativeCapture,
} from "../../src/core/desktopUi/types.js";

const target: DesktopDiscoveredWindow = {
  pid: 4102, nativeId: "window-41", title: "Document A", application: "Editor",
  active: false, bounds: { x: 20, y: 30, width: 960, height: 640 },
};
function tinyPng(): Uint8Array {
  const out = Buffer.alloc(24);
  Buffer.from([137,80,78,71,13,10,26,10]).copy(out);
  out.writeUInt32BE(960,16); out.writeUInt32BE(640,20);
  return out;
}
function adapterFor(platform: "win32"|"darwin"|"linux", state: {
  source?: DesktopDiscoveredWindow; captured?: DesktopDiscoveredWindow;
  count?: number; throwCapture?: boolean;
}): DesktopUiAdapter {
  return {
    platform,
    async probe(): Promise<DesktopUiCapabilities> {
      return { platform, available:true, screenshot:true, accessibility:true,
        input:false, scroll:false, prerequisites:[], limitations:[], errors:[] };
    },
    async listWindows(limit) {
      return { windows: [state.source ?? target], limit, truncated:false };
    },
    async capture(): Promise<NativeCapture> {
      state.count = (state.count ?? 0)+1;
      if (state.throwCapture) throw Error("not authorized");
      return { image:tinyPng(), targetWindow: state.captured ?? state.source ?? target,
        capturedAt: "2026-11-14T00:00:00.000Z" };
    },
    async inspectAccessibility() { throw Error("not used"); },
    async dispatch() { throw Error("preview must never send native input"); },
  };
}
describe("private native desktop window live preview", () => {
  for (const platform of ["win32","darwin","linux"] as const) {
    it(`validates one exact ${platform} native window and produces a bounded image`, async () => {
      let time = 500;
      const state = { count: 0 };
      const manager = new NativeWindowPreviewManager(() => adapterFor(platform,state),()=>time);
      const windows = await manager.discover();
      expect(windows.platform).toBe(platform);
      expect(windows.windows).toHaveLength(1);
      const started = await manager.start({pid:target.pid,nativeId:target.nativeId,consent:true});
      expect(started.token).toMatch(/^[a-f0-9]{64}$/);
      const frame = await manager.frame({token:started.token});
      expect(frame.format).toBe("png");
      expect(Buffer.from(frame.png,"base64").subarray(0,8)).toEqual(Buffer.from(tinyPng()).subarray(0,8));
      expect(state.count).toBe(1);
      await expect(manager.frame({token:started.token})).rejects.toThrow(/rate limited/);
      time += PRIVATE_PREVIEW_INTERVAL_MS;
      expect((await manager.frame({token:started.token})).width).toBe(960);
      expect(manager.stop({token:started.token})).toEqual({stopped:true});
      await expect(manager.frame({token:started.token})).rejects.toThrow(/revoked/);
    });
  }

  it("requires explicit consent; refuses swapped, extra and missing keys", async () => {
    const m = new NativeWindowPreviewManager(()=>adapterFor("win32",{}));
    await expect(m.start({pid:4102,nativeId:"window-41",consent:false})).rejects.toThrow(/consent/);
    await expect(m.start({pid:4102,nativeId:"window-41",consent:true,extra:1})).rejects.toThrow(/Invalid/);
    await expect(m.start({pid:4102,nativeId:"forged",consent:true})).rejects.toThrow(/not present/);
    await expect(m.frame({token:"a".repeat(64)})).rejects.toThrow(/revoked/);
  });

  it("refuses concurrent sessions and another token cannot stop a live session", async () => {
    const m = new NativeWindowPreviewManager(()=>adapterFor("win32",{}));
    const a = await m.start({pid:4102,nativeId:"window-41",consent:true});
    await expect(m.start({pid:4102,nativeId:"window-41",consent:true})).rejects.toThrow(/already active/);
    expect(()=>m.stop({token:"b".repeat(64)})).toThrow(/revoked/);
    expect((await m.frame({token:a.token})).format).toBe("png");
  });

  it("revokes session on a changed identity before releasing pixels", async () => {
    const state: {source?:DesktopDiscoveredWindow} = {};
    const m = new NativeWindowPreviewManager(()=>adapterFor("darwin",state));
    const started = await m.start({pid:4102,nativeId:"window-41",consent:true});
    state.source = {...target,title:"Other private document"};
    await expect(m.frame({token:started.token})).rejects.toThrow(/stopped/);
    await expect(m.frame({token:started.token})).rejects.toThrow(/revoked/);
  });

  it("fails closed if a captured PNG has the dimensions of another surface", async () => {
    const image=tinyPng();
    image.writeUInt32BE(1920,16);
    image.writeUInt32BE(1080,20);
    const adapter=adapterFor("win32",{});
    adapter.capture=async()=>({image,targetWindow:target,capturedAt:"2026-11-14T00:00:00.000Z"});
    const manager=new NativeWindowPreviewManager(()=>adapter);
    const {token}=await manager.start({pid:target.pid,nativeId:target.nativeId,consent:true});
    await expect(manager.frame({token})).rejects.toThrow(/stopped/);
    await expect(manager.frame({token})).rejects.toThrow(/revoked/);
  });

  it("rejects an unexpected PNG size even if the native worker claims the same HWND", async () => {
    const image=tinyPng();
    image.writeUInt32BE(1920,16);
    image.writeUInt32BE(1280,20);
    const adapter=adapterFor("win32",{});
    let closes=0;
    adapter.openVerifiedCapture=async()=>({
      backend:"win32-persistent-exact-hwnd",verifiedInsideCapture:true as const,
      capture:async()=>({image,targetWindow:target,capturedAt:"2026-11-14T00:00:00.000Z"}),
      close:()=>{closes++;},
    });
    const manager=new NativeWindowPreviewManager(()=>adapter);
    const {token}=await manager.start({pid:target.pid,nativeId:target.nativeId,consent:true});
    await expect(manager.frame({token})).rejects.toThrow(/stopped/);
    expect(closes).toBe(1);
    await expect(manager.frame({token})).rejects.toThrow(/revoked/);
  });

  it("permits a proportional 2x macOS native screenshot while preserving exact target identity", async () => {
    const retina=tinyPng();
    retina.writeUInt32BE(target.bounds.width*2,16);
    retina.writeUInt32BE(target.bounds.height*2,20);
    const adapter=adapterFor("darwin",{});
    adapter.capture=async()=>({image:retina,targetWindow:target,capturedAt:"2026-11-14T00:00:00.000Z"});
    const manager=new NativeWindowPreviewManager(()=>adapter);
    const {token}=await manager.start({pid:target.pid,nativeId:target.nativeId,consent:true});
    const frame=await manager.frame({token});
    expect(frame.width).toBe(target.bounds.width*2);
    expect(frame.height).toBe(target.bounds.height*2);
    expect(manager.stop({token})).toEqual({stopped:true});
  });

  it("revokes session when capture identity differs from exact selection", async () => {
    const state = {captured:{...target,pid:999}};
    const m = new NativeWindowPreviewManager(()=>adapterFor("win32",state));
    const started = await m.start({pid:4102,nativeId:"window-41",consent:true});
    await expect(m.frame({token:started.token})).rejects.toThrow(/stopped/);
    await expect(m.frame({token:started.token})).rejects.toThrow(/revoked/);
  });

  it("revokes the session after OS permission/capture failure", async () => {
    const state = {throwCapture:true};
    const m = new NativeWindowPreviewManager(()=>adapterFor("linux",state));
    const started = await m.start({pid:4102,nativeId:"window-41",consent:true});
    await expect(m.frame({token:started.token})).rejects.toThrow(/stopped/);
    await expect(m.frame({token:started.token})).rejects.toThrow(/revoked/);
  });

  it("never releases a frame after Stop races with an in-flight native capture", async () => {
    let captureStarted!: () => void;
    let finishCapture!: () => void;
    const entered = new Promise<void>(resolve => { captureStarted = resolve; });
    const delayed = new Promise<void>(resolve => { finishCapture = resolve; });
    const base = adapterFor("win32", {});
    base.capture = async () => {
      captureStarted();
      await delayed;
      return {image:tinyPng(),capturedAt:"2026-11-14T00:00:00.000Z",targetWindow:target};
    };
    const manager = new NativeWindowPreviewManager(() => base);
    const started = await manager.start({pid:target.pid,nativeId:target.nativeId,consent:true});
    const pending = manager.frame({token:started.token});
    await entered;
    expect(manager.stop({token:started.token})).toEqual({stopped:true});
    finishCapture();
    await expect(pending).rejects.toThrow(/stopped/);
    await expect(manager.frame({token:started.token})).rejects.toThrow(/revoked/);
  });

  it("uses a trusted verified native source without repeated desktop discovery and closes it", async () => {
    let now = 100;
    let discoveries = 0;
    let nativeFrames = 0;
    let closed = 0;
    const adapter = adapterFor("win32",{});
    const originalDiscover = adapter.listWindows!.bind(adapter);
    adapter.listWindows = async limit => {
      discoveries += 1;
      return originalDiscover(limit);
    };
    adapter.capture = async () => { throw Error("Never call legacy capture after verified native source opens"); };
    adapter.openVerifiedCapture = async () => ({
      backend: "disposable-native-source", verifiedInsideCapture: true as const,
      capture: async () => {
        nativeFrames += 1;
        return { image:tinyPng(), targetWindow:target, capturedAt:"2026-11-14T00:00:00Z" };
      },
      close: () => { closed += 1; },
    });
    const manager = new NativeWindowPreviewManager(()=>adapter,()=>now);
    const started = await manager.start({pid:target.pid,nativeId:target.nativeId,consent:true});
    expect(started.backend).toBe("disposable-native-source");
    expect(discoveries).toBe(1);
    expect((await manager.frame({token:started.token})).format).toBe("png");
    now += PRIVATE_PREVIEW_INTERVAL_MS;
    expect((await manager.frame({token:started.token})).format).toBe("png");
    expect(nativeFrames).toBe(2);
    expect(discoveries).toBe(1);
    expect(manager.stop({token:started.token})).toEqual({stopped:true});
    expect(closed).toBe(1);
  });

  it("closes a verified native source before releasing an in-flight frame after Stop", async () => {
    let startedCapture!:()=>void;
    let finishCapture!:()=>void;
    let closures=0;
    const entered=new Promise<void>(resolve=>{startedCapture=resolve;});
    const delayed=new Promise<void>(resolve=>{finishCapture=resolve;});
    const adapter=adapterFor("win32",{});
    adapter.openVerifiedCapture=async()=>({
      backend:"disposable-native-source",verifiedInsideCapture:true as const,
      capture:async()=>{
        startedCapture();
        await delayed;
        return {image:tinyPng(),targetWindow:target,capturedAt:"2026-11-14T00:00:00Z"};
      },
      close:()=>{closures++;},
    });
    const manager=new NativeWindowPreviewManager(()=>adapter);
    const {token}=await manager.start({pid:target.pid,nativeId:target.nativeId,consent:true});
    const inFlight=manager.frame({token});
    await entered;
    expect(manager.stop({token})).toEqual({stopped:true});
    expect(closures).toBe(1);
    finishCapture();
    await expect(inFlight).rejects.toThrow(/stopped/);
    await expect(manager.frame({token})).rejects.toThrow(/revoked/);
    expect(closures).toBe(2);
  });

  it("binds a native approval to the exact title, app and bounds shown by the OS", async () => {
    const approval = {pid:target.pid,nativeId:target.nativeId,consent:true,
      expectedTitle:target.title,expectedApplication:target.application,expectedBounds:target.bounds};
    const allowed = new NativeWindowPreviewManager(()=>adapterFor("win32",{}));
    expect((await allowed.start(approval)).window.title).toBe(target.title);
    for (const change of [
      {expectedTitle:"Different private window"},
      {expectedApplication:"Spoofed app"},
      {expectedBounds:{...target.bounds,width:target.bounds.width+1}},
    ]) {
      const manager = new NativeWindowPreviewManager(()=>adapterFor("win32",{}));
      await expect(manager.start({...approval,...change})).rejects.toThrow(/changed/);
    }
    const manager = new NativeWindowPreviewManager(()=>adapterFor("win32",{}));
    await expect(manager.start({...approval,expectedBounds:undefined})).rejects.toThrow(/invalid/i);
    await expect(manager.start({...approval,unexpected:true})).rejects.toThrow(/Invalid/);
  });

  it("expires independently of user activity; never silently renews consent", async () => {
    let time = 0;
    const m = new NativeWindowPreviewManager(()=>adapterFor("linux",{}),()=>time);
    const started = await m.start({pid:4102,nativeId:"window-41",consent:true});
    time = PRIVATE_PREVIEW_TTL_MS;
    await expect(m.frame({token:started.token})).rejects.toThrow(/expired/);
    await expect(m.frame({token:started.token})).rejects.toThrow(/revoked/);
  });
});
