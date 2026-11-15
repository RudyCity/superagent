import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  parseTrayQuickTunnelUrl, startTrayQuickTunnel,
} from "../../src/core/desktopUi/trayQuickTunnel.js";

function fakeProcess(){
  const child=new EventEmitter() as any;
  child.pid=54321;
  child.exitCode=null;
  child.signalCode=null;
  child.stdout=new PassThrough();
  child.stderr=new PassThrough();
  child.kill=vi.fn((_signal:string)=>{
    child.exitCode=0;
    child.emit("exit",0,null);
    return true;
  });
  return child;
}
const instances:any[]=[];
afterEach(()=>{for(const child of instances.splice(0)){child.stdout.destroy();child.stderr.destroy();}});
describe("Tray-only Quick Tunnel lifecycle",()=>{
  it("extracts only temporary Cloudflare HTTPS origins from bounded process output",()=>{
    expect(parseTrayQuickTunnelUrl("url: https://fresh-mango.trycloudflare.com |")).toBe("https://fresh-mango.trycloudflare.com");
    expect(parseTrayQuickTunnelUrl("https://mcp.example.net")).toBeNull();
    expect(parseTrayQuickTunnelUrl("http://insecure.trycloudflare.com")).toBeNull();
    expect(parseTrayQuickTunnelUrl("https://localhost.trycloudflare.com.evil.net")).toBeNull();
    expect(parseTrayQuickTunnelUrl("Docs https://developers.cloudflare.com then https://good-url.trycloudflare.com |"))
      .toBe("https://good-url.trycloudflare.com");
  });
  it("starts only an owned cloudflared process targeting the dedicated management origin",async()=>{
    const child=fakeProcess();instances.push(child);
    const spawnChild=vi.fn(()=>child);
    const onExit=vi.fn();
    const pending=startTrayQuickTunnel({
      originPort:19330,findBinary:async()=>"/usr/bin/cloudflared",
      spawnChild:spawnChild as any,onExit,timeoutMs:1500,
    });
    await new Promise(resolve=>setImmediate(resolve));
    expect(spawnChild).toHaveBeenCalledWith("/usr/bin/cloudflared",
      ["tunnel","--url","http://127.0.0.1:19330","--no-autoupdate"],
      expect.objectContaining({shell:false,windowsHide:true}));
    child.stderr.write("Request a quick tunnel: https://");
    child.stderr.write("fresh-mango.trycloudflare.com\n");
    const lease=await pending;
    expect(lease.publicUrl).toBe("https://fresh-mango.trycloudflare.com");
    expect(lease.pid).toBe(54321);
    await lease.stop();
    await lease.stop();
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(onExit).not.toHaveBeenCalled();
  });
  it("fails closed if cloudflared exits without publishing a URL",async()=>{
    const child=fakeProcess();instances.push(child);
    const pending=startTrayQuickTunnel({
      originPort:19330,findBinary:async()=>"/usr/bin/cloudflared",
      spawnChild:(()=>child) as any,timeoutMs:1000,
    });
    await new Promise(resolve=>setImmediate(resolve));
    child.exitCode=2;
    child.emit("exit",2,null);
    await expect(pending).rejects.toThrow("TRAY_QUICK_EARLY_EXIT");
    expect(child.kill).not.toHaveBeenCalled();
  });
  it("cancels only the newly owned process on abort",async()=>{
    const child=fakeProcess();instances.push(child);
    const abort=new AbortController();
    const pending=startTrayQuickTunnel({
      originPort:19330,findBinary:async()=>"/usr/bin/cloudflared",
      spawnChild:(()=>child) as any,signal:abort.signal,timeoutMs:1000,
    });
    await new Promise(resolve=>setImmediate(resolve));
    abort.abort();
    await expect(pending).rejects.toThrow("TRAY_QUICK_CANCELLED");
    expect(child.kill).toHaveBeenCalledTimes(1);
  });
  it("protects Core/MCP/Named ports and rejects arbitrary executable names",async()=>{
    await expect(startTrayQuickTunnel({originPort:9227})).rejects.toThrow("TRAY_QUICK_PROTECTED_PORT");
    await expect(startTrayQuickTunnel({
      originPort:19330,findBinary:async()=>"/tmp/evil-script",spawnChild:(()=>fakeProcess()) as any,
    })).rejects.toThrow("TRAY_QUICK_CLOUDFLARED_REQUIRED");
  });
  it("immediately drops an established Quick Tunnel after an unexpected child exit",async()=>{
    const child=fakeProcess();instances.push(child);
    const onExit=vi.fn();
    const pending=startTrayQuickTunnel({
      originPort:19330,findBinary:async()=>"/usr/bin/cloudflared",
      spawnChild:(()=>child) as any,onExit,timeoutMs:1500,
    });
    await new Promise(resolve=>setImmediate(resolve));
    child.stderr.write("https://coral-reef.trycloudflare.com");
    await pending;
    child.exitCode=1;
    child.emit("exit",1,null);
    expect(onExit).toHaveBeenCalledOnce();
  });
});
