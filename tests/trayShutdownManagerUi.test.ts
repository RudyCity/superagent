import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const html=fs.readFileSync(path.resolve("apps/superagent-tray/ui/index.html"),"utf8");
const script=fs.readFileSync(path.resolve("apps/superagent-tray/ui/shutdown-manager.js"),"utf8");
const css=fs.readFileSync(path.resolve("apps/superagent-tray/ui/shutdown-manager.css"),"utf8");
const native=fs.readFileSync(path.resolve("apps/superagent-tray/src-tauri/src/shutdown_manager.rs"),"utf8");

function fixture(){
  return {previewId:"preview-1",createdAt:12345,exitReady:false,warning:null,services:[
    {id:"process:101",label:"SuperAgent CLI",kind:"process",state:"observed",pid:101,port:null,
      ownerVerified:false,selectable:false,forceSelectable:false,manualKillSelectable:true,
      processName:"bun.exe",processPath:"C:\\Tools\\bun.exe",detail:"Workspace: project-a"},
    {id:"supervisor:7888:202",label:"Core Supervisor",kind:"core-supervisor",state:"unverified",
      pid:202,port:7888,ownerVerified:false,selectable:false,forceSelectable:false,
      manualKillSelectable:true,processName:"bun.exe",processPath:"C:\\Tools\\bun.exe",
      detail:"Unverified owner"},
    {id:"protected:303",label:"Protected system process",kind:"process",state:"observed",
      pid:303,port:null,ownerVerified:false,selectable:false,forceSelectable:false,
      manualKillSelectable:false,processName:"svchost.exe",processPath:"C:\\Windows\\svchost.exe",
      detail:"Protected"},
    {id:"duplicate:101",label:"Duplicate CLI service",kind:"managed",state:"active",
      pid:101,port:9000,ownerVerified:true,selectable:true,forceSelectable:true,
      manualKillSelectable:true,processName:"bun.exe",processPath:"C:\\Tools\\bun.exe",
      detail:"Duplicate PID"},
  ]};
}

function mount(preview=fixture()){
  const nodes=new Map<string,any>(), listeners=new Map<string,Function>(), calls:any[]=[];
  const element=(tag:string)=>{
    const e:any={tag,className:"",textContent:"",disabled:false,hidden:false,
      checked:false,type:"",value:"",dataset:{},children:[],attributes:{},handlers:{},
      focus:vi.fn(),
      append(...children:any[]){e.children.push(...children);},
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
    if(args.action==="force_selected")return {accepted:true,runId:"force-run"};
    throw Error("Unexpected request");
  });
  const window:any={
    __TAURI__:{core:{invoke},event:{listen:vi.fn((name:string,fn:Function)=>{
      listeners.set(name,fn);return Promise.resolve(()=>{});
    })}},
  };
  const context=vm.createContext({
    document:{getElementById:node,createElement:element},window,
    Set,Map,Array,String,Number,Math,Promise,Error,console,
    setInterval:vi.fn(()=>17),clearInterval:vi.fn(),
  });
  vm.runInContext(script,context);
  return {node,window,invoke,calls,listeners,
    async open(){await window.__superagentShutdownManagerOpen();},
    click(id:string){
      const handler=node(id).handlers.click;
      expect(handler).toBeTypeOf("function");
      return handler({target:node(id)});
    },
  };
}

