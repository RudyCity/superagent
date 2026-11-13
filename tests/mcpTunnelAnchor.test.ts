import {afterEach,describe,expect,it,vi} from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StreamableHTTPClientTransport} from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const tunnel=vi.hoisted(()=>({
  startQuickTunnel:vi.fn(async()=>({publicUrl:"https://stable-anchor.trycloudflare.com",pid:45111})),
  stopQuickTunnel:vi.fn(async()=>true),
  getTunnelStatus:vi.fn(()=>({isRunning:false})),
}));
vi.mock("../src/core/remoteAgent/cloudflareTunnel.js",async importOriginal=>{
  const orig=await importOriginal<typeof import("../src/core/remoteAgent/cloudflareTunnel.js")>();
  return {...orig,...tunnel};
});
import {startMcpTunnelAnchor} from "../src/core/runtime/mcpTunnelAnchor.js";
import {startReloadableMcpTunnelOwner} from "../src/core/runtime/mcpReloadableOwner.js";
import {getMcpStateFile} from "../src/core/mcp/mcpTunnel.js";
import {mcpOwnerLogPath} from "../src/core/runtime/mcpOwnerLog.js";

async function freePort():Promise<number>{
  const socket=net.createServer();
  return new Promise((resolve,reject)=>{
    socket.once("error",reject);
    socket.listen(0,"127.0.0.1",()=>{
      const p=(socket.address() as net.AddressInfo).port;
      socket.close(()=>resolve(p));
    });
  });
}
const nonce=()=>crypto.randomBytes(32).toString("hex");
describe("Independent tunnel anchor / owner handoff (isolated mock tunnel)",()=>{
  afterEach(()=>vi.clearAllMocks());
  it("preserves anchor URL across an explicit drained-owner switch and rejects unsafe control",async()=>{
    const config=fs.mkdtempSync(path.join(os.tmpdir(),"mcp-anchor-isolated-"));
    const previous=process.env.SUPERAGENT_CONFIG_DIR;
    process.env.SUPERAGENT_CONFIG_DIR=config;
    const port=await freePort();
    const oldPort=await freePort();
    const newPort=await freePort();
    const anchorNonce=nonce();
    const oldNonce=nonce();
    const newNonce=nonce();
    const startedAt=Date.now();
    const anchor=await startMcpTunnelAnchor({port,nonce:anchorNonce,createdAt:startedAt});
    let old:Awaited<ReturnType<typeof startReloadableMcpTunnelOwner>>|null=null;
    let newer:Awaited<ReturnType<typeof startReloadableMcpTunnelOwner>>|null=null;
    let oldClient:Client|null=null;
    let newClient:Client|null=null;
    const host="http://127.0.0.1:"+port;
    const control=async(route:string,body?:unknown,token=anchorNonce,hostHeader?:string)=>{
      const response=await fetch(host+"/_internal/anchor/"+route,{
        method:body===undefined?"GET":"POST",
        headers:{Authorization:"Bearer "+token,"Content-Type":"application/json",
          ...(hostHeader?{Host:hostHeader}:{})},
        ...(body!==undefined?{body:JSON.stringify(body)}:{}),
      });
      return {status:response.status,body:await response.json().catch(()=>null)};
    };
    const transports:StreamableHTTPClientTransport[]=[];
    const connect=async(bearer:string)=>{
      const client=new Client({name:"anchor-proof",version:"1.0.0"},{capabilities:{}});
      const transport=new StreamableHTTPClientTransport(new URL(host+"/mcp"),{
        requestInit:{headers:{Authorization:"Bearer "+bearer}},
      });
      await client.connect(transport);
      transports.push(transport);
      return client;
    };
    try{
      expect(anchor.publicUrl).toBe("https://stable-anchor.trycloudflare.com/mcp");
      expect((await control("status",undefined,"wrong")).status).toBe(401);
      expect((await control("status",undefined,anchorNonce,"stable-anchor.trycloudflare.com")).status).toBe(404);
      expect((await fetch(host+"/_internal/owner/status")).status).toBe(404);
      expect((await fetch(host+"/mcp")).status).toBe(503);
      old=await startReloadableMcpTunnelOwner({
        port:oldPort,nonce:oldNonce,createdAt:Date.now(),cliEntry:path.resolve("dist/cli.js"),
        authMode:"static-bearer",allowDangerous:false,
        externalPublicBaseUrl:"https://stable-anchor.trycloudflare.com",
      });
      const oldTarget={port:oldPort,pid:process.pid,nonce:oldNonce,startedAt:(await controlOwner(oldPort,oldNonce)).startedAt};
      const planInput=(target:typeof oldTarget,expectedPreviousPid:number|null)=>({
        target,expectedAnchorPid:process.pid,
        expectedPublicUrl:anchor.publicUrl,expectedPreviousPid,
      });
      const first=await control("plan",planInput(oldTarget,null));
      expect(first.status).toBe(200);
      expect(first.body.requiresDrain).toBe(false);
      expect((await control("activate",{planId:first.body.planId,reviewed:false,
        expectedAnchorPid:process.pid,expectedPublicUrl:anchor.publicUrl,
        expectedPreviousPid:null,expectedNextOwnerPid:oldTarget.pid,
        expectedNextOwnerPort:oldTarget.port})).status).toBe(409);
      const attach=await control("activate",{planId:first.body.planId,reviewed:true,
        expectedAnchorPid:process.pid,expectedPublicUrl:anchor.publicUrl,
        expectedPreviousPid:null,expectedNextOwnerPid:oldTarget.pid,
        expectedNextOwnerPort:oldTarget.port});
      expect(attach.status).toBe(200);
      expect(attach.body.noTunnelRestart).toBe(true);
      // A successful static-bearer check confirms that the first owner is
      // already serving from the anchor without creating an MCP session.
      expect((await fetch(host+"/mcp",{headers:{Authorization:"Bearer "+old.info.bearerToken}})).status)
        .not.toBe(503);
      const status1=await control("status");
      expect(status1.body.currentOwnerPort).toBe(oldPort);
      newer=await startReloadableMcpTunnelOwner({
        port:newPort,nonce:newNonce,createdAt:Date.now(),cliEntry:path.resolve("dist/cli.js"),
        authMode:"static-bearer",allowDangerous:false,
        externalPublicBaseUrl:"https://stable-anchor.trycloudflare.com",
      });
      const nextTarget={port:newPort,pid:process.pid,nonce:newNonce,
        startedAt:(await controlOwner(newPort,newNonce)).startedAt};
      const nextPlan=await control("plan",planInput(nextTarget,process.pid));
      expect(nextPlan.status).toBe(200);
      expect(nextPlan.body.requiresDrain).toBe(true);
      const handoffInput={planId:nextPlan.body.planId,reviewed:true,
        expectedAnchorPid:process.pid,expectedPublicUrl:anchor.publicUrl,
        expectedPreviousPid:process.pid,
        expectedNextOwnerPid:nextTarget.pid,expectedNextOwnerPort:nextTarget.port};
      const premature=await control("activate",handoffInput);
      expect(premature.status).toBe(409);
      expect(premature.body.error).toBe("MCP_ANCHOR_OLD_OWNER_NOT_DRAINED");
      const beforeDrain=await controlOwner(oldPort,oldNonce) as any;
      expect(beforeDrain.activeSessions).toBe(0);
      await fetch("http://127.0.0.1:"+oldPort+"/_internal/owner/drain",{
        method:"POST",headers:{Authorization:"Bearer "+oldNonce},
      });
      // A drained owner rejects new public calls; the anchor must preserve
      // its URL while switching only after active work has finished.
      let committed:{status:number;body:any}|null=null;
      for(let i=0;i<25;i++){
        committed=await control("activate",handoffInput);
        if(committed.status===200)break;
        await new Promise(resolve=>setTimeout(resolve,80));
      }
      expect(committed?.status,JSON.stringify(committed?.body)).toBe(200);
      expect(committed?.body?.publicUrl).toBe(anchor.publicUrl);
      expect((await control("status")).body.currentOwnerPort).toBe(newPort);
      await old.close();old=null;
      expect(tunnel.stopQuickTunnel).not.toHaveBeenCalled();
      newClient=await connect(newer.info.bearerToken);
      expect((await newClient.listTools()).tools.map(t=>t.name))
        .toContain("superagent_delegate_read_chat");
      expect(tunnel.startQuickTunnel).toHaveBeenCalledTimes(1);
      expect((await control("status")).body.pid).toBe(process.pid);
    }finally{
      await newClient?.close().catch(()=>undefined);
      await oldClient?.close().catch(()=>undefined);
      await old?.close().catch(()=>undefined);
      await newer?.close().catch(()=>undefined);
      await anchor.close();
      for(const p of [oldPort,newPort]){
        fs.rmSync(getMcpStateFile(p),{force:true});
        fs.rmSync(mcpOwnerLogPath(p),{force:true});
      }
      if(previous===undefined)delete process.env.SUPERAGENT_CONFIG_DIR;
      else process.env.SUPERAGENT_CONFIG_DIR=previous;
      fs.rmSync(config,{recursive:true,force:true});
    }
    expect(tunnel.stopQuickTunnel).toHaveBeenCalledTimes(1);
  },90_000);
});
async function controlOwner(port:number,nonce:string){
  const r=await fetch("http://127.0.0.1:"+port+"/_internal/owner/status",{
    headers:{Authorization:"Bearer "+nonce}});
  return await r.json() as {startedAt:number};
}
