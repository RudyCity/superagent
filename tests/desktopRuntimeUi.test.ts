import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const js = fs.readFileSync(
  path.resolve("apps/superagent-tray/ui/runtime.js"), "utf8",
);

function mountRuntime(snapshot: unknown) {
  const elements = new Map<string, any>();
  const listeners = new Map<string, (e: unknown) => unknown>();
  const requested: Array<{ action: string; args: unknown }> = [];
  const events: string[] = [];
  const confirm = vi.fn(() => true);
  const byId = (id: string) => {
    let item = elements.get(id);
    if (!item) {
      item = {
        textContent: "", innerHTML: "", hidden: false, disabled: false,
        addEventListener: (event: string, callback: (e: unknown) => unknown) =>
          listeners.set(id + ":" + event, callback),
        replaceChildren: () => {},
      };
      elements.set(id, item);
    }
    return item;
  };
  const context = vm.createContext({
    document: {
      getElementById: byId,
      querySelectorAll: () => [],
    },
    window: {
      __TAURI__: { core: { invoke: async (action: string, args: unknown) => {
        requested.push({ action, args });
        return action === "detect_runtime" ? snapshot : { success: true };
      } } },
      addEventListener: () => {},
      dispatchEvent: (e: { type: string }) => events.push(e.type),
      confirm,
    },
    setInterval: vi.fn(),
    Event: class { constructor(public type: string) {} },
    alert: vi.fn(),
    Date, Number, String, Array, Math,
  });
  vm.runInContext(js, context);
  return { byId, requested, events, context, listeners, confirm };
}

