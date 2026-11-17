import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const html=fs.readFileSync(path.resolve("apps/superagent-tray/ui/index.html"),"utf8");
const script=fs.readFileSync(path.resolve("apps/superagent-tray/ui/shutdown-manager.js"),"utf8");
const native=fs.readFileSync(path.resolve("apps/superagent-tray/src-tauri/src/shutdown_manager.rs"),"utf8");
const ownerControl=fs.readFileSync(path.resolve("apps/superagent-tray/src-tauri/src/runtime_control.rs"),"utf8");

function fixture(exitReady=false){
  return {previewId:"trusted-preview",createdAt:12345,exitReady,warning:null,services:[
    {id:"managed:guardian",label:"Guardian",kind:"managed",state:"active",port:7888,pid:212,
      ownerVerified:true,selectable:true,forceSelectable:false,blocker:null,activeSessions:0,
      detail:"Verified owner"},
    {id:"mcp:8857:999",label:"MCP owner",kind:"mcp",state:"observed",port:8857,pid:999,
      ownerVerified:false,selectable:false,forceSelectable:false,blocker:"Active sessions",activeSessions:8,
      detail:"Busy owner"},
    {id:"managed:vision",label:"Vision",kind:"managed",state:"inactive",port:8095,pid:null,
      ownerVerified:false,selectable:false,forceSelectable:false,blocker:null,activeSessions:null,detail:"Stopped"},
  ]};
}
function mount(preview=fixture()){
  const nodes=new Map<string,any>(), listeners=new Map<string,Function>();
  const calls:any[]=[];
  const element=(tag:string)=>{
    const e:any={tag,className:"",textContent:"",disabled:false,hidden:false,
      checked:false,type:"",value:"",dataset:{},children:[],attributes:{},handlers:{},
      focus:vi.fn(), append(...children:any[]){e.children.push(...children);},
      replaceChildren(...children:any[]){e.children=children;},
      addEventListener(name:string,handler:Function){e.handlers[name]=handler;},
      setAttribute(name:string,value:string){e.attributes[name]=value;}};
    return e;
  };
  const node=(id:string)=>{
    if(!nodes.has(id)){const e=element("div");e.id=id;nodes.set(id,e);}
    return nodes.get(id);
  };
  const invoke=vi.fn(async(command:string,args:any)=>{
    expect(command).toBe("shutdown_manager_action");
    calls.push(args);
    if(args.action==="preview")return {preview};
    if(args.action==="status")return {busy:false,progress:null};
    if(args.action==="execute"||args.action==="force_all")
      return {accepted:true,runId:"run-confirmed"};
    throw Error("Unexpected request");
  });
  const window:any={
    __TAURI__:{core:{invoke},event:{listen:vi.fn((name:string,fn:Function)=>{
      listeners.set(name,fn);return Promise.resolve(()=>{});
    })}},
  };
  const context=vm.createContext({
    document:{getElementById:node,createElement:element},window,
    Set,Array,String,Number,Math,Promise,Error,console,
    setInterval:vi.fn(()=>17),clearInterval:vi.fn(),
  });
  vm.runInContext(script,context);
  return {node,window,invoke,calls,listeners,
    async open(){await window.__superagentShutdownManagerOpen();},
    click(id:string){const handler=node(id).handlers.click;expect(handler).toBeTypeOf("function");return handler({target:node(id)});},
  };
}

