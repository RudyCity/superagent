import {describe, it, expect, vi} from "vitest";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const script=fs.readFileSync(
  path.resolve("apps/superagent-tray/ui/settings.js"),"utf8"
);
const original={
  version:1,autoLaunchWithSuperagent:true,notificationsEnabled:true,
  closeToTray:true,runtimeScanSeconds:20,jobsRefreshSeconds:30,
  notificationPollSeconds:15,startupPage:"jobs",
};

function setup(options:{initialHash?:boolean;stored?:Record<string,unknown>;rejectSave?:boolean}={}) {
  const nodes=new Map<string,any>();
  const listeners=new Map<string, (event?:unknown)=>unknown>();
  const requested:Array<{name:string;args?:unknown}>=[];
  const dispatched:Array<{type:string;detail?:any}>=[];
  const pages:string[]=[];
  const node=(id:string)=>{
    if(!nodes.has(id)) nodes.set(id,{
      value:"",checked:false,disabled:false,textContent:"",
      addEventListener:(event:string,fn:(e:unknown)=>unknown)=>listeners.set(id+":"+event,fn),
    });
    return nodes.get(id);
  };
  const stored={...original,...options.stored};
  const context=vm.createContext({
    document:{getElementById:node},
    window:{
      __superagentTrayHadInitialHash:options.initialHash??false,
      navigateToPage:(page:string)=>pages.push(page),
      __TAURI__:{
        core:{invoke:async(name:string,args?:unknown)=>{
          requested.push({name,args});
          if(name==="get_tray_settings")return stored;
          if(name==="set_tray_settings"){
            if(options.rejectSave)throw new Error("Access denied");
            return (args as any)?.settings;
          }
          throw new Error("Unexpected native command");
        }},
        event:{listen:async()=>()=>{}},
      },
      dispatchEvent:(e:{type:string;detail:any})=>{
        dispatched.push({type:e.type,detail:e.detail});
      },
      addEventListener:(event:string,fn:(e:unknown)=>unknown)=>listeners.set("window:"+event,fn),
    },
    CustomEvent:class{
      constructor(public type:string,public opts:{detail?:any}){}
      get detail(){return this.opts.detail}
    },
    Number,String,Array,Object,Boolean,Error,
  });
  vm.runInContext(script,context);
  return {node,listeners,requested,dispatched,pages,context};
}
const flush=async()=>{await new Promise(resolve=>setImmediate(resolve))};
describe("SuperAgent Tray Settings UI",()=>{
  it("has a real Settings navigation destination and every bound form field in the packaged HTML",()=>{
    const html=fs.readFileSync(path.resolve("apps/superagent-tray/ui/index.html"),"utf8");
    expect(html).toContain('src="./settings.js"');
    expect(html).toContain('data-page="settings"');
    expect(html).toContain('id="page-settings"');
    for(const id of ["tray-settings-form","settings-save","settings-defaults",
      "settings-feedback","settings-auto-launch","settings-notifications",
      "settings-close-to-tray","settings-runtime-scan","settings-jobs-refresh",
      "settings-notification-poll","settings-startup-page"]) {
      expect(html).toContain(`id="${id}"`);
    }
  });
  it("loads native preferences, validates their schema and chooses configured startup page",async()=>{
    const ui=setup({stored:{autoLaunchWithSuperagent:false,runtimeScanSeconds:60,
      notificationsEnabled:false,startupPage:"runtime"}});
    await flush();
    expect(ui.requested[0].name).toBe("get_tray_settings");
    expect(ui.node("settings-auto-launch").checked).toBe(false);
    expect(ui.node("settings-notifications").checked).toBe(false);
    expect(ui.node("settings-runtime-scan").value).toBe("60");
    expect(ui.pages).toEqual(["runtime"]);
    expect(ui.dispatched.at(-1)).toMatchObject({type:"tray-settings-changed",
      detail:{runtimeScanSeconds:60,notificationsEnabled:false}});
  });
  it("never overrides an explicit existing deep link",async()=>{
    const ui=setup({initialHash:true,stored:{startupPage:"runtime"}});
    await flush();
    expect(ui.pages).toEqual([]);
  });
  it("saves only recognized preference keys and applies refresh intervals immediately",async()=>{
    const ui=setup();
    await flush();
    ui.node("settings-auto-launch").checked=false;
    ui.node("settings-notifications").checked=false;
    ui.node("settings-close-to-tray").checked=false;
    ui.node("settings-runtime-scan").value="120";
    ui.node("settings-jobs-refresh").value="60";
    ui.node("settings-notification-poll").value="30";
    ui.node("settings-startup-page").value="history";
    const submit=ui.listeners.get("tray-settings-form:submit")!;
    await submit({preventDefault:()=>{}});
    const save=ui.requested.find(r=>r.name==="set_tray_settings");
    expect(save).toBeDefined();
    expect((save?.args as any).settings).toEqual({
      ...original,autoLaunchWithSuperagent:false,notificationsEnabled:false,
      closeToTray:false,runtimeScanSeconds:120,jobsRefreshSeconds:60,
      notificationPollSeconds:30,startupPage:"history",
    });
    expect(ui.dispatched.at(-1)?.detail).toMatchObject({
      runtimeScanSeconds:120,jobsRefreshSeconds:60,notificationsEnabled:false,
    });
    expect(ui.node("settings-feedback").textContent).toContain("Settings saved");
  });
  it("invalid intervals fail locally and do not reach native storage",async()=>{
    const ui=setup();await flush();
    ui.node("settings-runtime-scan").value="1";
    await ui.listeners.get("tray-settings-form:submit")!({preventDefault(){}});
    expect(ui.requested.filter(r=>r.name==="set_tray_settings")).toHaveLength(0);
    expect(ui.node("settings-feedback").textContent).toContain("NOT saved");
  });
  it("Restore Defaults previews without modifying settings until explicit Save",async()=>{
    const ui=setup({stored:{autoLaunchWithSuperagent:false,closeToTray:false,runtimeScanSeconds:120}});
    await flush();
    await ui.listeners.get("settings-defaults:click")!();
    expect(ui.node("settings-auto-launch").checked).toBe(true);
    expect(ui.node("settings-close-to-tray").checked).toBe(true);
    expect(ui.node("settings-runtime-scan").value).toBe("20");
    expect(ui.requested.filter(r=>r.name==="set_tray_settings")).toHaveLength(0);
    expect(ui.node("settings-feedback").textContent).toContain("Press Save");
  });
  it("does not falsely report success or notify refresh timers on native save failure",async()=>{
    const ui=setup({rejectSave:true});await flush();
    const previous=ui.dispatched.length;
    await ui.listeners.get("tray-settings-form:submit")!({preventDefault(){}});
    expect(ui.dispatched.length).toBe(previous);
    expect(ui.node("settings-feedback").textContent).toContain("NOT saved");
    expect(ui.node("settings-save").disabled).toBe(false);
  });
});
