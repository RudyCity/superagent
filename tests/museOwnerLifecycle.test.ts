import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { MuseWatcher } from "../src/core/remoteAgent/museWatcher.js";
import { saveRemoteAgentConfig } from "../src/core/remoteAgent/config.js";
import { MuseOwnerLifecycle } from "../src/core/remoteAgent/museOwnerLifecycle.js";
import type { RemoteTransport } from "../src/core/remoteAgent/transport.js";

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, {recursive:true,force:true});
});
function root() {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"sa-muse-private-owner-"));
  dirs.push(dir);
  return dir;
}
function fakeTransport():RemoteTransport {
  let running=false;
  return {
    type:"websocket",
    start: async()=>{running=true},
    stop:async()=>{running=false},
    isConnected:()=>running,
    sendEnvelope:async()=>true,
    getTransportInfo:()=>({type:"websocket",details:"test private owner"}),
  };
}
describe("Muse owner private localhost lifecycle",()=>{
  it("requires bearer and preserves owner identity on stop/restart without losing callbacks",async()=>{
    const dir=root(),cfg=path.join(dir,"remote-agent.json");
    vi.stubEnv("SUPERAGENT_CONFIG_DIR",dir);
    saveRemoteAgentConfig({transport:"websocket"},cfg);
    const watcher = new MuseWatcher({
      workspace:dir,customConfigPath:cfg,transport:fakeTransport(),announce:false,
    });
    await watcher.start();
    try {
      const names=fs.readdirSync(dir);
      const presenceName=names.find(n=>n.startsWith(`muse-watch-${process.pid}-`));
      const leaseName=names.find(n=>n.startsWith(`muse-owner-${process.pid}-`));
      expect(presenceName).toBeDefined();expect(leaseName).toBeDefined();
      const presence=JSON.parse(fs.readFileSync(path.join(dir,presenceName!),"utf8"));
      const lease=JSON.parse(fs.readFileSync(path.join(dir,leaseName!),"utf8"));
      expect(presence.controlPort).toBe(lease.controlPort);
      expect(presence.controlId).toBe(lease.controlId);
      expect(JSON.stringify(presence)).not.toContain(lease.controlToken);
      expect(presence).not.toHaveProperty("botToken");
      const base=`http://127.0.0.1:${lease.controlPort}/_muse`;
      const noAuth=await fetch(base+"/status");
      expect(noAuth.status).toBe(401);
      const headers={Authorization:`Bearer ${lease.controlToken}`};
      const authenticated=await fetch(base+"/status",{headers});
      expect(authenticated.status).toBe(200);
      const original=await authenticated.json() as any;
      expect(original).toMatchObject({version:1,service:"superagent-muse-owner",
        pid:process.pid,controlId:lease.controlId,running:true});
      expect(JSON.stringify(original)).not.toContain(lease.controlToken);
      const stop=await fetch(base+"/stop",{method:"POST",headers});
      expect(stop.status).toBe(200);
      expect((await stop.json() as any).state).toBe("stopped");
      expect(watcher.isActive()).toBe(false);
      const afterStop=JSON.parse(fs.readFileSync(path.join(dir,presenceName!),"utf8"));
      expect(afterStop.running).toBe(false);
      expect(fs.existsSync(path.join(dir,leaseName!))).toBe(true);
      const restart=await fetch(base+"/restart",{method:"POST",headers});
      expect(restart.status).toBe(200);
      expect((await restart.json() as any).state).toBe("running");
      expect(watcher.isActive()).toBe(true);
      expect(fs.readdirSync(dir).filter(n=>n.startsWith("muse-owner-"))).toEqual([leaseName]);
    }finally{
      await watcher.stop();
    }
    expect(fs.readdirSync(dir).filter(n=>/^(muse-owner|muse-watch)-/.test(n))).toHaveLength(0);
  });
  it("regenerates a supported WebSocket bearer only via private authenticated owner and never returns the secret",async()=>{
    const dir=root(),id="abcd9876abcd";
    let active=false;
    const rotate=vi.fn(async()=>({copied:true}));
    const owner=new MuseOwnerLifecycle(dir,id,{
      status:()=>({running:true,ready:true,activeTask:active,
        queueSize:0,tunnelOwned:true,tokenRotationSupported:true}),
      change:async()=>{},
      rotateToken:rotate,
    });
    await owner.listen();
    try{
      const lease=JSON.parse(fs.readFileSync(
        path.join(dir,`muse-owner-${process.pid}-${id}.json`),"utf8"));
      const endpoint=`http://127.0.0.1:${lease.controlPort}/_muse`;
      const unauthorized=await fetch(endpoint+"/token/rotate",{method:"POST"});
      expect(unauthorized.status).toBe(401);
      expect(rotate).not.toHaveBeenCalled();
      const headers={Authorization:`Bearer ${lease.controlToken}`};
      const before=await (await fetch(endpoint+"/status",{headers})).json() as any;
      expect(before.tokenRotationSupported).toBe(true);
      const rotated=await fetch(endpoint+"/token/rotate",{method:"POST",headers});
      expect(rotated.status).toBe(200);
      const payload=await rotated.json() as any;
      expect(payload).toMatchObject({
        success:true,kind:"muse-watch",action:"regenerate-token",
        copied:true,controlId:lease.controlId,pid:process.pid,
      });
      expect(rotate).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(payload)).not.toContain(lease.controlToken);
      expect(payload).not.toHaveProperty("newToken");
      active=true;
      const denied=await fetch(endpoint+"/token/rotate",{method:"POST",headers});
      expect(denied.status).toBe(409);
      expect(rotate).toHaveBeenCalledTimes(1);
      active=false;
    }finally{owner.close()}
  });
  it("does not claim rotation for Telegram or other unsupported transports",async()=>{
    const dir=root(),id="f00df00df00d";
    const rotate=vi.fn(async()=>({copied:true}));
    const owner=new MuseOwnerLifecycle(dir,id,{
      status:()=>({running:true,ready:true,activeTask:false,
        queueSize:0,tunnelOwned:false,tokenRotationSupported:false}),
      change:async()=>{},rotateToken:rotate,
    });
    await owner.listen();
    try{
      const lease=JSON.parse(fs.readFileSync(
        path.join(dir,`muse-owner-${process.pid}-${id}.json`),"utf8"));
      const headers={Authorization:`Bearer ${lease.controlToken}`};
      const status=await (await fetch(`http://127.0.0.1:${lease.controlPort}/_muse/status`,{headers})).json() as any;
      expect(status.tokenRotationSupported).toBe(false);
      const denied=await fetch(`http://127.0.0.1:${lease.controlPort}/_muse/token/rotate`,{method:"POST",headers});
      expect(denied.status).toBe(409);
      expect(rotate).not.toHaveBeenCalled();
    }finally{owner.close()}
  });
  it("denies active task and tunnel-owning restart before invoking callbacks",async()=>{
    const dir=root(),id="abcdefabcdef";
    let active=true,stopped=vi.fn(),restarted=vi.fn();
    const control=new MuseOwnerLifecycle(dir,id,{
      status:()=>({running:true,ready:true,activeTask:active,queueSize:0,tunnelOwned:false}),
      change:async(action)=>{if(action==="stop")stopped();else restarted();},
    });
    await control.listen();
    try{
      const lease=JSON.parse(fs.readFileSync(path.join(dir,`muse-owner-${process.pid}-${id}.json`),"utf8"));
      const headers={Authorization:`Bearer ${lease.controlToken}`};
      const response=await fetch(`http://127.0.0.1:${lease.controlPort}/_muse/stop`,{method:"POST",headers});
      expect(response.status).toBe(409);
      expect(stopped).not.toHaveBeenCalled();
      expect(restarted).not.toHaveBeenCalled();
      active=false;
      const safe=await fetch(`http://127.0.0.1:${lease.controlPort}/_muse/stop`,{method:"POST",headers});
      expect(safe.status).toBe(200);
      expect(stopped).toHaveBeenCalledTimes(1);
    }finally{control.close()}
  });
});
