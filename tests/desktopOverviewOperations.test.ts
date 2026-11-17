import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const ui = fs.readFileSync(path.resolve("apps/superagent-tray/ui/overview-operations.js"),"utf8");
const overview = fs.readFileSync(path.resolve("apps/superagent-tray/ui/overview.js"),"utf8");
const markup = fs.readFileSync(path.resolve("apps/superagent-tray/ui/index.html"),"utf8");
const native = fs.readFileSync(path.resolve("apps/superagent-tray/src-tauri/src/main.rs"),"utf8");

function mount(calls: Record<string,any> = {}) {
  const nodes = new Map<string,any>();
  const handlers = new Map<string,(e?:any)=>any>();
  const requests: any[]=[];
  const byId=(id:string)=>{
    if(!nodes.has(id))nodes.set(id,{
      id,textContent:"",dataset:{},style:{},value:"all",hidden:false,
      classList:{contains:(name:string)=>name==="active"},disabled:false,
      replaceChildren(...children:any[]){this.children=children;},
      append(...children:any[]){this.children=(this.children||[]).concat(children);},
      addEventListener(event:string,fn:any){handlers.set(id+":"+event,fn);},
    });
    return nodes.get(id);
  };
  const createElement=(tag:string)=>({tag,textContent:"",className:"",style:{},children:[],classList:{add(){}},
    append(...children:any[]){this.children.push(...children);},
    setAttribute(){},
  });
  const ipc=async (name:string,args:any)=>{
    requests.push({name,args});
    if(name==="lifecycle_console_request"){
      if(args.request.action==="dashboard")return calls.dashboard ?? {
        observedAt:Date.now(),summary:{ready:3},
        checks:[
          {service:"core",ready:true,ownerVerified:true,state:"active",reason:"Verified"},
          {service:"mcp",ready:true,ownerVerified:true,state:"active",reason:"Verified"},
          {service:"tray",ready:true,ownerVerified:true,state:"active",reason:"Verified"},
          {service:"vision",ready:false,ownerVerified:false,state:"inactive",reason:"Not requested"},
        ],
        services:[{service:"mcp",ownerPid:100,ownershipVerified:true,
          details:{activeSessions:2,inFlightRequests:0,backendHealthy:true,
            backendGenerations:1,sessionTelemetry:{activePrincipals:1,rejectedTotal:0},
            connectedAgentsState:"verified",connectedAgentsObservedAt:Date.now(),
            connectedAgents:[
              {sessionHandle:"ses_aaaaaaaaaaaa",principalHandle:"idh_1111111111111111",
                authMode:"oauth",claimedClientName:"Gemini",state:"active",inFlight:1,
                lastSeenAt:Date.now(),lastToolRequest:"superagent_list_projects"},
              {sessionHandle:"ses_bbbbbbbbbbbb",principalHandle:"idh_2222222222222222",
                authMode:"static-bearer",claimedClientName:"ChatGPT",state:"idle",inFlight:0,
                lastSeenAt:Date.now(),lastToolRequest:null}
            ],
            memoryTelemetry:{rssBytes:10485760,heapUsedBytes:5242880,trend:{suspicious:false}}}}],
        timeline:[{at:Date.now(),service:"mcp",action:"status",outcome:"succeeded"}],
      };
      if(args.request.action==="logs")return {events:[]};
      if(args.request.action==="plan")return calls.plan ?? {
        service:args.request.service,action:args.request.targetAction,
        operationId:"safe-op-123",expectedOwnerPid:100,
        expectedSupervisorPid:100,expectedWorkerPid:101,expectedBuildDigest:"a".repeat(64),
      };
      return {success:true};
    }
    if(name==="get_yolo_mode")return "off";
    if(name==="get_permanent_access_registry")return {rules:[{effect:"deny"}]};
    if(name==="get_desktop_input_policy")return {mode:"deny",targets:[]};
    if(name==="mcp_project_access_action")return {requests:[],identities:[]};
    if(name==="get_overview_owner_metrics")return {processes:[{service:"mcp",cpuPct:2,rssBytes:10485760}]};
    return null;
  };
  const context=vm.createContext({
    document:{readyState:"complete",getElementById:byId,
      createElement,addEventListener(){}},
    window:{__TAURI__:{core:{invoke:ipc}},
      setInterval(){},addEventListener(){},confirm:()=>true,
      __superagentOverviewState:{activities:[]}},
    Date,Math,String,Array,Set,Number,Intl,Promise,console
  });
  byId("page-overview").classList.contains=(name:string)=>name==="active";
  byId("op-lifecycle-service").value="core";
  byId("op-lifecycle-action").value="restart";
  vm.runInContext(ui,context);
  return {byId,requests,handlers};
}
const settle=()=>new Promise(resolve=>setTimeout(resolve,30));

