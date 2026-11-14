import {describe,expect,it,vi} from "vitest";
import fs from "node:fs";
import vm from "node:vm";

const script=fs.readFileSync("apps/superagent-tray/ui/desktop-input-trust.js","utf8");

class Node {
  value="";checked=false;disabled=false;textContent="";className="";type="";
  children:Node[]=[];attributes=new Map<string,string>();
  events=new Map<string,Function>();
  addEventListener(event:string,callback:Function){this.events.set(event,callback);}
  setAttribute(key:string,value:string){this.attributes.set(key,value);}
  append(...nodes:Node[]){this.children.push(...nodes);}
  replaceChildren(...nodes:Node[]){this.children=nodes;}
  click(){this.events.get("click")?.();}
}
const windowTarget={pid:123,nativeId:"hwnd-321",title:"Antigravity Editor",application:"Antigravity"};
function setup(invalidInventory=false){
  let policy:any={version:1,mode:"trusted",targets:[]};
  const nodes=new Map<string,Node>();
  const requested:Array<{name:string,args?:any}>=[];
  const listeners=new Map<string,Function>();
  const node=(name:string)=>{if(!nodes.has(name))nodes.set(name,new Node());return nodes.get(name)!;};
  node("desktop-trust-window").value="";
  node("desktop-trust-duration").value="10";
  const invoke=vi.fn(async(name:string,args?:any)=>{
    requested.push({name,args});
    if(name==="get_desktop_input_policy")return policy;
    if(name==="list_desktop_input_windows")return invalidInventory?{success:false}:{
      success:true,windows:[windowTarget],
    };
    if(name==="set_desktop_input_mode"){
      policy={...policy,mode:args.mode,targets:args.mode==="off"?[]:policy.targets};
      return policy;
    }
    if(name==="trust_desktop_input_window"){
      policy={...policy,targets:[{...windowTarget,approvedAt:Date.now(),
        expiresAt:Date.now()+args.durationMinutes*60000}]};
      return policy;
    }
    if(name==="revoke_desktop_input_window"){
      policy={...policy,targets:policy.targets.filter((x:any)=>
        x.pid!==args.pid||x.nativeId!==args.nativeId)};
      return policy;
    }
    if(name==="revoke_all_desktop_input_windows"){
      policy={...policy,targets:[]};
      return policy;
    }
    throw Error("Unexpected command "+name);
  });
  const context=vm.createContext({
    document:{
      getElementById:node,
      createElement:()=>new Node(),
    },
    window:{
      __TAURI__:{core:{invoke}},
      addEventListener:(name:string,callback:Function)=>listeners.set(name,callback),
      TrayFeedback:{notify:vi.fn()},
    },
    location:{hash:"#settings"},
    Number,String,Array,Boolean,Object,Date,Math,Error,
  });
  vm.runInContext(script,context);
  return {node,requested,invoke,listeners,context,getPolicy:()=>policy};
}
const flush=async()=>{for(let i=0;i<3;i++)await new Promise(resolve=>setImmediate(resolve));};

describe("SuperAgent native Security Approval Manager Trusted UI",()=>{
  it("packages a discoverable settings panel and native commands",()=>{
    const html=fs.readFileSync("apps/superagent-tray/ui/index.html","utf8");
    const rust=fs.readFileSync("apps/superagent-tray/src-tauri/src/main.rs","utf8");
    expect(html).toContain('src="./desktop-input-trust.js"');
    expect(html).toContain('href="./desktop-input-trust.css"');
    for(const id of ["desktop-trust-panel","desktop-trust-mode","desktop-trust-mode-save",
      "desktop-trust-window","desktop-trust-refresh","desktop-trust-duration",
      "desktop-trust-add","desktop-trust-targets","desktop-trust-revoke-all",
      "desktop-trust-feedback"]){
      expect(html).toContain(`id="${id}"`);
    }
    for(const command of ["get_desktop_input_policy","set_desktop_input_mode",
      "list_desktop_input_windows","trust_desktop_input_window",
      "revoke_desktop_input_window","revoke_all_desktop_input_windows"]){
      expect(rust).toContain("desktop_input_trust::"+command);
    }
  });
  it("begins with zero privileges and prevents trusting before OS window discovery",async()=>{
    const ui=setup();await flush();
    expect(ui.node("desktop-trust-mode").value).toBe("trusted");
    expect(ui.getPolicy().targets).toHaveLength(0);
    expect(ui.node("desktop-trust-add").disabled).toBe(true);
    expect(ui.node("desktop-trust-targets").children[0].textContent).toContain("Input stays blocked");
  });
  it("discovers exact native windows and submits a bounded approval request to Tauri",async()=>{
    const ui=setup();await flush();
    ui.node("desktop-trust-refresh").events.get("click")?.();
    await flush();
    expect(ui.node("desktop-trust-window").children).toHaveLength(2);
    ui.node("desktop-trust-window").value="0";
    ui.node("desktop-trust-window").events.get("change")?.();
    expect(ui.node("desktop-trust-add").disabled).toBe(false);
    ui.node("desktop-trust-add").events.get("click")?.();
    await flush();
    expect(ui.requested).toContainEqual({
      name:"trust_desktop_input_window",
      args:{pid:123,nativeId:"hwnd-321",durationMinutes:10},
    });
    expect(ui.node("desktop-trust-targets").children).toHaveLength(1);
    expect(ui.node("desktop-trust-targets").children[0].children[0].children[0].textContent)
      .toContain("Antigravity");
    expect(script).not.toContain("innerHTML");
    expect(script).not.toContain("localStorage");
    expect(script).not.toContain("grantConsent(");
  });
  it("revokes one target or all targets and disables Trusted mode",async()=>{
    const ui=setup();await flush();
    ui.node("desktop-trust-refresh").events.get("click")?.();await flush();
    ui.node("desktop-trust-window").value="0";
    ui.node("desktop-trust-add").events.get("click")?.();await flush();
    const revoke=ui.node("desktop-trust-targets").children[0].children[1];
    revoke.events.get("click")?.();await flush();
    expect(ui.getPolicy().targets).toHaveLength(0);
    ui.node("desktop-trust-add").events.get("click")?.();await flush();
    ui.node("desktop-trust-revoke-all").events.get("click")?.();await flush();
    expect(ui.getPolicy().targets).toHaveLength(0);
    ui.node("desktop-trust-mode").value="off";
    ui.node("desktop-trust-mode-save").events.get("click")?.();await flush();
    expect(ui.getPolicy().mode).toBe("off");
    expect(ui.node("desktop-trust-add").disabled).toBe(true);
  });
  it("fails closed if verified OS window inventory is missing",async()=>{
    const ui=setup(true);await flush();
    ui.node("desktop-trust-refresh").events.get("click")?.();await flush();
    expect(ui.node("desktop-trust-add").disabled).toBe(true);
    expect(ui.requested.some(x=>x.name==="trust_desktop_input_window")).toBe(false);
    expect(ui.node("desktop-trust-feedback").textContent).toContain("unavailable");
  });
});
