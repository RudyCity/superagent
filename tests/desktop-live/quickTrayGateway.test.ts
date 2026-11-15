import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TrayManagementPassword } from "../../src/core/desktopUi/trayManagementPassword.js";
import { startRemoteTrayGateway, type RemoteTrayGateway } from "../../src/core/desktopUi/remoteTrayGateway.js";

const directories:string[]=[];
let gateway:RemoteTrayGateway|undefined;
afterEach(async()=>{
  await gateway?.close();gateway=undefined;
  for(const directory of directories.splice(0))rmSync(directory,{recursive:true,force:true});
});
function store(){
  const folder=mkdtempSync(join(tmpdir(),"sa-tray-quick-"));
  directories.push(folder);
  const password=new TrayManagementPassword(join(folder,"credential.json"));
  password.set({newPassword:"Long-Temporary-Quick-Management-Password"});
  return password;
}
const url="https://bright-palm.trycloudflare.com";
function get(base:string,path:string,options:Record<string,string>={}){
  return fetch(base+path,{headers:{
    Host:"bright-palm.trycloudflare.com",
    "x-forwarded-proto":"https","cf-ray":"abcdefabcdef1234-SIN",
    ...options,
  },redirect:"manual"});
}
describe("Quick Tray gateway stays dark until exact cloudflared hostname assignment",()=>{
  it("cannot accept requests until a Quick URL is locked and password is configured",async()=>{
    const p=store();
    gateway=await startRemoteTrayGateway({publicOrigin:"",mode:"quick",originPort:0,
      passwordStore:p,inventory:async()=>({observedAt:0,items:[],sources:{} as any})});
    const base="http://127.0.0.1:"+gateway.originPort;
    expect(gateway.publicUrl).toBe("");
    expect((await get(base,"/")).status).toBe(403);
    expect(()=>gateway!.activateQuickOrigin("https://trycloudflare.com")).toThrow();
    expect(()=>gateway!.activateQuickOrigin("https://wrong.trycloudflare.com.attacker.net")).toThrow();
    gateway.activateQuickOrigin(url);
    expect(gateway.publicUrl).toBe(url);
    expect((await get(base,"/")).status).toBe(200);
    expect(()=>gateway!.activateQuickOrigin("https://changed.trycloudflare.com")).toThrow();
    expect((await get(base,"/api/desktop/live/frame")).status).toBe(401);
    expect((await get(base,"/api/inventory")).status).toBe(401);
  });
  it("requires password, same origin and never allows raw screen routes",async()=>{
    gateway=await startRemoteTrayGateway({publicOrigin:"",mode:"quick",originPort:0,
      passwordStore:store(),inventory:async()=>({observedAt:0,items:[],sources:{} as any})});
    gateway.activateQuickOrigin(url);
    const base="http://127.0.0.1:"+gateway.originPort;
    const login=await fetch(base+"/login",{
      method:"POST",redirect:"manual",
      headers:{Host:"bright-palm.trycloudflare.com","x-forwarded-proto":"https",
        "cf-ray":"abcdefabcdef1234-SIN",Origin:url,"Content-Type":"application/x-www-form-urlencoded"},
      body:"password="+encodeURIComponent("Long-Temporary-Quick-Management-Password"),
    });
    expect(login.status).toBe(303);
    const cookie=login.headers.get("set-cookie")?.split(";")[0]||"";
    expect(cookie).toContain("sa_tray=");
    expect((await get(base,"/api/inventory",{Cookie:cookie})).status).toBe(200);
    expect((await get(base,"/api/desktop/live/frame",{Cookie:cookie})).status).toBe(404);
    expect((await get(base,"/mcp",{Cookie:cookie})).status).toBe(404);
    expect((await get(base,"/api/inventory",{Cookie:cookie,Host:"not-us.trycloudflare.com"})).status).toBe(403);
    expect((await get(base,"/api/inventory",{Cookie:cookie,"x-forwarded-proto":"http"})).status).toBe(403);
  });
  it("rejects Quick hostname smuggled into Named mode",async()=>{
    await expect(startRemoteTrayGateway({publicOrigin:url,originPort:0,passwordStore:store()}))
      .rejects.toThrow("INVALID_TRAY_HTTPS_ORIGIN");
  });
});
