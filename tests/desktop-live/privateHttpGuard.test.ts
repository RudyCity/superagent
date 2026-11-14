import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getRootConfigDir } from "../../src/core/config/paths.js";
import { NativeDesktopApprovalGuard } from "../../src/core/desktopUi/nativeApprovalProof.js";
import { nativeWindowPreviewManager } from "../../src/core/desktopUi/livePreview.js";
import { handleServerRoute } from "../../src/serverRoutes.js";
import { ensureServerAuthToken } from "../../src/core/utils/serverSecurity.js";

describe("native desktop live private loopback HTTP guard", () => {
  let server: http.Server;
  let port: number;
  let bearer: string;
  beforeAll(async () => {
    bearer = ensureServerAuthToken();
    server = http.createServer(async (req,res) => {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      const ctx: any = {
        activeSessions: new Map(), lastActiveWorkspace: "", sseClients:new Set(),
        sseClientContexts:new Map(), browserInstances:new Map(),
        pendingPermissions:new Map(), pendingQuestions:new Map(), pendingBrowserControls:new Map(),
        broadcastEvent: () => undefined,
        sendJSON: (response:http.ServerResponse,status:number,data:unknown) => {
          response.writeHead(status,{"Content-Type":"application/json"});
          response.end(JSON.stringify(data));
        },
        readBody: async (request:http.IncomingMessage) => {
          let body = "";
          for await (const chunk of request) body += chunk.toString();
          return body;
        },
      };
      try {
        const handled = await handleServerRoute(req,res,url.pathname,url,ctx);
        if (!handled) { res.statusCode=404; res.end(); }
      } catch { res.statusCode=500; res.end(); }
    });
    await new Promise<void>(resolve => server.listen(0,"127.0.0.1",resolve));
    port = (server.address() as {port:number}).port;
  });
  afterAll(async () => {
    if(server) await new Promise<void>(resolve=>server.close(()=>resolve()));
  });
  function request(method:string,path:string,headers:Record<string,string>={},body="") {
    return new Promise<{status:number;body:any}>((resolve,reject) => {
      const req = http.request({
        host:"127.0.0.1",port,method,path,
        headers:{Host:`127.0.0.1:${port}`, "Content-Type":"application/json",...headers},
      },res=>{
        let data="";
        res.on("data",chunk=>data+=chunk.toString());
        res.on("end",()=>resolve({status:res.statusCode || 0,body:JSON.parse(data || "{}")}));
      });
      req.on("error",reject);
      req.end(body);
    });
  }

  it("denies an unauthenticated window discovery before inspecting the desktop", async () => {
    const res = await request("GET","/api/desktop/live/windows");
    expect(res.status).toBe(403);
  });
  it("denies a token in the URL even if it is the current bearer", async () => {
    const res = await request("GET",`/api/desktop/live/windows?token=${bearer}`);
    expect(res.status).toBe(403);
  });
  it("denies external host spoofing with an otherwise valid bearer", async () => {
    const res = await request("POST","/api/desktop/live/frame",
      {Host:"remote.example.com",Authorization:`Bearer ${bearer}`},JSON.stringify({token:"a".repeat(64)}));
    expect(res.status).toBe(403);
  });
  it("denies browser Origin and reverse-proxy headers even with valid bearer", async () => {
    for (const headers of [{Origin:"http://localhost"},{ "X-Forwarded-For":"203.0.113.7" },
      { "Cf-Connecting-Ip":"203.0.113.7" }]) {
      const res = await request("POST","/api/desktop/live/frame",
        {...headers,Authorization:`Bearer ${bearer}`},JSON.stringify({token:"a".repeat(64)}));
      expect(res.status).toBe(403);
    }
  });
  it("refuses a forged preview token and does not send screenshots", async () => {
    const res = await request("POST","/api/desktop/live/frame",
      {Authorization:`Bearer ${bearer}`},JSON.stringify({token:"b".repeat(64)}));
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).not.toMatch(/png|image|base64|window/i);
  });
  it("does not allow bearer-only clients to impersonate native Tray consent", async () => {
    const approved = {
      pid: 4102, nativeId: "cg:123", consent: true,
      expectedTitle: "Example", expectedApplication: "Example.app",
      expectedBounds: { x: 0, y: 0, width: 400, height: 300 },
    };
    const auth = { Authorization: `Bearer ${bearer}` };
    const denied = await request("POST", "/api/desktop/live/start", auth, JSON.stringify(approved));
    expect(denied.status).toBe(409);
    const challenge = await request("POST", "/api/desktop/live/challenge", auth, "{}");
    expect(challenge.status).toBe(200);
    expect(challenge.body.nonce).toMatch(/^[a-f0-9]{48}$/);
    const forged = await request("POST", "/api/desktop/live/start", auth, JSON.stringify({
      ...approved, approvalProof: { nonce: challenge.body.nonce, mac: "a".repeat(64) },
    }));
    expect(forged.status).toBe(409);
    expect(JSON.stringify(forged.body)).not.toMatch(/png|base64|screenshots/i);
  });

  it("accepts exact native-signed proof only once and never forwards proof to capture manager", async () => {
    const auth={Authorization:`Bearer ${bearer}`};
    const body={pid:4792,nativeId:"cg:128",consent:true,
      expectedTitle:"Screenshot — private",expectedApplication:"Test.app",
      expectedBounds:{x:15,y:10,width:360,height:240}};
    const challenge=await request("POST","/api/desktop/live/challenge",auth,"{}");
    expect(challenge.status).toBe(200);
    const keyPath=path.join(getRootConfigDir(),".desktop-live-native-approval.key");
    const key=Buffer.from(fs.readFileSync(keyPath,"ascii").trim(),"hex");
    const message={...body,approvalProof:{
      nonce:challenge.body.nonce,
      mac:NativeDesktopApprovalGuard.computeProofForTest(key,body,challenge.body.nonce),
    }};
    const spy=vi.spyOn(nativeWindowPreviewManager,"start").mockImplementation(async raw=>{
      expect(raw).toEqual(body);
      return {token:"c".repeat(64),expiresAt:Date.now()+30_000,
        platform:"win32",backend:"test-source",window:body};
    });
    try {
      const accepted=await request("POST","/api/desktop/live/start",auth,JSON.stringify(message));
      expect(accepted.status).toBe(200);
      expect(accepted.body.token).toBe("c".repeat(64));
      const replay=await request("POST","/api/desktop/live/start",auth,JSON.stringify(message));
      expect(replay.status).toBe(409);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {spy.mockRestore();}
  });

  it("refuses start without explicit consent and other request fields", async () => {
    for (const payload of [
      {pid:4102,nativeId:"window",consent:false},
      {pid:4102,nativeId:"window",consent:true,extra:"untrusted"},
    ]) {
      const res = await request("POST","/api/desktop/live/start",
        {Authorization:`Bearer ${bearer}`},JSON.stringify(payload));
      expect(res.status).toBe(409);
    }
  });
});
