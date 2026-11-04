/**
 * Real loopback OAuth MCP HTTP -> Core supervisor restart -> replay.
 * Owns only a fresh isolated profile and randomly selected staging ports.
 */
import {describe,it,expect,afterAll} from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {spawn,spawnSync,type ChildProcess} from "node:child_process";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StreamableHTTPClientTransport} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {McpOAuthStore,randomToken} from "../src/core/mcp/mcpOAuthStore.js";
import {startMcpHttpServer} from "../src/core/mcp/mcpHttpTransport.js";
import {setYoloMode,setFullYoloMode} from "../src/core/permissions.js";
import {requestCoreSupervisor} from "../src/core/runtime/coreSupervisor.js";

const previousDir=process.env.SUPERAGENT_CONFIG_DIR;
const temp=fs.mkdtempSync(path.join(os.tmpdir(),"core-oauth-http-stage-"));
let owner:ChildProcess|undefined,ownerPort=0;
const owned=new Set<number>();
const cleanupClients:Array<()=>Promise<void>>=[];
function killOwned(pid:number) {
  if(!Number.isSafeInteger(pid)||pid<=0||pid===process.pid)return;
  try {
    if(process.platform==="win32")spawnSync("taskkill",["/F","/PID",String(pid)],{timeout:4000,stdio:"ignore"});
    else process.kill(pid,"SIGTERM");
  } catch{}
}
async function freePort():Promise<number>{
  const server=net.createServer();
  return new Promise((resolve,reject)=>{
    server.once("error",reject);
    server.listen(0,"127.0.0.1",()=>{
      const address=server.address();
      if(!address||typeof address==="string")return reject(new Error("No staging port"));
      server.close(()=>resolve(address.port));
    });
  });
}
const base="https://core-oauth-staging.trycloudflare.com";
const redirect="https://chatgpt.example/oauth/callback";
function grant(store:McpOAuthStore,scope:string[]) {
  const id="core-stage-"+scope.join("-");
  const verifier=randomToken(32);
  const challenge=crypto.createHash("sha256").update(verifier).digest("base64url");
  store.registerClient(id,[redirect]);
  const req=store.createAuthorizationRequest({
    clientId:id,redirectUri:redirect,codeChallenge:challenge,codeChallengeMethod:"S256",
    resource:base+"/mcp",state:"stage",scope,
  });
  const approved=store.approveAuthorizationRequest(req.requestId,true);
  if(!approved.ok)throw new Error("Staging authorization failed");
  const response=store.exchangeCode({
    code:approved.code,clientId:id,redirectUri:redirect,
    codeVerifier:verifier,resource:base+"/mcp",
  });
  if(!response.ok)throw new Error("Staging PKCE exchange failed");
  return response.accessToken;
}
afterAll(async()=>{
  for(const close of cleanupClients.reverse())await close().catch(()=>{});
  killOwned(owner?.pid||0);
  for(const pid of owned)killOwned(pid);
  setFullYoloMode(false);
  setYoloMode(false);
  if(previousDir===undefined)delete process.env.SUPERAGENT_CONFIG_DIR;
  else process.env.SUPERAGENT_CONFIG_DIR=previousDir;
  fs.rmSync(temp,{recursive:true,force:true});
});
describe("OAuth HTTP authenticated live Core restart and idempotent replay",()=>{
  it("read/write OAuth scopes control an isolated Core without changing MCP ingress",async()=>{
    process.env.SUPERAGENT_CONFIG_DIR=temp;
    setYoloMode(true);
    ownerPort=await freePort();
    if(ownerPort===7888||ownerPort===8857)throw new Error("Protected production port");
    owner=spawn(process.execPath,[path.join(process.cwd(),"src","cli.tsx"),
      "core","start","--port",String(ownerPort)],{
      cwd:process.cwd(),stdio:"ignore",windowsHide:true,
      env:{...process.env,SUPERAGENT_CONFIG_DIR:temp,SUPERAGENT_CORE_STAGING:"1"},
    });
    owner.once("error",()=>{});
    let before:Awaited<ReturnType<typeof requestCoreSupervisor>>|undefined;
    for(let i=0;i<100;i++){
      try {
        const s=await requestCoreSupervisor("status",ownerPort,700);
        if(s.supervisorPid===owner.pid){before=s;break;}
      }catch{}
      await new Promise(resolve=>setTimeout(resolve,150));
    }
    if(!before)throw new Error("Isolated Core supervisor did not register");
    owned.add(before.active.pid);
    const store=new McpOAuthStore();
    const handle=await startMcpHttpServer({
      port:0,authMode:"oauth",allowDangerous:true,toolExposure:"gateway",oauthStore:store,
      oauth:{publicBaseUrl:base,bootstrapCodeHash:"a".repeat(64)},
      auditLogPath:path.join(temp,"mcp-oauth-audit.log"),
    });
    cleanupClients.push(()=>handle.close());
    async function connect(token:string){
      const client=new Client({name:"core-e2e",version:"1.0"},{capabilities:{}});
      await client.connect(new StreamableHTTPClientTransport(new URL(handle.url),{
        requestInit:{headers:{Authorization:"Bearer "+token}},
      }));
      cleanupClients.push(()=>client.close());
      return client;
    }
    const read=await connect(grant(store,["mcp:tools"]));
    const readNames=(await read.listTools()).tools.map(t=>t.name);
    expect(readNames).toContain("superagent_core_plan");
    expect(readNames).not.toContain("superagent_core_restart");
    await expect(read.callTool({name:"superagent_core_restart",arguments:{confirm:true}}))
      .rejects.toThrow();
    const writer=await connect(grant(store,["mcp:tools","mcp:tools:write"]));
    expect((await writer.listTools()).tools.map(t=>t.name)).toContain("superagent_core_restart");
    const prepared=await writer.callTool({name:"superagent_core_plan",
      arguments:{port:ownerPort,action:"restart"}});
    expect(prepared.isError).not.toBe(true);
    const plan=JSON.parse((prepared.content as any[])[0].text);
    expect(plan.supervisorPid).toBe(owner.pid);
    const args={port:ownerPort,operationId:plan.operationId,
      expectedBuildDigest:plan.expectedBuildDigest,confirm:true};
    const restarted=await writer.callTool({name:"superagent_core_restart",arguments:args});
    expect(restarted.isError).not.toBe(true);
    const output=JSON.parse((restarted.content as any[])[0].text);
    expect(output.activeWorkerPid).not.toBe(before.active.pid);
    expect(output.supervisorPid).toBe(owner.pid);
    expect(output.status.active.buildDigest).toBe(plan.expectedBuildDigest);
    owned.add(output.activeWorkerPid);
    const repeated=await writer.callTool({name:"superagent_core_restart",arguments:args});
    expect(repeated.isError).not.toBe(true);
    const retry=JSON.parse((repeated.content as any[])[0].text);
    expect(retry.replayed).toBe(true);
    expect(retry.activeWorkerPid).toBe(output.activeWorkerPid);
    expect((await requestCoreSupervisor("status",ownerPort)).active.pid).toBe(output.activeWorkerPid);

    // The unified MCP endpoint uses the same authenticated control and must
    // not mutate the local OAuth HTTP ingress while rolling a worker back.
    expect((await writer.listTools()).tools.map(t=>t.name))
      .toContain("superagent_manage_services");
    const inventory=await writer.callTool({name:"superagent_manage_services",
      arguments:{action:"status",service:"core",port:ownerPort}});
    expect(inventory.isError).not.toBe(true);
    const inv=JSON.parse((inventory.content as any[])[0].text);
    expect(inv.services[0].ownershipVerified).toBe(true);
    const unifiedPlan=await writer.callTool({name:"superagent_manage_services",
      arguments:{action:"plan",service:"core",targetAction:"rollback",port:ownerPort}});
    expect(unifiedPlan.isError).not.toBe(true);
    const rollbackPlan=JSON.parse((unifiedPlan.content as any[])[0].text);
    const rollbackArgs={action:"rollback",service:"core",port:ownerPort,confirm:true,
      operationId:rollbackPlan.operationId,expectedBuildDigest:rollbackPlan.expectedBuildDigest};
    const rolled=await writer.callTool({name:"superagent_manage_services",arguments:rollbackArgs});
    expect(rolled.isError).not.toBe(true);
    const receipt=JSON.parse((rolled.content as any[])[0].text);
    expect(receipt.verified).toBe(true);
    expect(receipt.activeWorkerPid).toBe(before.active.pid);
    const reissued=await writer.callTool({name:"superagent_manage_services",arguments:rollbackArgs});
    expect(reissued.isError).not.toBe(true);
    expect(JSON.parse((reissued.content as any[])[0].text).replayed).toBe(true);
    expect((await requestCoreSupervisor("status",ownerPort)).active.pid).toBe(before.active.pid);
  },90000);
});
