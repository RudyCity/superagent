import { describe, expect, it, vi } from "vitest";
import { trayManagedChromeAction } from "../src/core/browserRuntime/trayManagedChrome.js";
import type { BrowserProcessManager } from "../src/core/browserRuntime/browserProcessManager.js";

function manager() {
  const checkHealth = vi.fn(async () => ({
    status: "healthy", port: 9222, host: "127.0.0.1",
    listening: true, browserVersion: "Chrome/136",
    browserFingerprint: "foreign-fingerprint", targetCount: 2,
  }));
  const launchBrowser = vi.fn(async () => ({pid:12345}));
  const stopBrowser = vi.fn(async () => ({success:true}));
  const getActiveInstance = vi.fn(() => undefined);
  const getDefaultUserDataDir = vi.fn((port:number)=> "/tmp/superagent-chrome-"+port);
  const mock = {checkHealth,launchBrowser,stopBrowser,getActiveInstance,getDefaultUserDataDir};
  return { ...mock, value: mock as unknown as BrowserProcessManager };
}
describe("local Tray Managed CDP owner boundary", () => {
  it("returns read-only foreign-port status without exposing a PID or record ID", async () => {
    const fake=manager();
    const status=await trayManagedChromeAction({action:"status",port:9222},fake.value);
    expect(status).toMatchObject({
      success:true,port:9222,reachable:true,occupied:true,
      owned:false,canStop:false,pid:null,recordId:null,targetCount:2,
    });
    expect(fake.launchBrowser).not.toHaveBeenCalled();
    expect(fake.stopBrowser).not.toHaveBeenCalled();
  });
  it("refuses unconfirmed launch/stop, invalid ports and unknown fields", async () => {
    const fake=manager();
    for (const input of [
      {action:"launch",port:9222,mode:"headed"},
      {action:"stop",port:9222,expectedPid:12345,recordId:"owned-record"},
      {action:"status",port:9222,filePath:"C:/secret"},
      {action:"status",port:80},
      {action:"status",port:99999},
      {action:"launch",port:9222,confirm:true,mode:"invalid"},
      {action:"launch",port:9222,confirm:true,url:"file:///private"},
      {action:"launch",port:9222,confirm:true,url:"https://user:password@host.test"},
    ]) {
      await expect(trayManagedChromeAction(input,fake.value)).rejects.toThrow();
    }
    expect(fake.launchBrowser).not.toHaveBeenCalled();
    expect(fake.stopBrowser).not.toHaveBeenCalled();
  });
  it("never stops an unrelated or stale process even with confirmation", async () => {
    const fake=manager();
    await expect(trayManagedChromeAction({
      action:"stop",port:9222,confirm:true,expectedPid:12345,recordId:"owned-record",
    },fake.value)).rejects.toThrow(/MANAGED_CDP_STOP_OWNER_MISMATCH/);
    expect(fake.stopBrowser).not.toHaveBeenCalled();
  });
});
