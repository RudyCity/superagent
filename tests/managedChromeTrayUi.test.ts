import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import vm from "node:vm";
const root="apps/superagent-tray";
const code=fs.readFileSync(root+"/ui/managed-chrome.js","utf8");
const html=fs.readFileSync(root+"/ui/index.html","utf8");
const rust=fs.readFileSync(root+"/src-tauri/src/main.rs","utf8");
const server=fs.readFileSync("src/serverRoutes.ts","utf8");
const flush=async()=>{for(let i=0;i<6;i++)await new Promise<void>(resolve=>setImmediate(resolve));};

function mount() {
  const elements=new Map<string,any>();
  const calls:Array<{name:string;action:string;payload:any}>=[];
  const replies:Record<string,any>={
    status:{success:true,port:9222,status:"stopped",occupied:false,owned:false},
    launch:{success:true,port:9222,status:"healthy",occupied:true,owned:true,
      canStop:true,pid:44123,recordId:"owned-record-1",launched:true},
    stop:{success:true,port:9222,status:"stopped",stopped:true,owned:false},
  };
  const byId=(id:string)=>{
    if(!elements.has(id)){
      const listeners=new Map<string,Function>();
      const node:any={
        textContent:"",value:"",dataset:{},disabled:false,
        addEventListener:(name:string,cb:Function)=>listeners.set(name,cb),
        trigger:(name:string,args:any={preventDefault:()=>{}})=>listeners.get(name)?.(args),
      };
      if(id==="managed-chrome-port")node.value="9222";
      if(id==="managed-chrome-mode")node.value="headed";
      if(id==="managed-chrome-url")node.value="https://tab.ub.ac.id/";
      elements.set(id,node);
    }
    return elements.get(id);
  };
  const invoke=vi.fn(async(name:string,args:{action:string;payload:any})=>{
    calls.push({name,action:args.action,payload:args.payload});
    return {...replies[args.action]};
  });
  const ctx=vm.createContext({
    document:{readyState:"complete",getElementById:byId,addEventListener:()=>{}},
    window:{location:{hash:"#settings"},addEventListener:()=>{},
      __TAURI__:{core:{invoke}}},
    URL,Number,String,Object,Array,Promise,Error,
  });
  vm.runInContext(code,ctx);
  return {byId,calls,replies,invoke,refresh:()=>(ctx as any).window.__superagentManagedChromeRefresh()};
}
describe("Managed Chrome CDP Tray",()=>{
  it("registers one real runtime form and fixed native lifecycle IPC",()=>{
    for(const id of [
      "managed-chrome-form","managed-chrome-port","managed-chrome-mode",
      "managed-chrome-url","managed-chrome-launch","managed-chrome-stop",
      "managed-chrome-status","managed-chrome-pid","managed-chrome-feedback",
    ])expect(html).toContain('id="'+id+'"');
    expect(html).toContain('src="./managed-chrome.js"');
    expect(html).toContain('href="./managed-chrome.css"');
    expect(fs.readFileSync(root+"/ui/app.js","utf8"))
      .toContain("window.__superagentManagedChromeRefresh?.()");
    expect(rust).toContain("async fn managed_chrome_action(");
    expect(rust).toContain("managed_chrome_action,");
    expect(rust).toContain('"/api/desktop/chrome-runtime"');
    expect(server).toContain('pathname === "/api/desktop/chrome-runtime"');
    expect(server).toContain("MANAGED_CDP_LOCAL_TRAY_ONLY");
    expect(code).not.toMatch(/fetch\s*\(|localStorage|sessionStorage|child_process/);
  });
  it("uses native status then launch and exact-PID stop without direct browser access",async()=>{
    const ui=mount();
    await ui.refresh();await flush();
    expect(ui.calls[0]).toMatchObject({name:"managed_chrome_action",action:"status",payload:{port:9222}});
    expect(ui.byId("managed-chrome-stop").disabled).toBe(true);
    ui.byId("managed-chrome-form").trigger("submit");
    await flush();
    const launch=ui.calls.find(c=>c.action==="launch");
    expect(launch?.payload).toMatchObject({
      port:9222,mode:"headed",url:"https://tab.ub.ac.id/",
    });
    expect(launch?.payload.confirm).toBeUndefined();
    ui.replies.status={...ui.replies.launch,targetCount:1,browserVersion:"Chrome/136"};
    await ui.refresh();await flush();
    expect(ui.byId("managed-chrome-pid").textContent).toBe("44123");
    expect(ui.byId("runtime-tab-chrome-count").textContent).toBe("1");
    expect(ui.byId("managed-chrome-stop").disabled).toBe(false);
    ui.byId("managed-chrome-stop").trigger("click");
    await flush();
    expect(ui.calls.find(c=>c.action==="stop")?.payload)
      .toMatchObject({port:9222,expectedPid:44123,recordId:"owned-record-1"});
  });
  it("shows a verified owned PID as stoppable when CDP is offline",async()=>{
    const ui=mount();
    ui.replies.status={
      success:true,port:9222,occupied:false,owned:true,canStop:true,
      status:"stopped",pid:44123,recordId:"owned-record-1",
    };
    await ui.refresh();await flush();
    expect(ui.byId("managed-chrome-status").textContent).toContain("CDP offline");
    expect(ui.byId("managed-chrome-stop").disabled).toBe(false);
    ui.byId("managed-chrome-stop").trigger("click");await flush();
    expect(ui.calls.some(c=>c.action==="stop" && c.payload.expectedPid===44123)).toBe(true);
  });
  it("does not permit stop of foreign ports or unsafe startup URLs",async()=>{
    const ui=mount();
    ui.replies.status={success:true,port:9222,occupied:true,owned:false,status:"healthy"};
    await ui.refresh();await flush();
    expect(ui.byId("managed-chrome-stop").disabled).toBe(true);
    ui.byId("managed-chrome-stop").trigger("click");
    await flush();
    expect(ui.calls.filter(c=>c.action==="stop")).toHaveLength(0);
    ui.byId("managed-chrome-url").value="file:///C:/private.txt";
    ui.byId("managed-chrome-form").trigger("submit");
    await flush();
    expect(ui.calls.filter(c=>c.action==="launch")).toHaveLength(0);
  });
});
