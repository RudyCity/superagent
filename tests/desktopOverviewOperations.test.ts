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
      if(args.request.action==="dashboard"){
        if(calls.dashboardPending)return new Promise(()=>{});
        return calls.dashboard ?? {
        observedAt:Date.now(),summary:{ready:3},
        checks:[
          {service:"core",ready:true,ownerVerified:true,state:"active",reason:"Verified"},
          {service:"mcp",ready:true,ownerVerified:true,state:"active",reason:"Verified"},
          {service:"tray",ready:true,ownerVerified:true,state:"active",reason:"Verified"},
          {service:"vision",ready:false,ownerVerified:false,state:"inactive",reason:"Not requested"},
        ],
        services:[{service:"mcp",ownerPid:100,ownershipVerified:true,
          details:{activeSessions:2,inFlightRequests:4,activeSseStreams:3,
            nonStreamInFlightRequests:1,inFlightToolCalls:0,backendHealthy:true,
            backendGenerationDetails:[{current:true,healthAgeMs:750}],
            backendGenerations:1,sessionTelemetry:{activePrincipals:1,rejectedTotal:0,
              inFlightSessions:1,oldestIdleMs:12000},
            memoryTelemetry:{rssBytes:10485760,heapUsedBytes:5242880,trend:{suspicious:false}}}}],
        timeline:[{at:Date.now(),service:"mcp",action:"status",outcome:"succeeded"}],
      };
      }
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
    if(name==="mcp_project_access_action") {
      if(args?.action==="connected_clients")return calls.connectedClients ?? {
        success:true,state:"verified",observedAt:Date.now(),clients:[
              {sessionHandle:"ses_aaaaaaaaaaaa",principalHandle:"idh_1111111111111111",
                authMode:"oauth",claimedClientName:"Gemini",state:"active",inFlight:1,
                lastSeenAt:Date.now(),lastToolRequest:"superagent_list_projects"},
              {sessionHandle:"ses_bbbbbbbbbbbb",principalHandle:"idh_2222222222222222",
                authMode:"static-bearer",claimedClientName:"ChatGPT",state:"idle",inFlight:0,
                lastSeenAt:Date.now(),lastToolRequest:null}
            ]
      };
      return {requests:[],identities:[]};
    }
    if(name==="get_overview_owner_metrics"){
      if(calls.metricsError)throw new Error("OVERVIEW_OWNER_INVENTORY_UNAVAILABLE");
      return calls.metrics ?? {observedAt:Date.now(),
        processes:[{service:"mcp",cpuPct:2,rssBytes:10485760}],
        mcpTelemetry:{rssBytes:10485760,heapUsedBytes:5242880,trend:{suspicious:false}}};
    }
    return null;
  };
  const context=vm.createContext({
    document:{readyState:"complete",getElementById:byId,
      createElement,addEventListener(){}},
    window:{__TAURI__:{core:{invoke:ipc}},
      setInterval(){},addEventListener(){},confirm:()=>true,
      __superagentOverviewState:{activities:[]}},
    Date,Math,String,Array,Set,Number,Intl,Promise,console,
    setTimeout:(fn:any,ms:number)=>setTimeout(fn,Math.min(ms,80)),
    clearTimeout,
  });
  byId("page-overview").classList.contains=(name:string)=>name==="active";
  byId("op-lifecycle-service").value="core";
  byId("op-lifecycle-action").value="restart";
  vm.runInContext(ui,context);
  return {byId,requests,handlers,uiWindow:context.window};
}
const settle=()=>new Promise(resolve=>setTimeout(resolve,30));