describe("Tray Overview owner-verified cockpit",()=>{
  it("renders explicit readiness and optional-off without declaring an all-ready system",async()=>{
    const h=mount();await settle();
    expect(h.byId("op-readiness").textContent).toBe("3/4 ready");
    expect(h.byId("op-essential").textContent).toBe("Essential stack ready");
    expect(h.byId("op-service-list").children).toHaveLength(4);
    expect(h.byId("op-mcp-sessions").textContent).toBe("2");
    expect(h.byId("op-mcp-rss").textContent).toBe("10.0 MiB");
    expect(h.byId("op-connected-agent-list").children).toHaveLength(2);
    expect(h.byId("op-connected-agent-summary").textContent).toContain("2 sessions");
    expect(h.byId("op-connected-agent-list").children[0].children[0].children[0].children[0].textContent)
      .toBe("Gemini");
    expect(h.byId("op-connected-agent-list").children[0].children[0].children[1].textContent)
      .toContain("not independently verified");
  });
  it("fails closed when lifecycle telemetry disappears",async()=>{
    const h=mount({dashboard:{}});await settle();
    expect(h.byId("op-readiness").textContent).toBe("—");
    expect(h.byId("op-mcp-sessions").textContent).toBe("—");
    expect(h.byId("op-connected-agent-list").children[0].textContent).toContain("Unavailable");
    expect(h.byId("op-service-list").children[0].textContent).toContain("unavailable");
  });
  it("filters only registry-backed connected clients; never assumes claimed labels are authenticated",async()=>{
    const h=mount();await settle();
    h.byId("op-client-filter").value="idle";
    h.handlers.get("op-client-filter:change")?.({target:{value:"idle"}});
    expect(h.byId("op-connected-agent-list").children).toHaveLength(1);
    expect(h.byId("op-connected-agent-list").children[0].children[0].children[0].children[0].textContent)
      .toBe("ChatGPT");
    expect(h.byId("op-connected-agent-list").children[0].children[1].children[0].textContent)
      .toContain("Bearer authenticated");
    expect(JSON.stringify(h.byId("op-connected-agent-list").children)).not.toContain("mcp-session-id");
  });
  it("keeps Chat YOLO separate from MCP requests and desktop approval",async()=>{
    const h=mount();await settle();
    expect(h.byId("op-chat-yolo").textContent).toBe("OFF");
    expect(h.byId("op-desktop-policy").textContent).toBe("deny");
    expect(h.byId("op-mcp-requests").textContent).toBe("0");
    expect(h.byId("op-security-evidence").textContent).not.toContain("Enforced");
  });
  it("offers an owner-bound lifecycle plan; never invokes the legacy restart",async()=>{
    const h=mount();await settle();
    h.handlers.get("op-lifecycle-prepare:click")?.();await settle();
    expect(h.requests.some(x=>x.name==="lifecycle_console_request"&&
      x.args.request.action==="plan")).toBe(true);
    expect(h.requests.some(x=>x.name==="restart_core_server")).toBe(false);
    expect(overview).not.toContain('await overviewInvoke("restart_core_server"');
  });
  it("registers native verified-owner CPU/RSS and responsive operation UI",()=>{
    expect(native).toContain("async fn get_overview_owner_metrics()");
    expect(native).toContain("get_overview_owner_metrics,");
    expect(markup).toContain('id="overview-operations"');
    expect(markup).toContain('src="./overview-operations.js"');
    expect(markup).toContain('href="./overview-operations.css"');
    expect(markup).toContain('id="op-connected-agent-list"');
    expect(markup).toContain('id="runtime-mcp-connected-list"');
    expect(ui).toContain("window.__superagentRenderMcpClientList");
  });
});