describe("SuperAgent desktop Runtime Detection UI", () => {
  it("renders authenticated Core, stale CLI process and degraded T-Line separately", async () => {
    const ui = mountRuntime({
      scannedAt: Date.now(),
      healthyCoreCount: 1, activeProcessCount: 1, selectedCorePort: 7888,
      cores: [{
        port: 7888, pid: 123, state: "online", selected: true,
        evidence: "authenticated /api/status", version: "1.14.63",
        pidVerified: true,
        daemon: { running: true, activeJobs: 1, totalJobs: 3 },
        gateway: { enabled: false },
        services: { muse: { watcherActive: true, connected: false, transport: "telegram" },
          tunnel: { active: false, count: 0 }, mcp: { active: true, serverCount: 1, connectedClientCount: 0 },
          telegram: { active: true }, channelHosts: { verifiedCount: 1 } },
      }],
      processes: [
        { pid: 234, role: "MCP host", state: "active", workspace: "superagent", heartbeatAgeSeconds: 2 },
        { pid: 456, role: "SuperAgent CLI", state: "stale", workspace: "<img src=x>", heartbeatAgeSeconds: 999 },
      ],
      independentHosts: [{
        kind: "tline-transport", port: 7891, pid: 345, state: "degraded",
        backendReady: false, evidence: "service-identity HTTP health + live OS PID",
      }],
      remoteServices: [
        { kind: "mcp", port: 8857, pid: 22228, state: "observed",
          transport: "cloudflare", detail: "MCP HTTP listener responds",
          evidence: "owner PID verified", publicUrl: "https://sensitive.invalid" },
        { kind: "cloudflare", port: 8857, pid: 21164, state: "online",
          transport: "mcp-http", detail: "Cloudflare quick tunnel reports healthy ingress",
          evidence: "recent heartbeat" },
        { kind: "muse-watch", pid: 25072, state: "observed",
          transport: "telegram", detail: "Muse Watch listener active",
          evidence: "recent heartbeat" },
      ],
    });
    await new Promise((r) => setImmediate(r));
    expect(ui.requested[0]?.action).toBe("detect_runtime");
    expect(ui.byId("runtime-core-count").textContent).toBe("1");
    expect(ui.byId("runtime-process-count").textContent).toBe("1");
    expect(ui.byId("runtime-servers").innerHTML).toContain("Core · :7888");
    expect(ui.byId("runtime-servers").innerHTML).toContain("via telegram");
    expect(ui.byId("runtime-servers").innerHTML).toContain("connection not ready");
    expect(ui.byId("runtime-processes").innerHTML).not.toContain("<img src=x>");
    expect(ui.byId("runtime-processes").innerHTML).toContain("&lt;img src=x&gt;");
    expect(ui.byId("runtime-independent").innerHTML).toContain("Core backend not ready");
    const remotes = ui.byId("runtime-remote").innerHTML;
    expect(remotes).toContain("MCP HTTP Server");
    expect(remotes).toContain("Cloudflare Tunnel");
    expect(remotes).toContain("Muse Watch");
    expect(remotes).toContain("8857");
    expect(remotes).not.toContain("sensitive.invalid");
    expect(ui.byId("runtime-remote-count").textContent).toContain("3 active/detected");
  });

  it("requires human confirmation and fresh owner capability before any stop/restart RPC", async () => {
    const ui = mountRuntime({
      scannedAt: Date.now(), healthyCoreCount: 1, activeProcessCount: 0,
      selectedCorePort: 7888,
      cores: [{
        port: 7888, pid: 1234, pidVerified: true, state: "online",
        services: {muse:{ownerPresent:true,watcherActive:true}},
      }],
      processes:[],independentHosts:[],
      remoteServices:[
        {kind:"mcp",port:8857,pid:22228,state:"observed",canStop:true,canRestart:false},
        {kind:"cloudflare",port:8857,pid:21164,state:"online",canStop:false,canRestart:false},
        {kind:"muse-watch",port:9777,pid:25072,state:"online",canStop:true,canRestart:true},
      ],
    });
    await new Promise(resolve => setImmediate(resolve));
    const click = (kind: string, action:string,port:number,pid:number) => vm.runInContext(
      `runtimeServiceAction({target:{closest:()=>({disabled:false,dataset:{
        runtimeKind:"${kind}",runtimeAction:"${action}",
        runtimePort:"${port}",runtimePid:"${pid}"
      }})}})`, ui.context) as Promise<void>;
    ui.confirm.mockReturnValueOnce(false);
    await click("mcp","stop",8857,22228);
    expect(ui.requested.filter(x=>x.action==="service_action")).toHaveLength(0);
    await click("mcp","restart",8857,22228);
    await click("cloudflare","stop",8857,21164);
    await click("mcp","stop",8857,999);
    expect(ui.requested.filter(x=>x.action==="service_action")).toHaveLength(0);
    await click("mcp","stop",8857,22228);
    expect(ui.requested).toContainEqual({action:"service_action",
      args:{kind:"mcp",action:"stop",port:8857,pid:22228}});
    await click("muse-watch","restart",9777,25072);
    expect(ui.requested).toContainEqual({action:"service_action",
      args:{kind:"muse-watch",action:"restart",port:9777,pid:25072}});
    await click("muse-core","stop",7888,1234);
    expect(ui.requested).toContainEqual({action:"service_action",
      args:{kind:"muse-core",action:"stop",port:7888,pid:1234}});
    expect(ui.byId("runtime-remote").innerHTML).toContain("runtime-lifecycle");
    expect(ui.byId("runtime-servers").innerHTML).toContain("Stop Muse");
  });

  it("shows explicit Muse start modes when Core is verified and no watcher is active", async () => {
    const ui = mountRuntime({
      scannedAt:Date.now(),healthyCoreCount:1,activeProcessCount:0,selectedCorePort:7888,
      cores:[{
        port:7888,pid:4321,pidVerified:true,state:"online",selected:true,
        services:{muse:{ownerPresent:false,watcherActive:false}},
      }],
      processes:[],independentHosts:[],remoteServices:[],
    });
    await new Promise(resolve=>setImmediate(resolve));
    const html=ui.byId("runtime-servers").innerHTML;
    expect(html).toContain("Start Muse · Telegram");
    expect(html).toContain("Start Muse · WebSocket");
    expect(html).toContain("Start Muse · Tunnel");

    const click=(action:string)=>vm.runInContext(
      `runtimeServiceAction({target:{closest:()=>({disabled:false,dataset:{
        runtimeKind:"muse-core",runtimeAction:"${action}",
        runtimePort:"7888",runtimePid:"4321"
      }})}})`,ui.context) as Promise<void>;

    await click("start-telegram");
    expect(ui.requested).toContainEqual({
      action:"service_action",
      args:{kind:"muse-core",action:"start-telegram",port:7888,pid:4321},
    });
  });

  it("renders stale Muse runtime detail and guards Apply & Restart by fresh Core state",async()=>{
    const ui=mountRuntime({
      scannedAt:Date.now(),healthyCoreCount:1,activeProcessCount:0,selectedCorePort:7888,
      cores:[{
        port:7888,pid:4444,pidVerified:true,state:"online",selected:true,
        services:{muse:{
          ownerPresent:true,watcherActive:true,transport:"telegram",connected:true,
          configStale:true,uptimeSeconds:75,workspaceCount:2,queuedBatches:0,
          activeTask:false,lastTransportError:null,
        }},
      }],
      processes:[],independentHosts:[],remoteServices:[],
    });
    await new Promise(resolve=>setImmediate(resolve));
    const html=ui.byId("runtime-servers").innerHTML;
    expect(html).toContain("settings stale");
    expect(html).toContain("2 workspaces");
    expect(html).toContain("Apply &amp; Restart");

    await vm.runInContext(`runtimeServiceAction({target:{closest:()=>({
      disabled:false,dataset:{
        runtimeKind:"muse-core",runtimeAction:"apply-restart",
        runtimePort:"7888",runtimePid:"4444"
      }
    })}})`,ui.context);
    expect(ui.requested).toContainEqual({
      action:"service_action",
      args:{kind:"muse-core",action:"apply-restart",port:7888,pid:4444},
    });
  });

  it("regenerates only supported, freshly verified owner tokens after confirmation",async()=>{
    const ui=mountRuntime({
      scannedAt:Date.now(),healthyCoreCount:1,activeProcessCount:0,
      selectedCorePort:7888,
      cores:[{port:7888,pid:1234,pidVerified:true,state:"online",selected:true,
        services:{muse:{ownerPresent:true,watcherActive:true,transport:"websocket"}}}],
      processes:[],independentHosts:[],
      remoteServices:[
        {kind:"mcp",port:8857,pid:22228,state:"observed",canRegenerateToken:true},
        {kind:"cloudflare",port:8857,pid:21164,state:"online",canRegenerateToken:false},
        {kind:"muse-watch",port:9225,pid:25072,state:"online",canRegenerateToken:true},
        {kind:"mcp",port:9227,pid:4000,state:"observed",canRegenerateToken:false},
      ],
    });
    await new Promise(resolve=>setImmediate(resolve));
    const click=(kind:string,port:number,pid:number)=>
      vm.runInContext(`runtimeRegenerateToken({target:{closest:()=>({
        disabled:false,dataset:{
          runtimeKind:"${kind}",runtimePort:"${port}",runtimePid:"${pid}"
        }
      })}})`,ui.context) as Promise<void>;
    ui.confirm.mockReturnValueOnce(false);
    await click("mcp",8857,22228);
    expect(ui.requested.filter(r=>r.action==="regenerate_token")).toHaveLength(0);
    await click("mcp",9227,4000);
    await click("cloudflare",8857,21164);
    await click("mcp",8857,123);
    await click("muse-watch",9225,123);
    expect(ui.requested.filter(r=>r.action==="regenerate_token")).toHaveLength(0);
    await click("mcp",8857,22228);
    expect(ui.requested).toContainEqual({
      action:"regenerate_token",args:{kind:"mcp",port:8857,pid:22228}
    });
    await click("muse-watch",9225,25072);
    expect(ui.requested).toContainEqual({
      action:"regenerate_token",args:{kind:"muse-watch",port:9225,pid:25072}
    });
    await click("muse-core",7888,1234);
    expect(ui.requested).toContainEqual({
      action:"regenerate_token",args:{kind:"muse-core",port:7888,pid:1234}
    });
    expect(ui.byId("runtime-remote").innerHTML).toContain("Regenerate Token");
    expect(ui.byId("runtime-servers").innerHTML).toContain("Regenerate Muse Token");
  });

  it("creates only explicit connections after user confirmation and authenticated Core selection", async () => {
    const ui=mountRuntime({
      scannedAt:Date.now(),healthyCoreCount:1,activeProcessCount:0,selectedCorePort:7888,
      cores:[{port:7888,pid:100,state:"online",selected:true,pidVerified:true}],
      processes:[],independentHosts:[],remoteServices:[],
    });
    await new Promise(resolve=>setImmediate(resolve));
    const submit=() => vm.runInContext("runtimeCreateConnection({preventDefault(){}})",ui.context) as Promise<void>;
    ui.byId("runtime-create-kind").value="mcp-client";
    ui.byId("runtime-create-name").value="my-mcp";
    ui.byId("runtime-create-url").value="https://example.org/mcp";
    ui.byId("runtime-create-oauth").checked=true;
    ui.confirm.mockReturnValueOnce(false);
    await submit();
    expect(ui.requested.filter(a=>a.action==="create_connection")).toHaveLength(0);
    await submit();
    expect(ui.requested).toContainEqual({
      action:"create_connection",
      args:{payload:{kind:"mcp-client",name:"my-mcp",url:"https://example.org/mcp",oauth:true}},
    });
    ui.byId("runtime-create-kind").value="mcp-tunnel";
    ui.byId("runtime-create-port").value="9227";
    ui.byId("runtime-create-provider").value="cloudflare";
    await submit();
    expect(ui.requested).toContainEqual({
      action:"create_connection",
      args:{payload:{kind:"mcp-tunnel",port:9227,provider:"cloudflare"}},
    });
    ui.byId("runtime-create-kind").value="muse-tunnel";
    ui.byId("runtime-create-port").value="9225";
    await submit();
    expect(ui.requested).toContainEqual({
      action:"create_connection",
      args:{payload:{kind:"muse-tunnel",port:9225}},
    });
    ui.byId("runtime-create-kind").value="core-tunnel";
    await submit();
    expect(ui.requested).toContainEqual({
      action:"create_connection",
      args:{payload:{kind:"core-tunnel",port:7888}},
    });
    ui.byId("runtime-create-kind").value="mcp-tunnel";
    ui.byId("runtime-create-port").value="bad";
    await submit();
    expect(ui.requested.filter(a=>a.action==="create_connection")).toHaveLength(4);
  });

  it("displays one-time OAuth approval code in the create connection result view", async () => {
    const ui=mountRuntime({
      scannedAt:Date.now(),healthyCoreCount:1,activeProcessCount:0,selectedCorePort:7888,
      cores:[{port:7888,pid:100,state:"online",selected:true,pidVerified:true}],
      processes:[],independentHosts:[],remoteServices:[],
    });
    const origInvoke = ui.context.window.__TAURI__.core.invoke;
    ui.context.window.__TAURI__.core.invoke = async (action: string, args: any) => {
      if (action === "create_connection") {
        return {
          success: true,
          endpoint: "https://sodium-test.trycloudflare.com/mcp",
          bootstrapCode: "test-oauth-bootstrap-code-999",
          setupSnippet: "MCP URL : https://sodium-test.trycloudflare.com/mcp\nBootstrap : test-oauth-bootstrap-code-999",
          message: "MCP tunnel started; code copied.",
        };
      }
      return origInvoke(action, args);
    };
    await new Promise(resolve=>setImmediate(resolve));
    const submit=() => vm.runInContext("runtimeCreateConnection({preventDefault(){}})",ui.context) as Promise<void>;
    ui.byId("runtime-create-kind").value="mcp-tunnel";
    ui.byId("runtime-create-port").value="9267";
    ui.byId("runtime-create-provider").value="cloudflare";
    await submit();
    expect(ui.byId("runtime-create-result").hidden).toBe(false);
    expect(ui.byId("runtime-create-result").textContent).toContain("test-oauth-bootstrap-code-999");
    expect(ui.byId("runtime-create-result").textContent).toContain("One-Time OAuth Approval Code");
  });

  it("does not attempt new connection when the selected Core is offline", async () => {
    const ui=mountRuntime({
      scannedAt:Date.now(),healthyCoreCount:0,activeProcessCount:0,
      cores:[{port:7888,state:"unreachable",selected:true}],
      processes:[],independentHosts:[],remoteServices:[],
    });
    await new Promise(resolve=>setImmediate(resolve));
    await (vm.runInContext("runtimeCreateConnection({preventDefault(){}})",ui.context) as Promise<void>);
    expect(ui.requested.filter(a=>a.action==="create_connection")).toHaveLength(0);
    expect(ui.byId("runtime-create-feedback").textContent).toContain("authenticated Core");
  });

  it("selects only authenticated online Core and refreshes cron management", async () => {
    const snapshot = {
      scannedAt: Date.now(), healthyCoreCount: 1, activeProcessCount: 0,
      selectedCorePort: 0,
      cores: [{ port: 8888, state: "online", selected: false, evidence: "authenticated" },
        { port: 9000, state: "unreachable", selected: false, evidence: "registration only" }],
      processes: [], independentHosts: [],
    };
    const ui = mountRuntime(snapshot);
    await new Promise((r) => setImmediate(r));
    const invokeSelect = (port: number) => vm.runInContext(
      `runtimeSelect({ target: { closest: () => ({ dataset: { runtimePort: "${port}" }, disabled: false }) } })`,
      ui.context,
    ) as Promise<void>;
    await invokeSelect(9000);
    expect(ui.requested.filter((call) => call.action === "select_runtime_core")).toHaveLength(0);
    await invokeSelect(8888);
    expect(ui.requested).toContainEqual({ action: "select_runtime_core", args: { port: 8888 } });
    expect(ui.events).toContain("superagent-core-selected");
  });
  it("shows Muse start controls but blocks an unverified Core",async()=>{
    const ui=mountRuntime({
      scannedAt:Date.now(),healthyCoreCount:0,activeProcessCount:0,
      selectedCorePort:7888,
      cores:[{port:7888,pid:200,pidVerified:false,state:"unverified",
        services:{muse:{watcherActive:false}}}],
      processes:[],independentHosts:[],remoteServices:[],
    });
    await new Promise(resolve=>setImmediate(resolve));
    const html=ui.byId("runtime-servers").innerHTML;
    expect(html).toContain("Service Quick Controls");
    expect(html).toContain("Start Muse · Telegram");
    expect(html).toContain('data-runtime-action="start-telegram" disabled');
    expect(html).toContain("Start or select a verified local Core");
    await (vm.runInContext('window.__superagentMuseQuickAction("start-telegram")',
      ui.context) as Promise<void>);
    expect(ui.requested.filter(x=>x.action==="service_action")).toHaveLength(0);
  });

  it("fails closed when authenticated Core omits Muse state",async()=>{
    const ui=mountRuntime({
      scannedAt:Date.now(),healthyCoreCount:1,activeProcessCount:0,
      selectedCorePort:7888,
      cores:[{port:7888,pid:301,pidVerified:true,state:"online",
        services:{mcp:{active:true}}}],
      processes:[],independentHosts:[],remoteServices:[],
    });
    await new Promise(resolve=>setImmediate(resolve));
    const html=ui.byId("runtime-servers").innerHTML;
    expect(html).toContain("Selected Core did not report Muse state");
    expect(html).toContain('data-runtime-action="start-telegram" disabled');
    expect(html).toContain('data-runtime-open="mcp" >Host MCP Tunnel');
    await (vm.runInContext('window.__superagentMuseQuickAction("start-telegram")',
      ui.context) as Promise<void>);
    expect(ui.requested.filter(x=>x.action==="service_action")).toHaveLength(0);
  });

  it("opens MCP tunnel setup without launching any service",async()=>{
    const ui=mountRuntime({
      scannedAt:Date.now(),healthyCoreCount:1,activeProcessCount:0,
      selectedCorePort:7888,
      cores:[{port:7888,pid:300,pidVerified:true,state:"online",
        services:{muse:{watcherActive:false}}}],
      processes:[],independentHosts:[],remoteServices:[],
    });
    await new Promise(resolve=>setImmediate(resolve));
    await vm.runInContext(`runtimeQuickNavigation({target:{closest:()=>({
      disabled:false,dataset:{runtimeOpen:"mcp"}})}})`,ui.context);
    expect(ui.byId("runtime-create-kind").value).toBe("mcp-tunnel");
    expect(ui.byId("runtime-create-panel").hidden).toBe(false);
    expect(ui.requested.filter(x=>x.action==="create_connection")).toHaveLength(0);
  });
});
