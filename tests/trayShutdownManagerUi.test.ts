import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const html=fs.readFileSync(path.resolve("apps/superagent-tray/ui/index.html"),"utf8");
const script=fs.readFileSync(path.resolve("apps/superagent-tray/ui/shutdown-manager.js"),"utf8");

function fixture(exitReady=false){
  return {previewId:"trusted-preview",createdAt:12345,exitReady,warning:null,services:[
    {id:"managed:guardian",label:"Guardian",kind:"managed",state:"active",port:7888,pid:212,
      ownerVerified:true,selectable:true,blocker:null,activeSessions:0,
      detail:"Verified owner"},
    {id:"mcp:8857:999",label:"MCP owner",kind:"mcp",state:"observed",port:8857,pid:999,
      ownerVerified:false,selectable:false,blocker:"Active sessions",activeSessions:8,
      detail:"Busy owner"},
    {id:"managed:vision",label:"Vision",kind:"managed",state:"inactive",port:8095,pid:null,
      ownerVerified:false,selectable:false,blocker:null,activeSessions:null,detail:"Stopped"},
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
    if(args.action==="execute")return {accepted:true,runId:"run-confirmed"};
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
      "shutdown-stop-selected","shutdown-progress","shutdown-feedback"])
      expect(html).toContain('id="'+id+'"');
    expect(html).toContain('role="dialog" aria-modal="true"');
    expect(html).toContain('src="./shutdown-manager.js"');
    expect(html).toContain('href="./shutdown-manager.css"');
    expect(script).not.toMatch(/innerHTML|eval\s*\(|taskkill|process\.kill/);
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
    expect(m.node("shutdown-progress-status").textContent).toContain("blockers");
    expect(m.calls.every(c=>c.action!=="execute")).toBe(true);
  });
});