describe("simple force-selected Shutdown Manager",()=>{
  it("renders only the simple force controls",()=>{
    for(const id of [
      "shutdown-manager-dialog","shutdown-services","shutdown-select-all",
      "shutdown-clear","shutdown-refresh","shutdown-force-confirm",
      "shutdown-force-selected","shutdown-selection-count","shutdown-process-summary"
    ]) expect(html).toContain('id="'+id+'"');

    for(const removed of [
      "shutdown-stop-selected","shutdown-exit-all","shutdown-force-all",
      "shutdown-manual-kill","shutdown-bulk-graceful","shutdown-bulk-manual",
      "shutdown-manual-confirm","shutdown-manual-select-all"
    ]) expect(html).not.toContain('id="'+removed+'"');

    expect(html).toContain("Owner status is ignored");
    expect(html).toContain("FORCE SELECTED");
    expect(script).not.toMatch(/innerHTML|eval\s*\(|taskkill|process\.kill/);
    expect(css).toContain("backdrop-filter:none");
    expect(css).toContain("overflow:auto");
    expect(css).toContain("scrollbar-gutter:stable");
  });

  it("deduplicates rows by PID and ignores owner verification for force selection",async()=>{
    const m=mount();
    await m.open();
    expect(m.calls.map(c=>c.action)).toEqual(["status","preview"]);
    const rows=m.node("shutdown-services").children;
    expect(rows).toHaveLength(3);
    expect(rows[0].children[0].disabled).toBe(false);
    expect(rows[1].children[0].disabled).toBe(false);
    expect(rows[2].children[0].disabled).toBe(true);
    expect(m.node("shutdown-process-summary").textContent).toBe("2 forceable processes");
    expect(m.node("shutdown-selection-count").textContent).toBe("0 selected · 2 forceable");
  });

  it("selects all forceable PIDs and clears them in one click",async()=>{
    const m=mount();await m.open();
    await m.click("shutdown-select-all");
    expect(m.node("shutdown-selection-count").textContent).toBe("2 selected · 2 forceable");
    expect(m.node("shutdown-select-all").disabled).toBe(true);
    expect(m.node("shutdown-clear").disabled).toBe(false);

    await m.click("shutdown-clear");
    expect(m.node("shutdown-selection-count").textContent).toBe("0 selected · 2 forceable");
    expect(m.node("shutdown-select-all").disabled).toBe(false);
    expect(m.node("shutdown-clear").disabled).toBe(true);
  });

  it("requires FORCE SELECTED and sends only selected process ids",async()=>{
    const m=mount();await m.open();
    await m.click("shutdown-select-all");

    const phrase=m.node("shutdown-force-confirm");
    phrase.value="force selected";
    phrase.handlers.input();
    expect(m.node("shutdown-force-selected").disabled).toBe(true);

    phrase.value="FORCE SELECTED";
    phrase.handlers.input();
    expect(m.node("shutdown-force-selected").disabled).toBe(false);
    await m.click("shutdown-force-selected");

    const call=m.calls.find(c=>c.action==="force_selected");
    expect(call).toMatchObject({
      action:"force_selected",
      previewId:"preview-1",
      forceConfirmation:"FORCE SELECTED",
      selected:["process:101","supervisor:7888:202"],
    });
    expect(call).not.toHaveProperty("exitAfter");
    expect(call).not.toHaveProperty("ownerVerified");
    expect(m.node("shutdown-progress").hidden).toBe(false);
  });

  it("keeps the native backend owner-agnostic but protects critical OS and Tray processes",()=>{
    expect(native).toContain('"manual_kill" | "force_selected" =>');
    expect(native).toContain('let required_phrase=if action=="force_selected" {"FORCE SELECTED"}');
    expect(native).toContain("Owner provenance intentionally does not gate Force Selected");
    expect(native).toContain('manual_process_allowed(_kind:&str,pid:u32,name:&str)');
    expect(native).not.toContain('if kind=="cloudflare" {return base=="cloudflared";}');
    expect(native).toContain('"superagent-tray"');
    expect(native).toContain('"svchost"');
    expect(native).toContain("manual_process_identity_matches(item,process.start_time(),process.name(),");
  });

  it("updates progress without replaying a completed force operation",async()=>{
    const m=mount();await m.open();
    const cb=m.listeners.get("shutdown-manager-progress");
    expect(cb).toBeTypeOf("function");
    cb!({payload:{runId:"force-run",stage:"complete",exitAfter:false,error:null,steps:[{
      id:"process:101",label:"SuperAgent CLI · PID 101",status:"stopped",
      message:"PID 101 exit verified"
    }]}});
    expect(m.node("shutdown-progress-status").textContent)
      .toContain("verified stopped");
    expect(m.calls.filter(c=>c.action==="force_selected")).toHaveLength(0);
  });
});
