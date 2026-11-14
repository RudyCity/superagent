import http from "node:http";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { handleServerRoute } from "../../src/serverRoutes.js";
import { ensureServerAuthToken } from "../../src/core/utils/serverSecurity.js";

describe("Tray management operator routes reject HTTP tunnel/proxy and missing Core auth",()=>{
  let server:http.Server;let port=0;let bearer="";
  beforeAll(async()=>{
    bearer=ensureServerAuthToken();
    server=http.createServer(async(req,res)=>{
      const url=new URL(req.url||"/","http://127.0.0.1");
      const ctx:any={activeSessions:new Map(),lastActiveWorkspace:"",sseClients:new Set(),
        sseClientContexts:new Map(),browserInstances:new Map(),pendingPermissions:new Map(),
        pendingQuestions:new Map(),pendingBrowserControls:new Map(),broadcastEvent:()=>undefined,
        sendJSON:(out:http.ServerResponse,status:number,value:unknown)=>{
          out.writeHead(status,{"Content-Type":"application/json"});out.end(JSON.stringify(value));
        },
        readBody:async(message:http.IncomingMessage)=>{
          let body="";for await(const part of message)body+=part.toString();return body;
        }};
      try {
        if(!await handleServerRoute(req,res,url.pathname,url,ctx)){res.statusCode=404;res.end("{}");}
      }catch{res.statusCode=500;res.end("{}");}
    });
    await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
    port=(server.address() as {port:number}).port;
  });
  afterAll(async()=>{if(server)await new Promise<void>(resolve=>server.close(()=>resolve()));});
  function request(method:string,path:string,more:Record<string,string>={},body=""){
    return new Promise<{status:number;body:Record<string,unknown>}>((resolve,reject)=>{
      const req=http.request({hostname:"127.0.0.1",port,method,path,
        headers:{Host:`127.0.0.1:${port}`,"Content-Type":"application/json",...more}},res=>{
          let text="";res.on("data",part=>text+=part.toString());
          res.on("end",()=>{
            try{resolve({status:res.statusCode||0,body:JSON.parse(text||"{}")});}
            catch(error){reject(error);}
          });
        });
      req.on("error",reject);req.end(body);
    });
  }
  it("denies all operator inventory/password/remote management routes without Core bearer",async()=>{
    for(const [method,path] of [
      ["GET","/api/desktop/live/manage"],
      ["POST","/api/desktop/live/manage/stop"],
      ["GET","/api/desktop/tray-password/status"],
      ["POST","/api/desktop/tray-password/set"],
      ["GET","/api/desktop/tray-remote/status"],
      ["POST","/api/desktop/tray-remote/start"],
      ["POST","/api/desktop/tray-remote/stop"],
    ])expect((await request(method,path)).status).toBe(403);
  });
  it("rejects tunnel forwarding and browser Origin even with valid Core bearer",async()=>{
    for(const headers of [{"X-Forwarded-Proto":"https"},{"CF-Ray":"abc12345-SIN"},{"Origin":"https://tray.example.test"}]){
      expect((await request("GET","/api/desktop/tray-password/status",{
        Authorization:"Bearer "+bearer,...headers,
      })).status).toBe(403);
      expect((await request("POST","/api/desktop/tray-remote/start",{
        Authorization:"Bearer "+bearer,...headers,
      },"{}")).status).toBe(403);
    }
  });
  it("returns password configuration only, never any hash or remote credentials",async()=>{
    const result=await request("GET","/api/desktop/tray-password/status",{
      Authorization:"Bearer "+bearer,
    });
    expect(result.status).toBe(200);
    expect(result.body.success).toBe(true);
    expect(typeof result.body.configured).toBe("boolean");
    expect(JSON.stringify(result.body)).not.toMatch(/digest|salt|privateKey|sessionToken/);
    const route=await request("GET","/api/desktop/tray-remote/status",{
      Authorization:"Bearer "+bearer,
    });
    expect(route.status).toBe(200);
    expect(route.body).toHaveProperty("routeVerified",false);
  });
});
