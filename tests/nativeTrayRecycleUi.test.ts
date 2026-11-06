import {describe,it,expect,vi} from "vitest";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const script=fs.readFileSync(path.resolve("apps/superagent-tray/ui/lifecycle.js"),"utf8");
const html=fs.readFileSync(path.resolve("apps/superagent-tray/ui/index.html"),"utf8");
const OPERATION_ID="123e4567-e89b-42d3-a456-426614174000";

function mount(options:{
  allow?:boolean;
  blocked?:boolean;
  noChanges?:boolean;
  expired?:boolean;
  mutationError?:boolean;
  reconcileError?:boolean;
  deferPlan?:boolean;
}={}){
  const nodes=new Map<string,any>();
  const handlers=new Map<string,Function>();
  const windowHandlers=new Map<string,Function[]>();
  const requests:Record<string,any>[]=[];
  const confirmations=vi.fn(()=>options.allow??true);
  let releasePlan:(()=>void)|null=null;
  const node=(id:string)=>{
    if(!nodes.has(id)){
      const el:any={id,textContent:"",value:"",checked:false,disabled:false,hidden:false,
        options:[],children:[],classList:{toggle:vi.fn()},
        addEventListener:(event:string,cb:Function)=>handlers.set(id+":"+event,cb),
        replaceChildren(...items:any[]){el.children=items;},
        append(...items:any[]){el.children.push(...items);},
      };
      if(id==="lifecycle-service"||id==="lifecycle-profile-service")el.value="tray";
      if(id==="lifecycle-action"){
        el.value="restart";el.options=[
          {value:"start"},{value:"stop"},{value:"restart"},{value:"upgrade"},
          {value:"rollback"},{value:"drain"},{value:"recycle"},
        ];
      }
      nodes.set(id,el);
    }
    return nodes.get(id);
  };
  const children=[
    {service:"core",disposition:"keep",reasonCode:"CORE_SUPERVISED_HEALTHY",
      dependencyState:[],note:"Preserve current owner"},
    {service:"vision",disposition:options.blocked?"blocked":
      options.noChanges?"skip_inactive":"recycle",
      reasonCode:options.blocked?"VISION_RECYCLE_BLOCKED":"VISION_LEGACY_PROVABLE",
      dependencyState:[],note:"Owner-specific plan"},
  ];
  const invoke=vi.fn(async(command:string,args:{request:Record<string,any>})=>{
    expect(command).toBe("lifecycle_console_request");
    const req=args.request;
    requests.push(req);
    if(req.action==="inventory")return {services:[
      {service:"core",ownerPid:101,state:"active"},
      {service:"vision",ownerPid:202,state:"unverified"},
    ]};
    if(req.action==="plan"){
      expect(req).toMatchObject({service:"all",targetAction:"recycle"});
      if(options.deferPlan)await new Promise<void>(resolve=>{releasePlan=resolve;});
      return {version:1,operationId:OPERATION_ID,createdAt:Date.now(),
        expiresAt:Date.now()+(options.expired?-1000:300000),
        publicTunnelMutationAllowed:false,arbitraryPidKillAllowed:false,
        summary:{total:2,mutations:options.blocked||options.noChanges?0:1,
          noops:options.noChanges?2:1,blocked:options.blocked?1:0},
        children};
    }
    if(req.action==="recycle"){
      if(options.mutationError)throw Error("Timed out: operation outcome unknown");
      return {status:"completed",operationId:OPERATION_ID,replayed:false};
    }
    if(req.action==="reconcile"){
      if(options.reconcileError)throw Error("GLOBAL_RECYCLE_RECONCILE_REQUIRES_CHILD_OWNER_EVIDENCE");
      return {status:"reconciled",operationId:OPERATION_ID};
    }
    throw Error("Unexpected native lifecycle request "+req.action);
  });
  const context=vm.createContext({
    document:{
      getElementById:node,
      createElement:(tag:string)=>{
        const el:any={tag,textContent:"",className:"",children:[],
          append(...items:any[]){el.children.push(...items);}};
        return el;
      },
    },
    window:{__TAURI__:{core:{invoke}},confirm:confirmations,
      addEventListener:(name:string,cb:Function)=>{
        const group=windowHandlers.get(name)||[];
        group.push(cb);
        windowHandlers.set(name,group);
      }},
    Date,Number,String,Math,Object,Array,Map,Set,Promise,console,
  });
  vm.runInContext(script,context);
  return {requests,node,confirmations,
    dispatchWindow(name:string){
      for(const listener of windowHandlers.get(name)||[])listener();
    },
    releasePlan(){if(!releasePlan)throw Error("No held plan");releasePlan();},
    async click(id:string){
      const handler=handlers.get(id+":click");
      expect(handler).toBeTypeOf("function");
      return handler!();
    },
  };
}
describe("native Tray global Recycle System",()=>{
  it("binds every displayed action and starts with mutation controls disabled",()=>{
    for(const id of ["recycle-analyze-btn","recycle-plan-btn",
      "recycle-confirm-btn","recycle-reconcile-btn","recycle-table-body"])
      expect(html).toContain('id="'+id+'"');
    const m=mount();
    expect(m.node("recycle-plan-btn").disabled).toBe(true);
    expect(m.node("recycle-confirm-btn").disabled).toBe(true);
    expect(m.node("recycle-reconcile-btn").disabled).toBe(true);
  });
  it("analyzes inventory and a durable plan without executing a service",async()=>{
    const m=mount();
    await m.click("recycle-analyze-btn");
    expect(m.requests.map(r=>r.action)).toEqual(["inventory","plan"]);
    expect(m.node("recycle-table-body").children).toHaveLength(2);
    expect(m.node("recycle-plan-btn").disabled).toBe(false);
    expect(m.node("recycle-confirm-btn").disabled).toBe(true);
    expect(m.node("recycle-metric-mutations").textContent).toBe("1");
  });
  it("rejects blocked and expired plans without any mutation",async()=>{
    for(const options of [{blocked:true},{expired:true}]){
      const m=mount(options);
      await m.click("recycle-analyze-btn");
      await m.click("recycle-plan-btn");
      expect(m.node("recycle-confirm-btn").disabled).toBe(true);
      expect(m.requests.every(q=>q.action!=="recycle")).toBe(true);
    }
  });
  it("requires an independent user confirmation and the original operation ID",async()=>{
    const m=mount({allow:false});
    await m.click("recycle-analyze-btn");
    await m.click("recycle-plan-btn");
    expect(m.node("recycle-confirm-btn").disabled).toBe(false);
    await m.click("recycle-confirm-btn");
    expect(m.requests.filter(q=>q.action==="recycle")).toHaveLength(0);
    expect(m.confirmations).toHaveBeenCalledOnce();
  });
  it("executes one confirmed owner-bound global recycle and disables replay",async()=>{
    const m=mount({allow:true});
    await m.click("recycle-analyze-btn");
    await m.click("recycle-plan-btn");
    await m.click("recycle-confirm-btn");
    expect(m.requests.filter(q=>q.action==="recycle")).toEqual([{
      action:"recycle",service:"all",operationId:OPERATION_ID,confirm:true,
    }]);
    expect(m.node("recycle-confirm-btn").disabled).toBe(true);
    await m.click("recycle-confirm-btn");
    expect(m.requests.filter(q=>q.action==="recycle")).toHaveLength(1);
  });
  it("never retries unknown outcomes; reconciliation retains the original ID",async()=>{
    const m=mount({mutationError:true});
    await m.click("recycle-analyze-btn");
    await m.click("recycle-plan-btn");
    await m.click("recycle-confirm-btn");
    expect(m.node("recycle-reconcile-btn").disabled).toBe(false);
    expect(m.node("recycle-confirm-btn").disabled).toBe(true);
    expect(m.node("recycle-status-banner").textContent).toContain("OUTCOME UNKNOWN");
    await m.click("recycle-reconcile-btn");
    expect(m.requests.filter(q=>q.action==="recycle")).toHaveLength(1);
    expect(m.requests.find(q=>q.action==="reconcile")).toEqual({
      action:"reconcile",service:"all",operationId:OPERATION_ID,
      confirm:true,reviewed:true,
    });
    expect(m.node("recycle-reconcile-btn").disabled).toBe(true);
  });
  it("keeps uncertain outcome blocked if reconciliation refuses",async()=>{
    const m=mount({mutationError:true,reconcileError:true});
    await m.click("recycle-analyze-btn");
    await m.click("recycle-plan-btn");
    await m.click("recycle-confirm-btn");
    await m.click("recycle-reconcile-btn");
    expect(m.node("recycle-reconcile-btn").disabled).toBe(false);
    expect(m.node("recycle-confirm-btn").disabled).toBe(true);
  });
  it("invalidates any prepared plan when selected Core changes",async()=>{
    const m=mount();
    await m.click("recycle-analyze-btn");
    await m.click("recycle-plan-btn");
    m.dispatchWindow("superagent-core-selected");
    expect(m.node("recycle-confirm-btn").disabled).toBe(true);
    expect(m.node("recycle-plan-btn").disabled).toBe(true);
  });
  it("discards a delayed analysis response after the selected Core changes",async()=>{
    const m=mount({deferPlan:true});
    const pending=m.click("recycle-analyze-btn");
    for(let i=0;i<20&&!m.requests.some(q=>q.action==="plan");i++)
      await Promise.resolve();
    expect(m.requests.some(q=>q.action==="plan")).toBe(true);
    m.dispatchWindow("superagent-core-selected");
    m.releasePlan();
    await pending;
    expect(m.node("recycle-confirm-btn").disabled).toBe(true);
    expect(m.node("recycle-plan-btn").disabled).toBe(true);
    expect(m.requests.every(q=>q.action!=="recycle")).toBe(true);
  });
});
