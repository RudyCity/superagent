import {describe,expect,it,vi} from "vitest";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const script = fs.readFileSync(
  path.resolve("apps/superagent-tray/ui/named-tunnel-settings.js"),"utf8");
const html = fs.readFileSync(
  path.resolve("apps/superagent-tray/ui/index.html"),"utf8");
const base = {
  version:1,connectorMode:"remote-managed",
  tunnelId:"b2e8c6d9-9317-4d9e-b381-826af22e1778",
  hostname:"mcp.rcity.web.id",anchorPort:19320,ownerPort:19321,
  tokenFilePath:"",credentialsFilePath:"",
  cloudflaredPath:"C:\\ProgramData\\chocolatey\\bin\\cloudflared.exe",
};
function createUi(saved=base){
  const nodes = new Map<string,any>();
  const events = new Map<string,(e?:any)=>Promise<void>|void>();
  const calls:Array<{command:string,args?:any}> = [];
  const get = (id:string)=>{
    if(!nodes.has(id)){
      nodes.set(id,{
        value:"",textContent:"",disabled:false,hidden:false,dataset:{},
        addEventListener:(event:string,callback:any)=>events.set(id+":"+event,callback),
      });
    }
    return nodes.get(id);
  };
  const invoke=vi.fn(async(command:string,args?:any)=>{
    calls.push({command,args});
    if(command==="get_named_tunnel_settings"){
      return {settings:{...saved},configured:true,credentialFilePresent:false,
        cloudflaredPresent:true,status:"credential_file_missing"};
    }
    if(command==="set_named_tunnel_settings"){
      return {settings:{...args.settings},configured:true,
        credentialFilePresent:false,cloudflaredPresent:true,
        connectionVerified:false,dnsVerified:false,activated:false,
        status:"credential_file_missing"};
    }
    throw Error("Forbidden native invocation "+command);
  });
  vm.runInNewContext(script,{
    document:{readyState:"complete",getElementById:get},
    window:{__TAURI__:{core:{invoke},event:{listen:async()=>()=>{}}},
      TrayFeedback:{notify:vi.fn()}},
    Number,String,Object,Array,Error,Promise,RegExp,Set,
  });
  return {get,events,calls,invoke};
}
const flush=async()=>new Promise<void>(r=>setImmediate(r));
describe("Named Cloudflare Tunnel Tray Settings",()=>{
  it("includes all fields and dedicated styles/script without changing Quick provider menu",()=>{
    for(const name of [
      "named-tunnel-settings-form","named-tunnel-mode","named-tunnel-hostname",
      "named-tunnel-id","named-tunnel-anchor-port","named-tunnel-owner-port",
      "named-tunnel-token-file","named-tunnel-credentials-file",
      "named-tunnel-binary","named-tunnel-save","named-tunnel-check",
      "named-tunnel-readiness","named-tunnel-status",
    ])expect(html).toContain('id="'+name+'"');
    expect(html).toContain("./named-tunnel-settings.js");
    expect(html).toContain("./named-tunnel-settings.css");
    expect(html).toContain("Cloudflare Quick Tunnel");
  });
  it("loads the persisted Named Tunnel without starting or changing any service",async()=>{
    const ui=createUi();await flush();
    expect(ui.get("named-tunnel-hostname").value).toBe("mcp.rcity.web.id");
    expect(ui.get("named-tunnel-id").value).toBe(base.tunnelId);
    expect(ui.get("named-tunnel-status").textContent).toBe("Credential missing");
    expect(ui.get("named-tunnel-token-row").hidden).toBe(false);
    expect(ui.get("named-tunnel-credentials-row").hidden).toBe(true);
    expect(ui.calls.map(x=>x.command)).toEqual(["get_named_tunnel_settings"]);
  });
  it("stores only metadata and token-file PATH without invoking tunnel activation",async()=>{
    const ui=createUi();await flush();
    ui.get("named-tunnel-token-file").value="C:\\Users\\USER\\.cloudflared\\mcp.token";
    const submit=ui.events.get("named-tunnel-settings-form:submit")!;
    await submit({preventDefault:vi.fn()});
    const calls=ui.calls.map(x=>x.command);
    expect(calls).toEqual(["get_named_tunnel_settings","set_named_tunnel_settings"]);
    const payload=ui.calls[1].args.settings;
    expect(payload).toEqual({...base,
      tokenFilePath:"C:\\Users\\USER\\.cloudflared\\mcp.token"});
    expect(JSON.stringify(payload)).not.toMatch(/eyJ[a-zA-Z0-9]{30,}/);
    expect(ui.get("named-tunnel-feedback").textContent).toContain("NOT changed");
  });
  it("changes connector mode and avoids retaining conflicting credential paths",async()=>{
    const ui=createUi();await flush();
    ui.get("named-tunnel-mode").value="local-managed";
    ui.events.get("named-tunnel-mode:change")!();
    expect(ui.get("named-tunnel-token-row").hidden).toBe(true);
    expect(ui.get("named-tunnel-credentials-row").hidden).toBe(false);
    ui.get("named-tunnel-token-file").value="C:\\never\\use-this.token";
    ui.get("named-tunnel-credentials-file").value="C:\\Users\\USER\\.cloudflared\\named.json";
    await ui.events.get("named-tunnel-settings-form:submit")!({preventDefault(){}});
    expect(ui.calls[1].args.settings.tokenFilePath).toBe("");
    expect(ui.calls[1].args.settings.credentialsFilePath)
      .toBe("C:\\Users\\USER\\.cloudflared\\named.json");
  });
  it("rejects unsafe hostname, reused live port and raw token paste before native call",async()=>{
    const ui=createUi();await flush();
    ui.get("named-tunnel-hostname").value="mcp.trycloudflare.com";
    await ui.events.get("named-tunnel-settings-form:submit")!({preventDefault(){}});
    expect(ui.calls.length).toBe(1);
    expect(ui.get("named-tunnel-feedback").textContent).toContain("NOT saved");
    ui.get("named-tunnel-hostname").value="mcp.rcity.web.id";
    ui.get("named-tunnel-anchor-port").value="9227";
    await ui.events.get("named-tunnel-settings-form:submit")!({preventDefault(){}});
    expect(ui.calls.length).toBe(1);
    ui.get("named-tunnel-anchor-port").value="19320";
    ui.get("named-tunnel-token-file").value="eyJhIjoiVerySensitiveToken123";
    await ui.events.get("named-tunnel-settings-form:submit")!({preventDefault(){}});
    expect(ui.calls.length).toBe(1);
  });
  it("Check readiness only reads the saved settings",async()=>{
    const ui=createUi();await flush();
    await ui.events.get("named-tunnel-check:click")!();
    await flush();
    expect(ui.calls.map(x=>x.command)).toEqual([
      "get_named_tunnel_settings","get_named_tunnel_settings",
    ]);
  });
});
