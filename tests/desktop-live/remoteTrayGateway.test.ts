import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TrayManagementPassword } from "../../src/core/desktopUi/trayManagementPassword.js";
import { startRemoteTrayGateway, type RemoteTrayGateway } from "../../src/core/desktopUi/remoteTrayGateway.js";

const origin="https://tray.example.test";
const dirs:string[]=[];
let gateway:RemoteTrayGateway|undefined;
afterEach(async()=>{await gateway?.close();gateway=undefined;for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
function store(){
  const dir=mkdtempSync(join(tmpdir(),"sa-tray-gateway-"));dirs.push(dir);
  return new TrayManagementPassword(join(dir,"password.json"));
}
const headers={
  Host:"tray.example.test",
  "x-forwarded-proto":"https",
  "cf-ray":"abcdef0123456789-SIN",
  "sec-fetch-site":"same-origin",
};
const fixtures=[{id:"native:123:hwnd-123",kind:"native",title:"Editor",application:"Editor",handle:"hwnd-123",
  status:"controlled",stopAction:"stop-session"}];
async function setup(p:TrayManagementPassword){
  const stop=vi.fn(async()=>({stopped:true,scope:"native:123:hwnd-123",reason:"Revoked"}));
  gateway=await startRemoteTrayGateway({publicOrigin:origin,originPort:0,passwordStore:p,
    inventory:async()=>({observedAt:Date.now(),items:fixtures as any,sources:{"native":"ok","managed-cdp":"ok","cdp-delegate":"ok"}}),
    stop:stop as any});
  return {base:"http://127.0.0.1:"+gateway.originPort,stop};
}
function get(base:string,path:string,more:Record<string,string>={}) {
  return fetch(base+path,{headers:{...headers,...more},redirect:"manual"});
}
function post(base:string,path:string,body:string,more:Record<string,string>={}) {
  return fetch(base+path,{method:"POST",headers:{...headers,Origin:origin,...more},body,redirect:"manual"});
}

describe("password-protected remote Tray origin does not expose live screen",()=>{
  it("never starts without a configured password or a dedicated HTTPS origin",async()=>{
    const p=store();
    await expect(startRemoteTrayGateway({publicOrigin:origin,originPort:0,passwordStore:p})).rejects.toThrow("TRAY_PASSWORD_REQUIRED");
    p.set({newPassword:"Use-A-Long-Password-2026"});
    await expect(startRemoteTrayGateway({publicOrigin:"http://127.0.0.1:3000",originPort:0,passwordStore:p})).rejects.toThrow("INVALID_TRAY_HTTPS_ORIGIN");
  });
  it("rejects direct localhost browsing, spoofed origin and unauthenticated inventory",async()=>{
    const p=store();p.set({newPassword:"Use-A-Long-Password-2026"});
    const {base,stop}=await setup(p);
    expect(gateway!.publicUrl).toBe(origin);
    expect((gateway! as any).url).toBeUndefined();
    expect((await fetch(base+"/")).status).toBe(403);
    expect((await get(base,"/api/inventory")).status).toBe(401);
    expect((await get(base,"/",{Host:"127.0.0.1"})).status).toBe(403);
    expect((await get(base,"/",{"x-forwarded-proto":"http"})).status).toBe(403);
    expect((await get(base,"/api/frame")).status).toBe(401);
    expect(stop).not.toHaveBeenCalled();
  });
  it("uses Secure HttpOnly cookie and CSRF, exact stop, and logout",async()=>{
    const password="Use-A-Long-Password-2026";
    const p=store();p.set({newPassword:password});
    const {base,stop}=await setup(p);
    const body="password="+encodeURIComponent(password);
    const invalid=await post(base,"/login","password="+encodeURIComponent("invalid"),{"content-type":"application/x-www-form-urlencoded"});
    expect(invalid.status).toBe(403);
    const login=await post(base,"/login",body,{"content-type":"application/x-www-form-urlencoded"});
    expect(login.status).toBe(303);
    const cookie=login.headers.get("set-cookie")||"";
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).not.toContain(password);
    const sessionCookie=cookie.split(";")[0];
    const signed={Cookie:sessionCookie};
    const session=await get(base,"/api/session",signed);
    expect(session.status).toBe(200);
    const {csrf}=await session.json();
    expect(csrf).toMatch(/^[a-f0-9]{64}$/);
    const inventory=await get(base,"/api/inventory",signed);
    expect(inventory.status).toBe(200);
    expect((await inventory.json()).items[0].title).toBe("Editor");
    const unsigned=await post(base,"/api/stop",JSON.stringify({id:"native:123:hwnd-123"}),{...signed,"content-type":"application/json"});
    expect(unsigned.status).toBe(403);
    const good=await post(base,"/api/stop",JSON.stringify({id:"native:123:hwnd-123"}),{...signed,"content-type":"application/json","x-tray-csrf":csrf});
    expect(good.status).toBe(200);
    expect(stop).toHaveBeenCalledOnce();
    const logout=await post(base,"/logout","{}",{...signed,"x-tray-csrf":csrf});
    expect(logout.status).toBe(200);
    expect((await get(base,"/api/inventory",signed)).status).toBe(401);
  });
  it("never sends private screenshot endpoints or arbitrary Tauri commands",async()=>{
    const p=store();p.set({newPassword:"Use-A-Long-Password-2026"});
    const {base}=await setup(p);
    const html=await (await get(base,"/")).text();
    expect(html).toContain('name="password"');
    expect(html).not.toContain("desktop_live_action");
    expect(html).not.toContain("<img");
    expect((await get(base,"/api/desktop/live/frame")).status).toBe(401);
    expect((await post(base,"/api/desktop/live/start","{}",{"content-type":"application/json"})).status).toBe(401);
  });
});
