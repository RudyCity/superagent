import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
