import {describe,expect,it,vi} from "vitest";
import vm from "node:vm";
import fs from "node:fs";
const code=fs.readFileSync("apps/superagent-tray/ui/access-manager.js","utf8");
class Element {
  tagName:string;id="";className="";placeholder="";type="";textContent="";hidden=false;disabled=false;checked=false;
  rel="";href="";src="";readOnly=false;dataset:Record<string,string>={};parentNode:Element|null=null;
  children:Element[]=[];events=new Map<string,Function>();attributes=new Map<string,string>();
  #value:string|undefined;
  constructor(tag:string){this.tagName=tag.toLowerCase();}
  get value():string{
    if(this.#value!==undefined)return this.#value;
    return this.tagName==="select"?this.children[0]?.value||"":"";
  }
  set value(v:string){this.#value=v;}
  get firstChild(){return this.children[0]||null;}
  get lastChild(){return this.children[this.children.length-1]||null;}
  addEventListener(name:string,fn:Function){this.events.set(name,fn);}
  setAttribute(k:string,v:string){this.attributes.set(k,v);}
  append(...nodes:Element[]){for(const n of nodes){this.children.push(n);n.parentNode=this;}}
  appendChild(n:Element){this.append(n);return n;}
  replaceChildren(...nodes:Element[]){this.children=[];this.append(...nodes);}
  insertBefore(node:Element,old:Element){const i=this.children.indexOf(old);if(i<0)throw Error("not child");this.children.splice(i,0,node);node.parentNode=this;}
  click(){this.events.get("click")?.();}
  change(){this.events.get("change")?.();}
  input(){this.events.get("input")?.();}
}
const discovered={pid:35416,nativeId:"10553336",title:"Antigravity editor",application:"Antigravity"};
const app={platform:"win32",executablePath:"C:\\Apps\\Antigravity.exe",sha256:"f".repeat(64)};
const flush=async()=>{for(let i=0;i<6;i++)await new Promise(resolve=>setImmediate(resolve));};
function boot(nativeEnabled=true){
  const parent=new Element("section");parent.id="settings-subpage-security";
  const old=new Element("section");old.id="desktop-trust-panel";parent.append(old);
  const listeners=new Map<string,Function>();
  let policy:any={version:2,defaultEffect:"deny",rules:[]};
  const calls:{name:string,args:any}[]=[];
  const invoke=vi.fn(async(name:string,args:any)=>{
    calls.push({name,args});
    if(name==="get_permanent_access_registry"){
      if(!nativeEnabled)throw Error("old Tray");
      return policy;
    }
    if(name==="list_desktop_input_windows")return {success:true,windows:[discovered]};
    if(name==="pick_permanent_access_path"){
      return args.directory?"G:/project/tryout-online":"G:/project/tryout-online/.env";
    }
    if(name==="register_permanent_access_rule"){
      policy={...policy,rules:[...policy.rules,{
        id:"abc",kind:args.kind,effect:args.effect,app,operations:args.operations,
        scope:args.kind==="file"
          ?{path:args.filePath,recursive:args.recursive}
          :args.exactWindow?{windowTitle:discovered.title}:{},
      }]};
      return policy;
    }
    if(name==="revoke_permanent_access_rule"){
      policy={...policy,rules:policy.rules.filter((r:any)=>r.id!==args.id)};
      return policy;
    }
    throw Error("unknown native command");
  });
  const document={
    readyState:"complete",
    getElementById(id:string):Element|null{
      const walk=(n:Element):Element|null=>n.id===id?n:n.children.map(walk).find(Boolean)||null;
      return walk(parent);
    },
    createElement:(tag:string)=>new Element(tag),
  };
  const window={__TAURI__:{core:{invoke}},addEventListener:(k:string,f:Function)=>listeners.set(k,f)};
  vm.runInNewContext(code,{document,window,location:{hash:"#settings"},
    Number,String,Array,Object,Boolean,Error,Promise,Date,Math});
  return {document,parent,old,calls,invoke,listeners,getPolicy:()=>policy};
}
describe("real permanent Access Manager Tray panel",()=>{
  it("mounts only after native v2 registry verified and shows zero-grant onboarding",async()=>{
    const ui=boot();await flush();
    expect(ui.old.hidden).toBe(true);
    expect(ui.document.getElementById("access-manager")).not.toBeNull();
    expect(ui.document.getElementById("access-onboarding")?.hidden).toBe(false);
    expect(ui.document.getElementById("access-app-list")?.children.length).toBe(1);
    const legacy=boot(false);await flush();
    expect(legacy.old.hidden).toBe(false);
    expect(legacy.document.getElementById("access-manager")).toBeNull();
  });
  it("registers only a live target through native host and revokes without expiry",async()=>{
    const ui=boot();await flush();
    ui.document.getElementById("access-app-list")!.firstChild!.click();
    ui.document.getElementById("access-submit")!.click();await flush();
    const register=ui.calls.find(c=>c.name==="register_permanent_access_rule");
    expect(register?.args).toMatchObject({pid:35416,nativeId:"10553336",effect:"allow",
      kind:"desktop",operations:["view","input"],exactWindow:false,
      elementRole:null,elementLabel:null});
    expect(ui.getPolicy().rules).toHaveLength(1);
    expect(ui.document.getElementById("access-onboarding")!.hidden).toBe(true);
    const rows=ui.document.getElementById("access-rule-list")!.children;
    rows[0].lastChild!.click();await flush();
    expect(ui.calls.some(c=>c.name==="revoke_permanent_access_rule" && c.args.id==="abc")).toBe(true);
    expect(ui.getPolicy().rules).toHaveLength(0);
  });
  it("binds file rules to native picker and Core file-tool registration",async()=>{
    const ui=boot();await flush();
    const select=ui.document.getElementById("access-kind")!;
    select.value="file";select.change();
    expect(ui.document.getElementById("access-submit")!.disabled).toBe(true);
    expect(ui.document.getElementById("access-file-controls")!.hidden).toBe(false);
    expect(ui.document.getElementById("access-file-path")!.readOnly).toBe(true);
    ui.document.getElementById("access-pick-folder")!.click();await flush();
    expect(ui.document.getElementById("access-file-path")!.value).toContain("tryout-online");
    expect(ui.document.getElementById("access-file-recursive")!.checked).toBe(true);
    expect(ui.document.getElementById("access-submit")!.disabled).toBe(false);
    ui.document.getElementById("access-submit")!.click();await flush();
    expect(ui.calls.some(c=>c.name==="register_permanent_access_rule" &&
      c.args.kind==="file" && c.args.pid===0 && c.args.nativeId==="" &&
      c.args.operations.includes("read") && c.args.recursive===true)).toBe(true);
  });
});

describe("element-specific UI enrollment",()=>{
  it("passes host-entered exact role and label into native approval, not core grants",async()=>{
    const ui=boot();await flush();
    ui.document.getElementById("access-app-list")!.firstChild!.click();
    ui.document.getElementById("access-element-role")!.value="button";
    ui.document.getElementById("access-element-label")!.value="OK";
    ui.document.getElementById("access-submit")!.click();
    await flush();
    expect(ui.calls.some(c=>c.name==="register_permanent_access_rule" &&
      c.args.elementRole==="button" && c.args.elementLabel==="OK")).toBe(true);
  });
  it("rejects an element label without a role before invoking native",async()=>{
    const ui=boot();await flush();
    ui.document.getElementById("access-app-list")!.firstChild!.click();
    ui.document.getElementById("access-element-label")!.value="Password";
    ui.document.getElementById("access-submit")!.click();
    await flush();
    expect(ui.calls.some(c=>c.name==="register_permanent_access_rule")).toBe(false);
  });
});
