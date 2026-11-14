import {describe,expect,it} from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import {spawn,type ChildProcess} from "node:child_process";

const rootProject=path.resolve(import.meta.dirname,"..");
const TUNNEL_ID="b2e8c6d9-9317-4d9e-b381-826af22e1778";
const PUBLIC="https://mcp.rcity.web.id/mcp";
async function freePort():Promise<number>{
  const socket=net.createServer();
  return new Promise((resolve,reject)=>{
    socket.once("error",reject);
    socket.listen(0,"127.0.0.1",()=>{
      const port=(socket.address() as net.AddressInfo).port;
      socket.close(()=>resolve(port));
    });
  });
}
async function waitFor<T>(read:()=>Promise<T|null>,ms=15000):Promise<T>{
  const limit=Date.now()+ms;
  while(Date.now()<limit){
    const value=await read().catch(()=>null);
    if(value!==null)return value;
    await new Promise(resolve=>setTimeout(resolve,160));
  }
  throw Error("Timed out waiting for isolated Named Tunnel test component");
}
function fileJson(file:string):any|null{
  if(!fs.existsSync(file))return null;
  return JSON.parse(fs.readFileSync(file,"utf8"));
}
async function request(port:number,route:string,nonce:string,method="GET"):Promise<Response>{
  return fetch("http://127.0.0.1:"+port+route,{
    method,headers:{Authorization:"Bearer "+nonce,Host:"127.0.0.1:"+port},
    signal:AbortSignal.timeout(4000),
  });
}
async function stopEphemeralOwner(root:string,ownerPort:number):Promise<boolean>{
  const lease=fileJson(path.join(root,"mcp-owner-"+ownerPort+".json"));
  if(!lease||!lease.nonce||!lease.pid)return true;
  const current=await request(ownerPort,"/_internal/owner/status",lease.nonce).catch(()=>null);
  if(!current?.ok)return false;
  const details=await current.json();
  if(details.pid!==lease.pid||details.port!==ownerPort)return false;
  const drain=await request(ownerPort,"/_internal/owner/drain",lease.nonce,"POST").catch(()=>null);
  if(!drain?.ok)return false;
  const stop=await request(ownerPort,"/_internal/owner/stop",lease.nonce,"POST").catch(()=>null);
  if(!stop?.ok)return false;
  await waitFor(async()=>fs.existsSync(path.join(root,"mcp-owner-"+ownerPort+".json"))?null:true,7500)
    .catch(()=>null);
  return !fs.existsSync(path.join(root,"mcp-owner-"+ownerPort+".json"));
}
describe.skipIf(process.platform!=="win32")("Named private owner bootstrap (disposable Windows OAuth profile)",()=>{
  it("starts an OAuth owner behind the verified Named Anchor and leaves legacy Gemini alone",async()=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),"mcp-named-owner-e2e-"));
    const fakeHome=path.join(root,"fake-user-home");
    fs.mkdirSync(fakeHome,{recursive:true});
    let anchor:ChildProcess|null=null;
    let runner:ChildProcess|null=null;
    let ownerClean=true;
    const anchorPort=await freePort();
    let ownerPort=await freePort();
    while(ownerPort===anchorPort)ownerPort=await freePort();
    const privateDir=path.join(root,"private","cloudflare-named");
    const token=path.join(privateDir,TUNNEL_ID+".token");
    const binary=path.join(root,"cloudflared.exe");
    fs.mkdirSync(privateDir,{recursive:true,mode:0o700});
    fs.writeFileSync(token,Buffer.from(JSON.stringify({
      a:"test-cloudflare-account",t:TUNNEL_ID,s:"TEST-ISOLATED-SECRET-NOT-REAL",
    })).toString("base64url"),{mode:0o600});
    fs.writeFileSync(binary,"Synthetic fixture. Executable never started.",{mode:0o600});
    fs.writeFileSync(path.join(root,"mcp-named-tunnel-settings.json"),JSON.stringify({
      version:1,connectorMode:"remote-managed",tunnelId:TUNNEL_ID,
      hostname:"mcp.rcity.web.id",anchorPort,ownerPort,
      tokenFilePath:token,credentialsFilePath:"",cloudflaredPath:binary,
    }));
    const env={...process.env,
      SUPERAGENT_CONFIG_DIR:root,
      HOME:fakeHome,USERPROFILE:fakeHome,
    };
    const start=(script:string,args:string[])=>{
      const child=spawn(process.execPath,[script,...args],{
        cwd:rootProject,env,stdio:["ignore","pipe","pipe"],windowsHide:true,
      });
      return child;
    };
    let anchorError="",ownerError="",ownerOut="";
    try{
      anchor=start("dist/scripts/mcp-tunnel-anchor.js",["start-profile",String(anchorPort),"--reviewed"]);
      anchor.stderr?.on("data",d=>{anchorError+=String(d).slice(0,300);});
      const anchorLeaseFile=path.join(root,"mcp-tunnel-anchor-"+anchorPort+".json");
      const anchorLease=await waitFor(async()=>{
        const lease=fileJson(anchorLeaseFile);
        if(!lease)return null;
        const reply=await request(anchorPort,"/_internal/anchor/status",lease.nonce);
        if(!reply.ok)return null;
        const s=await reply.json();
        return s.publicUrl===PUBLIC&&s.ready===false?lease:null;
      },16000);
      expect(anchorLease.pid).toBe(anchor.pid);
      runner=start("dist/scripts/mcp-named-owner.js",["start-profile","--reviewed"]);
      runner.stderr?.on("data",d=>{ownerError+=String(d).slice(0,300);});
      runner.stdout?.on("data",d=>{ownerOut+=String(d).slice(0,900);});
      const result=await new Promise<number|null>((resolve,reject)=>{
        const timeout=setTimeout(()=>reject(Error("Isolated owner startup timed out")),90000);
        runner!.once("exit",code=>{clearTimeout(timeout);resolve(code);});
        runner!.once("error",error=>{clearTimeout(timeout);reject(error);});
      });
      expect(result,ownerError).toBe(0);
      const data=JSON.parse(ownerOut.trim());
      expect(data).toMatchObject({
        status:"verified_named_owner_attached",
        ownerPort,anchorPort,publicUrl:PUBLIC,
        oauthStatePersistent:true,safeToolsOnly:true,
        noQuickTunnelMutation:true,clientCutoverApproved:false,
      });
      const lease=fileJson(path.join(root,"mcp-owner-"+ownerPort+".json"));
      expect(lease?.pid).toBe(data.ownerPid);
      const ownerStatus=await request(ownerPort,"/_internal/owner/status",lease.nonce);
      expect(ownerStatus.status).toBe(200);
      expect(await ownerStatus.json()).toMatchObject({
        oauthEnabled:true,oauthStatePersistent:true,
        ingressMode:"external-anchor",safeToolsOnly:true,publicUrl:PUBLIC,
      });
      const attached=await request(anchorPort,"/_internal/anchor/status",anchorLease.nonce);
      expect((await attached.json()).currentOwnerPid).toBe(lease.pid);
      expect(anchorError).not.toMatch(/Quick Tunnel|secret|token/i);
      expect(ownerOut).not.toContain("TEST-ISOLATED-SECRET-NOT-REAL");
      const detachUrl="http://127.0.0.1:"+anchorPort+"/_internal/anchor/detach";
      const detachPayload={reviewed:true,expectedAnchorPid:anchorLease.pid,
        expectedPort:anchorPort,expectedPublicUrl:PUBLIC,
        expectedOwnerPid:lease.pid,expectedOwnerPort:ownerPort};
      const unreviewed=await fetch(detachUrl,{method:"POST",
        headers:{Authorization:"Bearer "+anchorLease.nonce,
          "Content-Type":"application/json"},body:JSON.stringify({
            ...detachPayload,reviewed:false,
          })});
      expect(unreviewed.status).toBe(409);
      const drain=await request(ownerPort,"/_internal/owner/drain",lease.nonce,"POST");
      expect(drain.status).toBe(200);
      const detach=await fetch(detachUrl,{method:"POST",headers:{
        Authorization:"Bearer "+anchorLease.nonce,"Content-Type":"application/json",
      },body:JSON.stringify(detachPayload)});
      expect(detach.status).toBe(200);
      expect(await detach.json()).toMatchObject({
        detached:true,ownerPid:lease.pid,anchorPid:anchorLease.pid,
        noQuickTunnelMutation:true,noRequestReplay:true,
      });
      const afterDetach=await request(anchorPort,"/_internal/anchor/status",anchorLease.nonce);
      expect(await afterDetach.json()).toMatchObject({
        ready:false,currentOwnerPid:null,currentOwnerPort:null,
        inFlightRequests:0,tunnelMode:"named-external",
      });
      ownerClean=await stopEphemeralOwner(root,ownerPort);
      expect(ownerClean).toBe(true);
      const shutdown=await fetch(
        "http://127.0.0.1:"+anchorPort+"/_internal/anchor/shutdown",{
          method:"POST",headers:{
            Authorization:"Bearer "+anchorLease.nonce,
            "Content-Type":"application/json",
          },body:JSON.stringify({reviewed:true,expectedAnchorPid:anchorLease.pid,
            expectedPort:anchorPort,expectedPublicUrl:PUBLIC,
            expectedCurrentOwnerPid:null}),
        });
      expect(shutdown.status).toBe(200);
      expect(await shutdown.json()).toMatchObject({
        accepted:true,anchorPid:anchorLease.pid,noQuickTunnelMutation:true,
      });
      await waitFor(async()=>anchor?.exitCode===0?true:null,6000);
      expect(fs.existsSync(anchorLeaseFile)).toBe(false);
    }finally{
      ownerClean=await stopEphemeralOwner(root,ownerPort).catch(()=>false);
      if(runner && runner.exitCode===null)runner.kill();
      if(anchor&&anchor.exitCode===null){
        // Exact spawned private test Child object, never an arbitrary PID.
        anchor.kill();
        await Promise.race([
          new Promise(resolve=>anchor?.once("exit",resolve)),
          new Promise(resolve=>setTimeout(resolve,3000)),
        ]);
      }
      if(ownerClean)fs.rmSync(root,{recursive:true,force:true});
    }
    expect(ownerClean,"Owner did not acknowledge authenticated drain/stop; isolated evidence preserved").toBe(true);
  },115000);
});