describe("Tray Overview owner-verified cockpit",()=>{
  it("renders explicit readiness and optional-off without declaring an all-ready system",async()=>{
    const h=mount();await settle();
    expect(h.byId("op-readiness").textContent).toBe("3/4 ready");
    expect(h.byId("op-essential").textContent).toBe("Essential stack ready");
    expect(h.byId("op-service-list").children).toHaveLength(4);
    expect(h.byId("op-mcp-sessions").textContent).toBe("2");
    expect(h.byId("op-mcp-inflight").textContent).toBe("4");
    expect(h.byId("op-mcp-sse").textContent).toBe("3");
    expect(h.byId("op-mcp-nonstream").textContent).toBe("1");
    expect(h.byId("op-mcp-tools").textContent).toBe("0");
    expect(h.byId("op-mcp-backend").textContent).toBe("Healthy");
    expect(h.byId("op-mcp-note").textContent).toContain("long-lived SSE");
    expect(h.byId("op-mcp-rss").textContent).toBe("10.0 MiB");
    expect(h.byId("op-connected-agent-list").children).toHaveLength(2);
    expect(h.byId("op-connected-agent-summary").textContent).toContain("2 sessions");
    expect(h.byId("op-connected-agent-list").children[0].children[0].children[0].children[0].textContent)
      .toBe("Gemini");
    expect(h.byId("op-connected-agent-list").children[0].children[0].children[1].textContent)
      .toContain("not independently verified");
  });
  it("does not show a healthy backend when the heartbeat is stale", async()=>{
    const h=mount({dashboard:{
      observedAt:Date.now(),checks:[{service:"mcp",ready:true,ownerVerified:true,state:"active"}],
      services:[{service:"mcp",ownershipVerified:true,details:{
        activeSessions:16,inFlightRequests:15,activeSseStreams:15,
        nonStreamInFlightRequests:0,inFlightToolCalls:0,backendHealthy:true,
        backendGenerationDetails:[{current:true,healthAgeMs:30000}],
        sessionTelemetry:{activePrincipals:1,inFlightSessions:15}
      }}]
    }});await settle();
    expect(h.byId("op-mcp-backend").textContent).toBe("Stale heartbeat");
    expect(h.byId("op-mcp-note").textContent).toContain("heartbeat");
  });
  it("renders native owner CPU/RAM and graph with the native sample timestamp",async()=>{
    const sampleAt=Date.now()-2500;
    const h=mount({metrics:{observedAt:sampleAt,
      processes:[{service:"core",cpuPct:1.25,rssBytes:20971520},
        {service:"mcp",cpuPct:3.6,rssBytes:10485760}],
      mcpTelemetry:{rssBytes:10485760,heapUsedBytes:5242880,
        trend:{suspicious:false}}}});await settle();
    const rows=h.byId("op-process-resources").children;
    expect(rows).toHaveLength(2);
    expect(rows[0].children[1].textContent).toBe("1.3% CPU");
    expect(rows[0].children[2].textContent).toBe("20.0 MiB");
    expect(h.byId("op-resources-status").textContent).toContain("2 verified process(es)");
    expect(h.byId("op-resource-history").children).toHaveLength(1);
    expect(h.byId("op-resource-history").children[0].title)
      .toContain(new Date(sampleAt).toLocaleTimeString());
  });
  it("updates Resource Monitor before a slow Lifecycle Dashboard returns",async()=>{
    const h=mount({dashboardPending:true});await settle();
    expect(h.byId("op-process-resources").children).toHaveLength(1);
    expect(h.byId("op-process-resources").children[0].children[1].textContent).toBe("2.0% CPU");
    expect(h.byId("op-mcp-rss").textContent).toBe("10.0 MiB");
    expect(h.byId("op-mcp-heap").textContent).toBe("5.0 MiB");
    expect(h.byId("op-resources-status").textContent).toContain("verified process");
  });
  it("continues sampling resources when a native dashboard call never settles",async()=>{
    const h=mount({dashboardPending:true});
    await settle();
    const initial=h.requests.filter(x=>x.name==="lifecycle_console_request" &&
      x.args.request.action==="dashboard").length;
    await new Promise(resolve=>setTimeout(resolve,110));
    expect(h.byId("op-refresh-state").textContent).toContain("Partial telemetry");
    h.handlers.get("op-refresh:click")?.();
    await settle();
    expect(h.requests.filter(x=>x.name==="lifecycle_console_request" &&
      x.args.request.action==="dashboard")).toHaveLength(initial);
    expect(h.requests.filter(x=>x.name==="get_overview_owner_metrics").length).toBeGreaterThan(1);
  });
  it("distinguishes insufficient memory trend samples from verified stability",async()=>{
    const h=mount({metrics:{observedAt:Date.now(),processes:[
      {service:"mcp",cpuPct:0,rssBytes:10485760}
    ],mcpTelemetry:{rssBytes:10485760,heapUsedBytes:5242880,
      trend:{suspicious:false,sampleCount:1,windowMs:0}}}});await settle();
    expect(h.byId("op-memory-trend").textContent).toBe("Collecting");
    expect(markup).toContain("Access requests");
    expect(markup).toContain("Grant identities");
  });
  it("does not display stale or failed native process samples",async()=>{
    for(const config of [
      {metrics:{observedAt:Date.now()-120000,processes:[
        {service:"core",cpuPct:10,rssBytes:10485760}]}},
      {metricsError:true}
    ]){
      const h=mount(config);await settle();
      expect(h.byId("op-process-resources").children).toHaveLength(1);
      expect(h.byId("op-process-resources").children[0].textContent)
        .toContain("No current verified owner process sample");
      expect(h.byId("op-resources-status").textContent).toContain("unavailable or stale");
      expect(h.byId("op-resource-history").children).toHaveLength(0);
    }
  });
  it("fails closed when lifecycle telemetry disappears",async()=>{
    const h=mount({dashboard:{}});await settle();
    expect(h.byId("op-readiness").textContent).toBe("—");
    expect(h.byId("op-mcp-sessions").textContent).toBe("—");
    expect(h.byId("op-connected-agent-list").children[0].textContent).toContain("Unavailable");
    expect(h.byId("op-service-list").children[0].textContent).toContain("unavailable");
  });
  it("does not use client list from generic dashboard without operator-only proof",async()=>{
    const h=mount({connectedClients:{success:true,state:"unavailable",clients:null}});await settle();
    expect(h.byId("op-connected-agent-list").children[0].textContent).toContain("Unavailable");
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
  it("prepares an owner-bound plan even when the Overview dashboard snapshot is unavailable",async()=>{
    const h=mount({dashboard:{}});await settle();
    h.handlers.get("op-lifecycle-prepare:click")?.();await settle();
    expect(h.requests.some(x=>x.name==="lifecycle_console_request" &&
      x.args.request.action==="plan" && x.args.request.service==="core" &&
      x.args.request.port===7888)).toBe(true);
    expect(h.byId("op-lifecycle-plan").textContent).toContain("safe-op-123");
  });
  it("does not execute a prepared plan when a fresh authenticated owner is unavailable",async()=>{
    const h=mount({dashboard:{}});await settle();
    h.handlers.get("op-lifecycle-prepare:click")?.();await settle();
    h.handlers.get("op-lifecycle-execute:click")?.();await settle();
    expect(h.requests.some(x=>x.name==="lifecycle_console_request" &&
      x.args.request.action==="restart")).toBe(false);
    expect(h.byId("op-feedback").textContent).toContain("Owner changed since plan");
  });
  it("reports a rejected native Shutdown Manager open action",async()=>{
    const h=mount();await settle();
    h.uiWindow.__superagentShutdownManagerOpen=()=>Promise.reject(new Error("SHUTDOWN_NATIVE_WINDOW_REQUIRED"));
    h.handlers.get("op-shutdown-open:click")?.();await settle();
    expect(h.byId("op-feedback").textContent).toContain("SHUTDOWN_NATIVE_WINDOW_REQUIRED");
  });
  it("registers native verified-owner CPU/RSS and responsive operation UI",()=>{
    expect(native).toContain("async fn get_overview_owner_metrics()");
    expect(native).toContain("get_overview_owner_metrics,");
    expect(markup).toContain('id="overview-operations"');
    expect(markup).toContain('src="./overview-operations.js"');
    expect(markup).toContain('href="./overview-operations.css"');
    expect(markup).toContain('id="op-resources-status"');
    expect(native).toContain('lifecycle_console_request(json!({"action":"inventory"}))');
    expect(markup).toContain('id="op-connected-agent-list"');
    expect(markup).toContain('id="op-mcp-tools"');
    expect(markup).toContain('id="op-mcp-sse"');
    expect(markup).toContain('id="runtime-mcp-connected-list"');
    expect(ui).toContain("window.__superagentRenderMcpClientList");
  });
});
