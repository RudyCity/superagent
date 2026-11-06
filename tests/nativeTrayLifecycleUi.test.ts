import {describe,it,expect,vi} from "vitest";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const script=fs.readFileSync(path.resolve("apps/superagent-tray/ui/lifecycle.js"),"utf8");
const html=fs.readFileSync(path.resolve("apps/superagent-tray/ui/index.html"),"utf8");
function mount(options:{allow?:boolean;mutationError?:boolean;safeRestart?:boolean;muse?:boolean}={}){
  const nodes=new Map<string,any>(),handlers=new Map<string,Function>();
  const requests:Record<string,any>[]=[];
  const confirmations=vi.fn(()=>options.allow??true);
  const node=(id:string)=>{
    if(!nodes.has(id)){
      const el:any={id,value:"",disabled:false,hidden:false,textContent:"",className:"",
        options:[],children:[],classList:{toggle:vi.fn()},
        addEventListener:(event:string,cb:Function)=>handlers.set(id+":"+event,cb),
        replaceChildren(...items:any[]){el.children=items;},
        append(...items:any[]){el.children.push(...items);},
      };
      if(id==="lifecycle-service"||id==="lifecycle-profile-service")el.value="tray";
      if(id==="lifecycle-action"){
        el.value="upgrade";
        el.options=[{value:"start"},{value:"stop"},{value:"restart"},
          {value:"upgrade"},{value:"rollback"}];
      }
      if(id==="lifecycle-failure-threshold")el.value="3";
      if(id==="lifecycle-max-restarts")el.value="2";
      nodes.set(id,el);
    }
    return nodes.get(id);
  };
  const invoke=vi.fn(async(command:string,args:any)=>{
    expect(command).toBe("lifecycle_console_request");
    requests.push(args.request);
    const q=args.request;
    if(q.action==="dashboard")return {summary:{ready:3,degraded:1,unavailable:9},
      checks:[{service:"tray",state:"active",alive:true,ready:true,
        ownerVerified:true,reason:"safe",dependsOn:[]},
        ...(options.muse ? [{service:"muse",state:"inactive",alive:false,ready:false,
          ownerVerified:false,reason:"No independent channel host",dependsOn:[]}] : [])],
      trayRelease:{activeDigest:"a".repeat(64)},
      safeLifecycle:{
        core:{ready:options.safeRestart===true,mutationAuthorized:false,reasons:options.safeRestart?[]:["BUILD_STALE"]},
        tray:{ready:options.safeRestart===true,mutationAuthorized:false,reasons:options.safeRestart?[]:["UNCERTAIN_OPERATION"]},
      }};
    if(q.action==="profile")return {revision:"d".repeat(24),
      profiles:[{service:"tray",autoRecover:false,failureThreshold:3,
        maxRestartsPerHour:2}]};
    if(q.action==="logs")return {events:[{service:"tray",action:"upgrade",
      outcome:"succeeded",at:1793830000000}]};
    if(q.action==="watchdog")return {services:[{service:"tray",action:"observe"}]};
    if(q.action==="plan")return {service:q.service,action:q.targetAction,
      operationId:"c20e3373-662d-4a91-b20c-f8c34233863d",
      expectedOwnerPid:1234,expectedInstanceId:"a".repeat(32),
      expectedBuildDigest:"a".repeat(64),
      expectedSupervisorPid:101,expectedWorkerPid:201,
      expectedReleaseRevision:"b".repeat(24),
      expectedCurrentDigest:"c".repeat(64),noCoreShutdown:true,
      port:q.service==="core"?7888:34567,note:"Only this attested owner"};
    if(q.action==="upgrade"||q.action==="restart"){
      if(options.mutationError)throw Error("Request timed out: outcome unknown");
      return {verified:true,changed:true,ownerPid:5678};
    }
    if(q.action==="configure")return {changed:true,revision:"e".repeat(24)};
    throw Error("Unexpected lifecycle request "+q.action);
  });
  const listeners=new Map<string,Function>();
  const context=vm.createContext({
    document:{getElementById:node,createElement:(tag:string)=>{
      const x:any={tag,textContent:"",className:"",children:[],disabled:false,
        append(...items:any[]){x.children.push(...items);},
        replaceChildren(...items:any[]){x.children=items;},
        setAttribute:vi.fn(),
        addEventListener(event:string,cb:Function){x["on"+event]=cb;}};return x;
    }},
    window:{__TAURI__:{core:{invoke}},confirm:confirmations,
      addEventListener:(name:string,cb:Function)=>listeners.set(name,cb)},
    Date,Number,String,Math,Object,Array,Intl,Set,Promise,console,
  });
  vm.runInContext(script,context);
  return {node,handlers,requests,invoke,confirmations,
    window:(context as any).window,
    async click(id:string){
      const handler=handlers.get(id+":click");
      expect(handler).toBeTypeOf("function");
      return handler!({target:node(id)});
    },
  };
}
describe("native lifecycle Runtime panel",()=>{
  it("has the accessible runtime controls and native script",()=>{
    for(const id of ["lifecycle-console","lifecycle-services",
      "lifecycle-metrics","lifecycle-plan","lifecycle-execute",
      "lifecycle-save-profile","lifecycle-events"])
      expect(html).toContain('id="'+id+'"');
    expect(html).toContain('src="./lifecycle.js"');
    expect(html).toContain('href="./lifecycle.css"');
  });
  it("refreshes health, profiles, logs and watchdog without any mutation",async()=>{
    const m=mount();
    await m.window.__superagentLifecycleRefresh(true);
    expect(m.requests.map(q=>q.action)).toEqual([
      "dashboard","profile","logs","watchdog",
    ]);
    expect(m.node("lifecycle-ready").textContent).toBe("3");
    expect(m.node("lifecycle-release").textContent).toBe("aaaaaaaaa");
    expect(m.node("lifecycle-services").children.length).toBe(1);
    expect(m.node("lifecycle-events").children.length).toBe(1);
  });
  it("requires a reviewed plan and second confirmation to execute",async()=>{
    const m=mount({allow:false});
    expect(m.node("lifecycle-execute").disabled).toBe(true);
    await m.click("lifecycle-plan");
    expect(m.node("lifecycle-execute").disabled).toBe(false);
    expect(m.requests.map(q=>q.action)).toEqual(["plan"]);
    await m.click("lifecycle-execute");
    expect(m.requests.map(q=>q.action)).toEqual(["plan"]);
    expect(m.confirmations).toHaveBeenCalledOnce();
  });
  it("carries the same original operation ID into a confirmed mutation",async()=>{
    const m=mount({allow:true});
    await m.click("lifecycle-plan");
    await m.click("lifecycle-execute");
    const applied=m.requests.find(q=>q.action==="upgrade");
    expect(applied).toMatchObject({
      service:"tray",action:"upgrade",confirm:true,
      operationId:"c20e3373-662d-4a91-b20c-f8c34233863d",
      expectedOwnerPid:1234,noCoreShutdown:true,
    });
    expect(m.node("lifecycle-execute").disabled).toBe(true);
  });
  it("never auto-retries a timed-out mutation or rotates the operation ID",async()=>{
    const m=mount({allow:true,mutationError:true});
    await m.click("lifecycle-plan");
    await m.click("lifecycle-execute");
    expect(m.requests.filter(q=>q.action==="upgrade")).toHaveLength(1);
    expect(m.node("lifecycle-plan-details").textContent)
      .toContain("c20e3373-662d-4a91-b20c-f8c34233863d");
    expect(m.node("lifecycle-feedback").textContent).toContain("uncertain");
    expect(m.node("lifecycle-execute").disabled).toBe(true);
  });
  it("blocks Core restart before dispatch when safe readiness is NO-GO",async()=>{
    const m=mount({allow:true,safeRestart:false});
    m.node("lifecycle-service").value="core";
    m.handlers.get("lifecycle-service:change")?.();
    expect(m.node("lifecycle-action").value).toBe("restart");
    await m.click("lifecycle-plan");
    expect(m.requests.find(q=>q.action==="plan")).toMatchObject({
      service:"core",targetAction:"restart",port:7888,
    });
    await m.click("lifecycle-execute");
    expect(m.requests.filter(q=>q.action==="restart")).toHaveLength(0);
    expect(m.node("lifecycle-execute").disabled).toBe(true);
    expect(m.node("lifecycle-feedback").textContent).toContain("NO-GO");
  });
  it("sends exactly one owner-bound Core restart after READY and approval",async()=>{
    const m=mount({allow:true,safeRestart:true});
    m.node("lifecycle-service").value="core";
    m.handlers.get("lifecycle-service:change")?.();
    await m.click("lifecycle-plan");
    await m.click("lifecycle-execute");
    expect(m.requests.filter(q=>q.action==="restart")).toHaveLength(1);
    expect(m.requests.find(q=>q.action==="restart")).toMatchObject({
      service:"core",port:7888,expectedSupervisorPid:101,
      expectedWorkerPid:201,confirm:true,expectedBuildDigest:"a".repeat(64),
    });
    expect(m.confirmations).toHaveBeenCalledOnce();
  });
  it("uses revisioned profile updates only after confirmation",async()=>{
    const m=mount({allow:true});
    await m.window.__superagentLifecycleRefresh(true);
    m.node("lifecycle-auto-recover").checked=true;
    await m.click("lifecycle-save-profile");
    expect(m.requests.find(q=>q.action==="configure")).toMatchObject({
      service:"tray",revision:"d".repeat(24),confirm:true,
      autoRecover:true,failureThreshold:3,maxRestartsPerHour:2,
    });
  });
  it("exposes Muse Watch start modes in the unified supervisor only for verified Core",async()=>{
    const m=mount({muse:true});
    const museAction=vi.fn();
    m.window.__superagentMuseQuickAction=museAction;
    m.window.__superagentMuseControlState=()=>({
      available:true,running:false,ownerPresent:false,port:7888,pid:1111,
    });
    await m.window.__superagentLifecycleRefresh(true);
    const card=m.node("lifecycle-services").children.find((x:any)=>
      x.children.some((child:any)=>child.textContent==="Core-local Muse Watch"));
    expect(card).toBeDefined();
    const controls=card.children.find((x:any)=>x.className==="runtime-lifecycle-group");
    const start=controls.children.find((x:any)=>x.textContent==="Start Muse · Telegram");
    expect(start.disabled).toBe(false);
    start.onclick();
    expect(museAction).toHaveBeenCalledWith("start-telegram");
    expect(m.requests.every(q=>["dashboard","profile","logs","watchdog"].includes(q.action))).toBe(true);

    m.window.__superagentMuseControlState=()=>({available:false,running:false});
    m.window.__superagentLifecycleUpdateMuseControls();
    const disabled=controls.children.find((x:any)=>x.textContent==="Start Muse · Telegram");
    expect(disabled.disabled).toBe(true);
  });
});
