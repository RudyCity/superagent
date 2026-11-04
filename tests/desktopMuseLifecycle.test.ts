import { describe, expect, it, vi } from "vitest";
import { transitionCoreMuseWatcher } from "../src/core/runtime/desktopMuseLifecycle.js";

function watcher(options: {running?:boolean;active?:boolean;queued?:number;tunnel?:boolean}={}) {
  let running = options.running ?? true;
  const started = vi.fn(async()=>{running=true});
  const stopped = vi.fn(async()=>{running=false});
  return {
    getStats:()=>({
      activeTaskId:options.active?"active-task":undefined,
      queuedBatches:options.queued??0,
      tunnel:options.tunnel??false,
    }),
    hasActiveBatch:()=>Boolean(options.active),
    isActive:()=>running,
    start:started,
    stop:stopped,
    started, stopped,
  };
}
describe("authenticated Core-local Muse Watch lifecycle guard",()=>{
  it("restarts same owner without changing its callbacks/agent instance",async()=>{
    const local=watcher();
    expect(await transitionCoreMuseWatcher(local as any,"restart")).toMatchObject({success:true,state:"running"});
    expect(local.stopped).toHaveBeenCalledTimes(1);
    expect(local.started).toHaveBeenCalledTimes(1);
  });
  it("stops without silently restarting",async()=>{
    const local=watcher();
    await transitionCoreMuseWatcher(local as any,"stop");
    expect(local.started).not.toHaveBeenCalled();
    expect(local.stopped).toHaveBeenCalledTimes(1);
    await expect(transitionCoreMuseWatcher(local as any,"stop")).rejects.toThrow("already stopped");
    expect(await transitionCoreMuseWatcher(local as any,"restart")).toMatchObject({state:"running"});
  });
  it("rejects active batches, queued batches and tunnel-owned watcher without mutation",async()=>{
    for(const options of [{active:true},{queued:2},{tunnel:true}]){
      const local=watcher(options);
      await expect(transitionCoreMuseWatcher(local as any,"restart")).rejects.toThrow();
      expect(local.stopped).not.toHaveBeenCalled();
      expect(local.started).not.toHaveBeenCalled();
    }
    const active=watcher({active:true});
    await expect(transitionCoreMuseWatcher(active as any,"stop")).rejects.toThrow("active");
    expect(active.stopped).not.toHaveBeenCalled();
  });
  it("rejects missing owner",async()=>{
    await expect(transitionCoreMuseWatcher(null,"restart")).rejects.toThrow("No Core-owned");
  });
});
