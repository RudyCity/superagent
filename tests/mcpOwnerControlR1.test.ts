import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { startMcpHttpServer, generateMcpBearerToken } from "../src/core/mcp/mcpHttpTransport.js";
import { probePrivateMcpOwner } from "../src/core/runtime/mcpOwnerControl.js";
import type { ManagedMcpLease } from "../src/core/runtime/mcpOwnerStagingLease.js";

async function availablePort() {
  const server = net.createServer();
  return new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address !== "string" ? address.port : 0;
      server.close(() => port ? resolve(port) : reject(Error("no port")));
    });
  });
}
function lease(port:number,nonce:string,startedAt:number):ManagedMcpLease {
  return {version:1,kind:"managed_mcp_staging",pid:process.pid,port,
    nonce,createdAt:startedAt,auth:"private_bearer",
    modelAutostart:false,publicTunnel:false};
}
const initialize = {jsonrpc:"2.0",id:1,method:"initialize",
  params:{protocolVersion:"2024-11-05",capabilities:{},
    clientInfo:{name:"r1-private-owner-test",version:"1.0"}}};
const headers=(token:string,sid?:string):Record<string,string>=>({
  Authorization:"Bearer "+token,
  Accept:"application/json, text/event-stream",
  "Content-Type":"application/json",
  ...(sid?{"mcp-session-id":sid}:{})
});
describe("R1 private authenticated MCP owner health and drain",()=>{
  it("does not expose an owner-control route without explicit opt-in",async()=>{
    const server=await startMcpHttpServer({
      port:0,bearerToken:generateMcpBearerToken(),allowDangerous:false,
      auditLogPath:path.join(os.tmpdir(),"mcp-r1-negative-"+crypto.randomUUID()+".jsonl"),
    });
    try{
      const result=await fetch("http://127.0.0.1:"+server.port+"/_internal/owner/status");
      expect(result.status).toBe(404);
    }finally{await server.close();}
  });
  it("rejects the MCP bearer itself or incorrect token as owner authority",async()=>{
    const port=await availablePort();
    const clientToken=generateMcpBearerToken(),controlToken=generateMcpBearerToken();
    const startedAt=Date.now();
    const server=await startMcpHttpServer({port,bearerToken:clientToken,
      allowDangerous:false,ownerControlToken:controlToken,ownerStartedAt:startedAt,
      auditLogPath:path.join(os.tmpdir(),"mcp-r1-owner-"+crypto.randomUUID()+".jsonl"),
    });
    try{
      const url="http://127.0.0.1:"+port+"/_internal/owner/status";
      for(const token of [clientToken,generateMcpBearerToken()]){
        const response=await fetch(url,{headers:{Authorization:"Bearer "+token}});
        expect(response.status).toBe(401);
        expect(await response.text()).not.toContain("activeSessions");
      }
      const wrongMethod=await fetch(url,{method:"POST",
        headers:{Authorization:"Bearer "+controlToken}});
      expect(wrongMethod.status).toBe(405);
      expect(await probePrivateMcpOwner(lease(port,clientToken,startedAt))).toBeNull();
      expect(await probePrivateMcpOwner(lease(port,controlToken,startedAt+1))).toBeNull();
      const status=await probePrivateMcpOwner(lease(port,controlToken,startedAt));
      expect(status).toMatchObject({kind:"private_mcp_owner",pid:process.pid,
        activeSessions:0,inFlightRequests:0,draining:false,
        inflightToolEffects:"unknown",oauthEnabled:false});
      expect(JSON.stringify(status)).not.toContain(clientToken);
      expect(JSON.stringify(status)).not.toContain(controlToken);
    }finally{await server.close();}
  });
  it("drains existing sessions without reinitializing or replaying any request",async()=>{
    const port=await availablePort(),mcp=generateMcpBearerToken();
    const token=generateMcpBearerToken(),startedAt=Date.now();
    const server=await startMcpHttpServer({port,bearerToken:mcp,
      allowDangerous:false,ownerControlToken:token,ownerStartedAt:startedAt,
      auditLogPath:path.join(os.tmpdir(),"mcp-r1-drain-"+crypto.randomUUID()+".jsonl"),
    });
    const profile=lease(port,token,startedAt);
    try{
      const url="http://127.0.0.1:"+port+"/mcp";
      const init=await fetch(url,{method:"POST",headers:headers(mcp),
        body:JSON.stringify(initialize)});
      expect(init.status).toBe(200);
      const id=init.headers.get("mcp-session-id");
      expect(id).toBeTruthy();
      await init.text();
      expect((await probePrivateMcpOwner(profile))?.activeSessions).toBe(1);
      const before=await fetch("http://127.0.0.1:"+port+"/_internal/owner/drain",{
        method:"POST",headers:{Authorization:"Bearer "+mcp},
      });
      expect(before.status).toBe(401);
      expect((await probePrivateMcpOwner(profile))?.draining).toBe(false);
      const drained=await probePrivateMcpOwner(profile,"drain");
      expect(drained?.draining).toBe(true);
      expect(drained?.activeSessions).toBe(1);
      const forbidden=await fetch(url,{method:"POST",headers:headers(mcp),
        body:JSON.stringify(initialize)});
      expect(forbidden.status).toBe(503);
      const result=await forbidden.json() as {error:string};
      expect(result.error).toMatch(/draining/);
      const old=await fetch(url,{method:"DELETE",headers:headers(mcp,id!)});
      expect(old.status).toBe(200);
      expect((await probePrivateMcpOwner(profile))?.activeSessions).toBe(0);
      expect((await probePrivateMcpOwner(profile))?.inFlightRequests).toBe(0);
    }finally{await server.close();}
  });
  it("never enables staging owner control on dangerous or OAuth server modes",async()=>{
    const token=generateMcpBearerToken(),control=generateMcpBearerToken();
    await expect(startMcpHttpServer({port:0,bearerToken:token,
      allowDangerous:true,ownerControlToken:control,ownerStartedAt:Date.now()}))
      .rejects.toThrow(/isolated/);
    await expect(startMcpHttpServer({port:0,
      authMode:"oauth",allowDangerous:false,
      oauth:{publicBaseUrl:"https://issuer.example",bootstrapCodeHash:"a".repeat(64)},
      ownerControlToken:control,ownerStartedAt:Date.now()}))
      .rejects.toThrow(/isolated/);
  });
  it("allows explicit managed-tunnel owner control for OAuth and graceful stop",async()=>{
    const port=await availablePort(),control=generateMcpBearerToken(),startedAt=Date.now();
    let stopped=false;
    const server=await startMcpHttpServer({
      port,authMode:"oauth",allowDangerous:true,
      oauth:{publicBaseUrl:"https://issuer.example",bootstrapCodeHash:"b".repeat(64)},
      ownerControlToken:control,ownerStartedAt:startedAt,
      ownerControlMode:"managed-tunnel",ownerPublicTunnelStarted:true,
      ownerStopHandler:()=>{stopped=true;},
      auditLogPath:path.join(os.tmpdir(),"mcp-managed-owner-"+crypto.randomUUID()+".jsonl"),
    });
    try{
      const base="http://127.0.0.1:"+port+"/_internal/owner/";
      const headers={Authorization:"Bearer "+control,Host:"127.0.0.1:"+port};
      const status=await fetch(base+"status",{headers});
      expect(status.status).toBe(200);
      expect(await status.json()).toMatchObject({
        kind:"private_mcp_owner",pid:process.pid,port,startedAt,
        mode:"managed-tunnel",oauthEnabled:true,publicTunnelStarted:true,
        safeToolsOnly:false,draining:false,
      });
      const publicHost = await new Promise<{ status: number }>((resolve) => {
        const req = http.get({
          hostname: "127.0.0.1", port, path: "/_internal/owner/status",
          headers: { Authorization: "Bearer " + control, Host: "issuer.example" },
        }, (res) => resolve({ status: res.statusCode || 0 }));
        req.end();
      });
      expect(publicHost.status).toBe(404);
      const earlyStop=await fetch(base+"stop",{method:"POST",headers});
      expect(earlyStop.status).toBe(409);
      const drain=await fetch(base+"drain",{method:"POST",headers});
      expect(drain.status).toBe(200);
      const stop=await fetch(base+"stop",{method:"POST",headers});
      expect(stop.status).toBe(200);
      await new Promise(resolve=>setImmediate(resolve));
      expect(stopped).toBe(true);
    }finally{await server.close();}
  });
  it("serves stateless tool discovery for a dangerous managed-tunnel owner",async()=>{
    // Regression: owner-controlled listeners forced the safe-only lock onto the
    // stateless MCP path, which throws when --allow-dangerous is set. Every
    // non-initialize POST without an mcp-session-id then returned 500, so
    // clients reported "authentication succeeded, action discovery failed".
    const port=await availablePort(),control=generateMcpBearerToken(),startedAt=Date.now();
    const server=await startMcpHttpServer({
      port,authMode:"oauth",allowDangerous:true,toolExposure:"gateway",
      oauth:{publicBaseUrl:"https://issuer.example",bootstrapCodeHash:"c".repeat(64)},
      ownerControlToken:control,ownerStartedAt:startedAt,
      ownerControlMode:"managed-tunnel",ownerPublicTunnelStarted:true,
      ownerStopHandler:()=>{},
      auditLogPath:path.join(os.tmpdir(),"mcp-r1-stateless-"+crypto.randomUUID()+".jsonl"),
    });
    try{
      const store=server.oauthStore;
      expect(store).toBeTruthy();
      if(!store) return;
      const clientId="stateless-owner-client",redirectUri="https://chatgpt.com/callback";
      store.registerClient(clientId,[redirectUri]);
      const verifier=crypto.randomBytes(32).toString("base64url");
      const challenge=crypto.createHash("sha256").update(verifier).digest("base64url");
      const resource="https://issuer.example/mcp";
      const pending=store.createAuthorizationRequest({clientId,redirectUri,
        codeChallenge:challenge,codeChallengeMethod:"S256",
        scope:["mcp:tools"],resource,state:"stateless-state"});
      const approved=store.approveAuthorizationRequest(pending.requestId,true);
      expect(approved.ok).toBe(true);
      if(!approved.ok) return;
      const exchange=store.exchangeCode({code:approved.code,clientId,redirectUri,
        codeVerifier:verifier,resource});
      expect(exchange.ok).toBe(true);
      if(!exchange.ok) return;
      const response=await fetch("http://127.0.0.1:"+port+"/mcp",{method:"POST",
        headers:headers(exchange.accessToken),
        body:JSON.stringify({jsonrpc:"2.0",id:7,method:"tools/list",params:{}})});
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("superagent_tool_search");
    }finally{await server.close();}
  });
});
