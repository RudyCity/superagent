import {afterEach,describe,expect,it,vi} from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";

const tunnel=vi.hoisted(()=>({
  startQuickTunnel:vi.fn(async()=>({publicUrl:"https://isolated-anchor.trycloudflare.com",pid:45112})),
  stopQuickTunnel:vi.fn(async()=>true),
  getTunnelStatus:vi.fn(()=>({isRunning:false})),
}));
vi.mock("../src/core/remoteAgent/cloudflareTunnel.js",async importOriginal=>{
  const orig=await importOriginal<typeof import("../src/core/remoteAgent/cloudflareTunnel.js")>();
  return {...orig,...tunnel};
});
import {startMcpTunnelAnchor} from "../src/core/runtime/mcpTunnelAnchor.js";
import {writeMcpTunnelAnchorLease,cleanMcpTunnelAnchorLease,probeMcpTunnelAnchor,
  type McpTunnelAnchorLease} from "../src/core/runtime/mcpTunnelAnchorLease.js";
import {startManagedMcpTunnelOwner,stopManagedMcpTunnelOwner,readManagedMcpTunnelLease}
  from "../src/core/runtime/mcpManagedTunnelOwner.js";

async function freePort():Promise<number>{
  const s=net.createServer();
  return new Promise((resolve,reject)=>{
    s.once("error",reject);
    s.listen(0,"127.0.0.1",()=>{
      const p=(s.address() as net.AddressInfo).port;
      s.close(()=>resolve(p));
    });
  });
}
describe.skipIf(process.platform!=="win32")("Anchor and OS-managed independent owner (disposable profile)",()=>{
  afterEach(()=>vi.clearAllMocks());
  it("starts a private child owner behind an authenticated anchor without creating another Quick Tunnel",async()=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),"managed-anchor-profile-"));
    const previous=process.env.SUPERAGENT_CONFIG_DIR;
    process.env.SUPERAGENT_CONFIG_DIR=root;
    const port=await freePort(),ownerPort=await freePort();
    const nonce=crypto.randomBytes(32).toString("hex");
    const createdAt=Date.now();
    const anchor=await startMcpTunnelAnchor({port,nonce,createdAt});
    const status=await fetch("http://127.0.0.1:"+port+"/_internal/anchor/status",{
      headers:{Authorization:"Bearer "+nonce}});
    const details=await status.json();
    const lease:McpTunnelAnchorLease={version:1,kind:"mcp_tunnel_anchor",
      pid:process.pid,port,nonce,createdAt,publicUrl:anchor.publicUrl,
      tunnelPid:details.tunnelPid};
    let managedPid:number|null=null;
    try{
      writeMcpTunnelAnchorLease(lease);
      const proof=await probeMcpTunnelAnchor(lease);
      expect(proof.ready).toBe(false);
      expect(proof.publicUrl).toBe(anchor.publicUrl);
      const started=await startManagedMcpTunnelOwner([
        "--port",String(ownerPort),"--anchor-port",String(port),
        "--provider","cloudflare","--mcp-auth","static-bearer",
      ],path.resolve("dist/cli.js"));
      managedPid=started.pid;
      expect(started.info.publicUrl).toBe(anchor.publicUrl);
      const owner=readManagedMcpTunnelLease(ownerPort);
      expect(owner?.pid).toBe(managedPid);
      expect(owner?.port).toBe(ownerPort);
      const privateStatus=await fetch("http://127.0.0.1:"+ownerPort+"/_internal/owner/status",{
        headers:{Authorization:"Bearer "+owner!.nonce}});
      expect(privateStatus.status).toBe(200);
      const body=await privateStatus.json();
      expect(body.ingressMode).toBe("external-anchor");
      expect(body.backendHealthy).toBe(true);
      const planned=await fetch("http://127.0.0.1:"+port+"/_internal/anchor/plan",{
        method:"POST",headers:{Authorization:"Bearer "+nonce,"Content-Type":"application/json"},
        body:JSON.stringify({target:{port:ownerPort,pid:managedPid,
          nonce:owner!.nonce,startedAt:owner!.createdAt},
          expectedAnchorPid:process.pid,expectedPublicUrl:anchor.publicUrl,
          expectedPreviousPid:null}),
      });
      expect(planned.status).toBe(200);
      const result=await planned.json();
      const activated=await fetch("http://127.0.0.1:"+port+"/_internal/anchor/activate",{
        method:"POST",headers:{Authorization:"Bearer "+nonce,"Content-Type":"application/json"},
        body:JSON.stringify({planId:result.planId,reviewed:true,
          expectedAnchorPid:process.pid,expectedPublicUrl:anchor.publicUrl,
          expectedPreviousPid:null,
          expectedNextOwnerPid:owner!.pid,expectedNextOwnerPort:owner!.port}),
      });
      expect(activated.status).toBe(200);
      expect((await probeMcpTunnelAnchor(lease)).currentOwnerPid).toBe(managedPid);
      expect(tunnel.startQuickTunnel).toHaveBeenCalledTimes(1);
      expect(tunnel.stopQuickTunnel).not.toHaveBeenCalled();
      // A second owner must not initialize an OAuth writer for an issuer
      // still served by the first, non-drained owner.
      const blockedPort=await freePort();
      await expect(startManagedMcpTunnelOwner([
        "--port",String(blockedPort),"--anchor-port",String(port),
        "--provider","cloudflare","--mcp-auth","oauth",
      ],path.resolve("dist/cli.js")))
        .rejects.toThrow("MCP_EXTERNAL_ANCHOR_OLD_OWNER_NOT_QUIESCENT");
      expect(readManagedMcpTunnelLease(blockedPort)).toBeNull();
      let stopped;
      try{stopped=await stopManagedMcpTunnelOwner(ownerPort);}
      catch(error){
        const leaseAfter=readManagedMcpTunnelLease(ownerPort);
        const osListeners=(await import("../src/core/runtime/coreMcpOwnershipAudit.js")).readListenerOwners();
        console.log("MCP_ANCHOR_STOP_DIAGNOSTIC",JSON.stringify({
          ownerPort,managedPid,leaseExists:!!leaseAfter,
          processAlive:(()=>{try{process.kill(managedPid!,0);return true;}catch{return false;}})(),
          listenerPid:osListeners?.get(ownerPort)??null,
          error:String(error),
        }));
        throw error;
      }
      expect(stopped.stopped).toBe(true);
      managedPid=null;
      expect(tunnel.stopQuickTunnel).not.toHaveBeenCalled();
      expect((await probeMcpTunnelAnchor(lease)).publicUrl).toBe(anchor.publicUrl);
    }finally{
      if(managedPid){
        try{await stopManagedMcpTunnelOwner(ownerPort);}catch{}
      }
      const stillOwned=readManagedMcpTunnelLease(ownerPort);
      cleanMcpTunnelAnchorLease(lease);
      await anchor.close();
      if(previous===undefined)delete process.env.SUPERAGENT_CONFIG_DIR;
      else process.env.SUPERAGENT_CONFIG_DIR=previous;
      // Preserve evidence when a child still owns the staging listener.
      if(!stillOwned)fs.rmSync(root,{recursive:true,force:true});
    }
    expect(tunnel.stopQuickTunnel).toHaveBeenCalledTimes(1);
  },85_000);
});