describe("native Shutdown Manager UI",()=>{
  it("mounts one accessible dialog, bounded progress and CSP-compatible files",()=>{
    for(const id of ["shutdown-manager-dialog","shutdown-services","shutdown-exit-all",
      "shutdown-stop-selected","shutdown-force-all","shutdown-force-confirm",
      "shutdown-progress","shutdown-feedback"])
      expect(html).toContain('id="'+id+'"');
    expect(html).toContain('role="dialog" aria-modal="true"');
    expect(html).toContain('src="./shutdown-manager.js"');
    expect(html).toContain('href="./shutdown-manager.css"');
    expect(script).not.toMatch(/innerHTML|eval\s*\(|taskkill|process\.kill/);
    expect(native).toContain('force_confirmation.as_deref()!=Some("FORCE STOP ALL")');
    expect(native).toContain('owner.source=="registry"');
    expect(native).toContain('process.start_time())!=item.process_started_at');
    expect(ownerControl).toContain('"/_internal/owner/stop?force=1"');
    expect(ownerControl).toContain('read_lease(dir, port, pid)');
  });
  it("previews owner states read-only, and excludes unverified services from selection",async()=>{
    const m=mount();
    await m.open();
    expect(m.calls.map(c=>c.action)).toEqual(["status","preview"]);
    expect(m.node("shutdown-active-count").textContent).toBe("2");
    expect(m.node("shutdown-ready-count").textContent).toBe("1");
    expect(m.node("shutdown-blocked-count").textContent).toBe("1");
    const rows=m.node("shutdown-services").children;
    expect(rows).toHaveLength(3);
    expect(rows[0].children[0].checked).toBe(true);
    expect(rows[1].children[0].disabled).toBe(true);
    expect(m.node("shutdown-stop-selected").disabled).toBe(false);
    expect(m.node("shutdown-exit-all").disabled).toBe(true);
  });
  it("submits only selected verified owner identifiers through native execute",async()=>{
    const m=mount();
    await m.open();
    await m.click("shutdown-stop-selected");
    expect(m.calls.at(-1)).toMatchObject({action:"execute",previewId:"trusted-preview",
      selected:["managed:guardian"],exitAfter:false});
    expect(m.node("shutdown-progress").hidden).toBe(false);
  });
  it("allows full exit only when every observed live owner is selectable and chosen",async()=>{
    const only=fixture(true);
    only.services.splice(1,1);
    const m=mount(only);
    await m.open();
    expect(m.node("shutdown-exit-all").disabled).toBe(false);
    const row=m.node("shutdown-services").children[0];
    row.children[0].checked=false;
    row.children[0].handlers.change();
    expect(m.node("shutdown-exit-all").disabled).toBe(true);
  });
  it("permits exit when every service is already stopped",async()=>{
    const idle=fixture(true);
    idle.services=[idle.services[2]];
    const m=mount(idle);
    await m.open();
    expect(m.node("shutdown-exit-all").disabled).toBe(false);
    await m.click("shutdown-exit-all");
    const action=m.calls.find(c=>c.action==="execute");
    expect(action).toMatchObject({action:"execute",selected:[],exitAfter:true});
  });
  it("requires an exact typed phrase and native approval before Force Stop All",async()=>{
    const owned=fixture();
    owned.services[1].forceSelectable=true; // authenticated busy MCP owner
    owned.services[0].forceSelectable=true; // owner-verified managed guardian
    const m=mount(owned);
    await m.open();
    expect(m.node("shutdown-services").children[1].children[2].textContent).toBe("Force ready");
    expect(m.node("shutdown-services").children[1].dataset.state).toBe("force");
    expect(m.node("shutdown-force-all").disabled).toBe(true);
    const phrase=m.node("shutdown-force-confirm");
    phrase.value="force stop all";
    phrase.handlers.input();
    expect(m.node("shutdown-force-all").disabled).toBe(true);
    expect(m.calls.some(c=>c.action==="force_all")).toBe(false);
    phrase.value="FORCE STOP ALL";phrase.handlers.input();
    expect(m.node("shutdown-force-all").disabled).toBe(false);
    await m.click("shutdown-force-all");
    const action=m.calls.find(c=>c.action==="force_all");
    expect(action).toMatchObject({
      action:"force_all",previewId:"trusted-preview",
      forceConfirmation:"FORCE STOP ALL",
    });
    expect(action.selected).toBeUndefined();
    expect(action.exitAfter).toBeUndefined();
    expect(action.pid).toBeUndefined();
    expect(m.node("shutdown-progress").hidden).toBe(false);
    expect(m.node("shutdown-progress-status").textContent).toContain("in progress");
  });
  it("never enables force control when only foreign/unverified owners remain",async()=>{
    const inventory=fixture();
    inventory.services[0].forceSelectable=false;
    inventory.services[1].forceSelectable=false;
    const m=mount(inventory);await m.open();
    m.node("shutdown-force-confirm").value="FORCE STOP ALL";
    m.node("shutdown-force-confirm").handlers.input();
    expect(m.node("shutdown-force-all").disabled).toBe(true);
    expect(m.calls.every(c=>c.action!=="force_all")).toBe(true);
  });
  it("clears typed force authorization after refreshing the owner preview",async()=>{
    const inventory=fixture();
    inventory.services[1].forceSelectable=true;
    const m=mount(inventory);await m.open();
    m.node("shutdown-force-confirm").value="FORCE STOP ALL";
    m.node("shutdown-force-confirm").handlers.input();
    expect(m.node("shutdown-force-all").disabled).toBe(false);
    await m.click("shutdown-refresh");
    await new Promise(resolve=>setTimeout(resolve,20));
    expect(m.node("shutdown-force-confirm").value).toBe("");
    expect(m.node("shutdown-force-all").disabled).toBe(true);
  });
  it("renders progress through textContent and never replays a blocked operation",async()=>{
    const m=mount();
    await m.open();
    const cb=m.listeners.get("shutdown-manager-progress");
    expect(cb).toBeTypeOf("function");
    cb!({payload:{runId:"run-1",stage:"partial",error:"SHUTDOWN_OWNER_CHANGED",
      steps:[{id:"managed:guardian",label:"<script>bad()</script>",
        status:"blocked",message:"Identity changed"}]}});
    const item=m.node("shutdown-progress-steps").children[0];
    expect(item.children[0].textContent).toBe("<script>bad()</script>");
    expect(m.node("shutdown-progress-status").textContent).toContain("remaining owners");
    expect(m.calls.every(c=>c.action!=="execute")).toBe(true);
  });
});
