import {describe,expect,it} from "vitest";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const ROOT="apps/superagent-tray";
const script=fs.readFileSync(path.resolve(ROOT,"ui/titlebar.js"),"utf8");

function mount() {
  const nodes=new Map<string,any>();
  const callbacks=new Map<string,(e?:any)=>void>();
  const actions:string[]=[];
  const cls=new Set<string>();
  let maximized=false;
  const node=(id:string)=>{
    if (!nodes.has(id)) {
      const attr=new Map<string,string>();
      nodes.set(id,{
        id,hidden:false,disabled:false,textContent:"",
        addEventListener:(kind:string,cb:(e:any)=>void)=>callbacks.set(id+":"+kind,cb),
        setAttribute:(key:string,value:string)=>attr.set(key,value),
        getAttribute:(key:string)=>attr.get(key),
        querySelector:(selector:string)=>node(id+":"+selector),
      });
    }
    return nodes.get(id);
  };
  const context=vm.createContext({
    window:{
      __TAURI__:{core:{invoke:async(name:string,{action}:{action:string})=>{
        expect(name).toBe("tray_window_action");
        actions.push(action);
        if(action==="toggle-maximize") maximized=!maximized;
        return {maximized,minimized:action==="minimize"};
      }}},
      addEventListener:(name:string,cb:(e?:any)=>void)=>callbacks.set("window:"+name,cb),
    },
    document:{
      getElementById:node,
      addEventListener:(name:string,cb:(e?:any)=>void)=>callbacks.set("document:"+name,cb),
      documentElement:{classList:{
        toggle:(name:string,on:boolean)=>{
          if(on)cls.add(name);else cls.delete(name);
        }
      }}
    },
    Error,String,Boolean,Number,
  });
  vm.runInContext(script,context);
  const trigger=(id:string,type:string,e:any={})=>{
    const listener=callbacks.get(id+":"+type);
    if(!listener)throw new Error("Missing event "+id+":"+type);
    listener(e);
  };
  return {node,trigger,actions,cls,context};
}
const flush=async()=>{await new Promise(resolve=>setImmediate(resolve))};
const target={closest:(selector:string)=>selector==="#tray-titlebar-drag"?{}:null};
const pointer=(x:number,y:number,button=0,pointerType="mouse")=>({
  button,pointerType,pointerId:1,clientX:x,clientY:y,target,
});

describe("SuperAgent Tray frameless native window controls",()=>{
  it("disables Windows decorations but keeps native resizing and min/max support",()=>{
    const config=JSON.parse(fs.readFileSync(path.resolve(ROOT,"src-tauri/tauri.conf.json"),"utf8"));
    const w=config.app.windows.find((entry:any)=>entry.label==="main");
    expect(w).toMatchObject({
      decorations:false,resizable:true,minimizable:true,maximizable:true,
    });
    const html=fs.readFileSync(path.resolve(ROOT,"ui/index.html"),"utf8");
    expect(html).toContain('src="./titlebar.js"');
    for(const id of ["tray-titlebar","tray-titlebar-drag","tray-window-minimize",
      "tray-window-maximize","tray-window-close"]) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toContain('aria-label="Minimize window"');
    expect(html).toContain('aria-label="Maximize window"');
    expect(html).toContain('aria-label="Close window"');
  });

  it("minimizes and closes via native actions; does not call unrelated process controls",async()=>{
    const ui=mount(); await flush();
    expect(ui.actions).toEqual(["state"]);
    ui.trigger("tray-window-minimize","click");
    await flush();
    ui.trigger("tray-window-close","click");
    await flush();
    expect(ui.actions).toEqual(["state","minimize","close"]);
    expect(ui.actions).not.toContain("terminate-process");
  });

  it("maximizes, restores, updates icon, title, aria and CSS state",async()=>{
    const ui=mount(); await flush();
    const btn=ui.node("tray-window-maximize");
    ui.trigger("tray-window-maximize","click");await flush();
    expect(ui.actions).toContain("toggle-maximize");
    expect(btn.getAttribute("aria-label")).toBe("Restore window");
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    expect(ui.node("tray-window-maximize:.tray-icon-maximize").hidden).toBe(true);
    expect(ui.node("tray-window-maximize:.tray-icon-restore").hidden).toBe(false);
    expect(ui.cls.has("tray-window-maximized")).toBe(true);
    ui.trigger("tray-window-maximize","click");await flush();
    expect(btn.getAttribute("aria-label")).toBe("Maximize window");
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    expect(ui.cls.has("tray-window-maximized")).toBe(false);
  });

  it("starts drag only after primary mouse moves five pixels in titlebar",async()=>{
    const ui=mount();await flush();
    ui.trigger("tray-titlebar-drag","pointerdown",pointer(10,20));
    ui.trigger("document","pointermove",pointer(13,22));
    await flush();
    expect(ui.actions.filter(a=>a==="start-drag")).toHaveLength(0);
    ui.trigger("document","pointermove",pointer(16,20));
    await flush();
    expect(ui.actions.filter(a=>a==="start-drag")).toHaveLength(1);
    ui.trigger("document","pointermove",pointer(26,20));await flush();
    expect(ui.actions.filter(a=>a==="start-drag")).toHaveLength(1);
  });

  it("does not drag on right click, touch, pointer released, maximized window or controls",async()=>{
    const ui=mount();await flush();
    ui.trigger("tray-titlebar-drag","pointerdown",pointer(10,20,2));
    ui.trigger("document","pointermove",pointer(55,20,2));await flush();
    ui.trigger("tray-titlebar-drag","pointerdown",pointer(10,20,0,"touch"));
    ui.trigger("document","pointermove",pointer(55,20,0,"touch"));await flush();
    ui.trigger("tray-titlebar-drag","pointerdown",pointer(10,20));
    ui.trigger("document","pointerup",pointer(10,20));
    ui.trigger("document","pointermove",pointer(55,20));await flush();
    expect(ui.actions).not.toContain("start-drag");
    ui.trigger("tray-window-maximize","click");await flush();
    ui.trigger("tray-titlebar-drag","pointerdown",pointer(10,20));
    ui.trigger("document","pointermove",pointer(55,20));await flush();
    expect(ui.actions).not.toContain("start-drag");
  });

  it("double-click on the titlebar toggles maximize without accidentally dragging",async()=>{
    const ui=mount();await flush();
    ui.trigger("tray-titlebar-drag","pointerdown",pointer(10,20));
    ui.trigger("tray-titlebar-drag","dblclick",{button:0,target});await flush();
    ui.trigger("document","pointermove",pointer(55,20));await flush();
    expect(ui.actions.filter(a=>a==="toggle-maximize")).toHaveLength(1);
    expect(ui.actions).not.toContain("start-drag");
    ui.trigger("tray-titlebar-drag","dblclick",{button:0,target});await flush();
    expect(ui.actions.filter(a=>a==="toggle-maximize")).toHaveLength(2);
  });

  it("synchronizes maximize button if OS window state changes",async()=>{
    const ui=mount();await flush();
    ui.trigger("tray-window-maximize","click");await flush();
    ui.trigger("window","resize");await flush();
    expect(ui.node("tray-window-maximize").getAttribute("aria-label")).toBe("Restore window");
    expect(ui.actions.at(-1)).toBe("state");
  });
});
