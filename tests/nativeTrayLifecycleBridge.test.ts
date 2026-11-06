import {describe,it,expect} from "vitest";
import {
  parseNativeTrayLifecycleRequest,nativeLifecycleLoopbackOnly,
  sanitizeNativeLifecycleView,handleNativeTrayLifecycleHttp,
} from "../src/core/runtime/nativeTrayLifecycleBridge.js";
import type http from "node:http";

function request(options: {
  ip?:string;host?:string;origin?:string;forwarded?:string;method?:string;
}={}):http.IncomingMessage{
  return {
    socket:{remoteAddress:options.ip??"127.0.0.1"},
    headers:{host:options.host??"127.0.0.1:7888",
      ...(options.origin?{origin:options.origin}:{}),
      ...(options.forwarded?{"x-forwarded-for":options.forwarded}:{})},
    method:options.method??"POST",
  } as any;
}
function response(){
  let reply:{status:number;data:any}|null=null;
  const res={setHeader:()=>{}} as any;
  return {res,send:(_r:any,status:number,data:any)=>{reply={status,data};},
    get:()=>reply as {status:number;data:any}|null};
}
describe("authenticated Core -> Tauri lifecycle strict boundary",()=>{
  it("permits read-only and planned local native tasks; rejects tunnels/unknown services",()=>{
    expect(parseNativeTrayLifecycleRequest({action:"dashboard"}).action).toBe("dashboard");
    expect(parseNativeTrayLifecycleRequest({action:"profile",service:"tray"}).service).toBe("tray");
    expect(parseNativeTrayLifecycleRequest({
      action:"plan",service:"tray",targetAction:"upgrade",
    }).targetAction).toBe("upgrade");
    expect(parseNativeTrayLifecycleRequest({
      action:"plan",service:"core",port:7888,targetAction:"recycle",
    }).targetAction).toBe("recycle");
    expect(parseNativeTrayLifecycleRequest({
      action:"plan",service:"core",port:7888,targetAction:"restart",
    }).targetAction).toBe("restart");
    expect(()=>parseNativeTrayLifecycleRequest({
      action:"plan",service:"core",port:7888,targetAction:"start",
    })).toThrow("PLAN_TARGET_RESTRICTED");
    expect(()=>parseNativeTrayLifecycleRequest({action:"stop",service:"tray"}))
      .toThrow("EXPLICIT_CONFIRMATION");
    expect(()=>parseNativeTrayLifecycleRequest({action:"plan",
      service:"rest_tunnel",targetAction:"stop"})).toThrow();
    expect(()=>parseNativeTrayLifecycleRequest({action:"watchdog",confirm:true}))
      .toThrow("WATCHDOG_AUTOMATION_RESTRICTED");
    expect(()=>parseNativeTrayLifecycleRequest({action:"restart",
      service:"mcp",confirm:true,operationId:"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"}))
      .toThrow("MUTATION_TARGET_RESTRICTED");
    expect(()=>parseNativeTrayLifecycleRequest({action:"logs",
      url:"https://evil.example"})).toThrow("SERVICE_UNEXPECTED_ARGUMENT");
  });
  it("permits only explicit owner-bound Core restart and refuses stale/missing plan identity",()=>{
    const op="123e4567-e89b-42d3-a456-426614174000";
    const fields={action:"restart",service:"core",port:7888,confirm:true,
      operationId:op,expectedBuildDigest:"a".repeat(64),
      expectedSupervisorPid:101,expectedWorkerPid:201};
    expect(parseNativeTrayLifecycleRequest(fields)).toMatchObject(fields);
    expect(()=>parseNativeTrayLifecycleRequest({...fields,expectedWorkerPid:undefined}))
      .toThrow("DESKTOP_LIFECYCLE_CORE_OWNER_BOUND_PLAN_REQUIRED");
    expect(()=>parseNativeTrayLifecycleRequest({...fields,expectedSupervisorPid:undefined}))
      .toThrow("DESKTOP_LIFECYCLE_CORE_OWNER_BOUND_PLAN_REQUIRED");
    expect(()=>parseNativeTrayLifecycleRequest({...fields,confirm:false}))
      .toThrow("DESKTOP_LIFECYCLE_EXPLICIT_CONFIRMATION_REQUIRED");
    expect(()=>parseNativeTrayLifecycleRequest({...fields,action:"start"}))
      .toThrow("DESKTOP_LIFECYCLE_MUTATION_TARGET_RESTRICTED");
  });
  it("requires loopback IP/host, no browser origin and no forwarded headers",()=>{
    expect(nativeLifecycleLoopbackOnly(request())).toBe(true);
    for(const req of [
      request({ip:"192.168.1.17"}),request({host:"public.example"}),
      request({origin:"https://attacker.example"}),
      request({forwarded:"1.2.3.4"}),request({host:"127.0.0.1:80"}),
    ])expect(nativeLifecycleLoopbackOnly(req)).toBe(false);
  });
  it("sanitizes bearer tokens, URLs, local paths, nested credential fields",()=>{
    const result=sanitizeNativeLifecycleView({
      service:"tray",token:"not-for-webview",
      privateKey:"SECRET",publicUrl:"https://real.example",
      details:{ownerPid:1234,localUrl:"http://127.0.0.1:7888",
        reason:"Bearer password123 and https://private.example"},
      reports:[{file:"C:\Users\admin\secrets.txt",status:"ready"}],
    }) as any;
    expect(result.service).toBe("tray");
    expect(result.details.ownerPid).toBe(1234);
    const raw=JSON.stringify(result);
    expect(raw).not.toContain("not-for-webview");
    expect(raw).not.toContain("password123");
    expect(raw).not.toContain("real.example");
    expect(raw).not.toContain("private.example");
    expect(raw).not.toContain("admin\\secrets");
  });
  it("does not call a service operation on remote, GET or malformed requests",async()=>{
    const first=response();
    await handleNativeTrayLifecycleHttp(request({origin:"https://evil.example"}),
      first.res,async()=>JSON.stringify({action:"status"}),first.send);
    expect(first.get()?.status).toBe(403);
    const second=response();
    await handleNativeTrayLifecycleHttp(request({method:"GET"}),
      second.res,async()=>JSON.stringify({action:"status"}),second.send);
    expect(second.get()?.status).toBe(405);
    const third=response();
    await handleNativeTrayLifecycleHttp(request(),
      third.res,async()=>JSON.stringify({action:"stop",service:"mcp",confirm:true}),
      third.send);
    expect(third.get()?.status).toBe(409);
    expect(JSON.stringify(third.get())).not.toContain("Bearer ");
  });

  it("redacts actual Windows and UNC filesystem paths including spaces",()=>{
    const slash=String.fromCharCode(92);
    const local=["C:","Users","Real Operator","secret-folder","owner.json"].join(slash);
    const unc=slash+slash+["host","private share","token.txt"].join(slash);
    const result=sanitizeNativeLifecycleView({
      reason:"Unverified "+local,
      report:"Owner snapshot: "+unc,
    });
    const output=JSON.stringify(result);
    expect(output).toContain("[path redacted]");
    expect(output).not.toContain("Real Operator");
    expect(output).not.toContain("secret-folder");
    expect(output).not.toContain("private share");
    expect(output).not.toContain("token.txt");
  });
});
