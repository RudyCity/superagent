import {describe,expect,it,vi} from "vitest";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const code=fs.readFileSync(
  path.resolve("apps/superagent-tray/ui/named-tunnel-runtime.js"),"utf8");
const html=fs.readFileSync(path.resolve("apps/superagent-tray/ui/index.html"),"utf8");
const tunnelId="b2e8c6d9-9317-4d9e-b381-826af22e1778";
const health={
  hostname:"mcp.rcity.web.id",tunnelId,
  connectorStatus:"not_started",connectorPid:null,tokenVerified:true,
  anchorStatus:"verified_local",ownerStatus:"not_verified",
  edgeHttpStatus:530,edgeObserved:false,mcpAuthChallengeObserved:false,
  readyForCutover:false,quickTunnelUntouched:true,reason:"MCP owner not attached",
};
function setup(options:{
  health?:Record<string,unknown>;
  cancelImport?:boolean;
  failPlan?:boolean;
}={}){
  const nodes=new Map<string,any>();
  const listeners=new Map<string,()=>Promise<void>|void>();
  const invokes:Array<{name:string,args?:any}>=[];
  const dispatched:string[]=[];
  const node=(id:string)=>{
    if(!nodes.has(id))nodes.set(id,{
      textContent:"",disabled:false,dataset:{},
      setAttribute:function(name:string,value:string){this[name]=value},
      addEventListener:(type:string,cb:any)=>listeners.set(id+":"+type,cb),
    });
    return nodes.get(id);
  };
  const invoke=vi.fn(async(name:string,args?:any)=>{
    invokes.push({name,args});
    if(name==="get_named_tunnel_health")return {...health,...options.health};
    if(name==="get_named_tunnel_settings")return {settings:{tunnelId}};
    if(name==="pick_named_tunnel_token")return options.cancelImport?null:
      {status:"configured_not_connected",settings:{tunnelId,tokenFilePath:"C:/private/tunnel.token"}};
    if(name==="plan_named_tunnel_connector"){
      if(options.failPlan)throw Error("TOKEN_UNAVAILABLE");
      return {noQuickTunnelMutation:true,
        status:{hostname:"mcp.rcity.web.id",tunnelId,status:"not_started"}};
    }
    if(name==="named_tunnel_connector_action")return {
      noQuickTunnelMutation:true,reviewed:true,
      status:{hostname:"mcp.rcity.web.id",tunnelId,status:"verified_local_only"},
    };
    throw Error("Unrecognized native action: "+name);
  });
  vm.runInNewContext(code,{
    document:{readyState:"complete",getElementById:node},
    window:{
      __TAURI__:{core:{invoke}},
      dispatchEvent:(event:{type:string})=>{dispatched.push(event.type)},
      addEventListener:(event:string,fn:()=>void)=>listeners.set("window:"+event,fn),
    },
    Event:class {constructor(public type:string){}},
    Number,String,Promise,Array,Object,Error,
  });
  return {node,listeners,invokes,dispatched};
}
const flush=async()=>new Promise<void>(resolve=>setImmediate(resolve));
describe("Named Tunnel native lifecycle and health UI",()=>{
  it("ships accessible health and lifecycle controls",()=>{
    for(const id of [
      "named-tunnel-health","named-tunnel-connector-health","named-tunnel-anchor-health",
      "named-tunnel-owner-health","named-tunnel-edge-health","named-tunnel-health-reason",
      "named-tunnel-import-token","named-tunnel-plan",
      "named-tunnel-start","named-tunnel-stop",
    ])expect(html).toContain('id="'+id+'"');
    expect(html).toContain("./named-tunnel-runtime.js");
  });
  it("loads fail-closed health without mutating any service",async()=>{
    const ui=setup();await flush();
    expect(ui.invokes.map(v=>v.name)).toEqual(["get_named_tunnel_health"]);
    expect(ui.node("named-tunnel-edge-health").textContent).toContain("HTTP 530");
    expect(ui.node("named-tunnel-start").disabled).toBe(false);
    expect(ui.node("named-tunnel-stop").disabled).toBe(true);
    expect(ui.node("named-tunnel-health-reason").textContent).toContain("Cutover is disabled");
  });
  it("never enables start without a verified Anchor/token",async()=>{
    const ui=setup({health:{anchorStatus:"not_verified",tokenVerified:false}});
    await flush();
    expect(ui.node("named-tunnel-start").disabled).toBe(true);
    expect(ui.node("named-tunnel-plan").disabled).toBe(true);
  });
  it("starts only the exact named connector through native approval",async()=>{
    const ui=setup();await flush();
    await ui.listeners.get("named-tunnel-start:click")!();await flush();
    expect(ui.invokes.map(x=>x.name)).toEqual([
      "get_named_tunnel_health","get_named_tunnel_settings",
      "named_tunnel_connector_action","get_named_tunnel_health",
    ]);
    expect(ui.invokes[2].args).toEqual({
      action:"start",expectedTunnelId:tunnelId,reviewed:true,
    });
    expect(ui.node("named-tunnel-feedback").textContent).toContain("No Quick Tunnel");
  });
  it("stop requires a verified owned connector and never targets the Quick Tunnel",async()=>{
    const ui=setup({health:{connectorStatus:"verified_local_only",connectorPid:3210,
      anchorStatus:"not_verified"}});
    await flush();
    expect(ui.node("named-tunnel-stop").disabled).toBe(false);
    ui.listeners.get("named-tunnel-stop:click")!();
    await flush();await flush();
    expect(ui.invokes.find(v=>v.name==="named_tunnel_connector_action")?.args)
      .toEqual({action:"stop",expectedTunnelId:tunnelId,reviewed:true});
  });
  it("imports token through native file dialog and never reads token in JavaScript",async()=>{
    const ui=setup();await flush();
    await ui.listeners.get("named-tunnel-import-token:click")!();await flush();
    expect(ui.invokes.map(v=>v.name)).toEqual([
      "get_named_tunnel_health","pick_named_tunnel_token","get_named_tunnel_health",
    ]);
    expect(ui.dispatched).toContain("named-tunnel-settings-refresh");
    expect(JSON.stringify(ui.invokes)).not.toMatch(/TunnelSecret|--token /);
    expect(ui.node("named-tunnel-token-feedback").textContent).toContain("protected");
  });
  it("plan remains read-only, with no action or restart",async()=>{
    const ui=setup();await flush();
    ui.listeners.get("named-tunnel-plan:click")!();
    await flush();await flush();
    expect(ui.invokes.map(v=>v.name)).toEqual([
      "get_named_tunnel_health","plan_named_tunnel_connector",
    ]);
    expect(ui.node("named-tunnel-feedback").textContent).toContain("No process changed");
  });
});
