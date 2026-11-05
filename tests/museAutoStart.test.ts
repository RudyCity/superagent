import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";

const state=vi.hoisted(()=>({
  mode:"telegram" as "off"|"telegram"|"websocket",
  active:false,
  control:vi.fn(),
}));

vi.mock("../src/core/remoteAgent/config.js",()=>({
  loadRemoteAgentConfig:()=>({
    museAutoStartMode:state.mode,
    wsPort:9225,
  }),
  migrateMuseTelegramBotTokenToSecureStorage:()=>({
    configured:false,storage:"none",platformProtected:false,
  }),
}));
vi.mock("../src/core/remoteAgent/museWatcherRegistry.js",()=>({
  getMuseWatcher:()=>state.active?{isActive:()=>true}:null,
}));
vi.mock("../src/core/runtime/desktopMuseLifecycle.js",()=>({
  controlCoreLocalMuse:state.control,
}));

describe("Muse Core auto-start",()=>{
  const oldVitest=process.env.VITEST;
  const oldNodeEnv=process.env.NODE_ENV;
  beforeEach(async()=>{
    vi.useFakeTimers();
    vi.resetModules();
    state.mode="telegram";
    state.active=false;
    state.control.mockReset();
    state.control.mockResolvedValue({success:true,state:"running"});
    delete process.env.VITEST;
    process.env.NODE_ENV="development";
  });
  afterEach(()=>{
    vi.useRealTimers();
    if(oldVitest===undefined) delete process.env.VITEST; else process.env.VITEST=oldVitest;
    if(oldNodeEnv===undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV=oldNodeEnv;
  });

  it("starts only the configured non-tunnel transport after Core bind",async()=>{
    const {scheduleMuseAutoStart}=await import("../src/core/runtime/museAutoStart.js");
    scheduleMuseAutoStart();
    await vi.advanceTimersByTimeAsync(800);
    expect(state.control).toHaveBeenCalledWith("start",process.pid,{
      mode:"telegram",port:9225,
    });
    expect(state.control.mock.calls.flat().join(" ")).not.toContain("tunnel");
  });

  it("does nothing when auto-start is explicitly off",async()=>{
    state.mode="off";
    const {scheduleMuseAutoStart}=await import("../src/core/runtime/museAutoStart.js");
    scheduleMuseAutoStart();
    await vi.advanceTimersByTimeAsync(1000);
    expect(state.control).not.toHaveBeenCalled();
  });
});
