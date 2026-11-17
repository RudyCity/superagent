import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const js = fs.readFileSync(
  path.resolve("apps/superagent-tray/ui/runtime.js"), "utf8",
);

function mountRuntime(snapshot: unknown, extra: {
  gateway?: Record<string, unknown>;
  named?: Record<string, unknown>;
  mcpRequests?: any[];
  mcpIdentities?: any[];
  failMcp?: boolean;
} = {}) {
  const elements = new Map<string, any>();
  const listeners = new Map<string, (e: unknown) => unknown>();
  const requested: Array<{ action: string; args: unknown }> = [];
  const events: string[] = [];
  const confirm = vi.fn(() => true);
  const copy = vi.fn(async (_value: string) => {});
  const byId = (id: string) => {
    let item = elements.get(id);
    if (!item) {
      item = {
        textContent: "", innerHTML: "", hidden: false, disabled: false,
        dataset: {}, attributes: {} as Record<string, string>,
        setAttribute(key: string, value: string) { this.attributes[key] = value; },
        focus: vi.fn(),
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
      addEventListener: (event: string, callback: (e: unknown) => unknown) =>
        listeners.set("document:" + event, callback),
    },
    window: {
      __TAURI__: { core: { invoke: async (action: string, args: unknown) => {
        requested.push({ action, args });
        if (action === "detect_runtime") return snapshot;
        if (action === "desktop_live_action") return extra.gateway ?? { active: false };
        if (action === "get_named_tunnel_health") return extra.named ?? null;
        if (action === "mcp_project_access_action") {
          if (extra.failMcp) throw Error("MCP Core unavailable");
          if ((args as any)?.action === "requests") return {success:true,requests:extra.mcpRequests ?? []};
          if ((args as any)?.action === "identities") return {success:true,identities:extra.mcpIdentities ?? []};
        }
        return { success: true };
      } }, event: { listen: (name: string, callback: (event: unknown)=>unknown) => {
        listeners.set("tauri:" + name, callback);
        return Promise.resolve(() => {});
      } } },
      addEventListener: () => {},
      dispatchEvent: (e: { type: string }) => events.push(e.type),
      confirm,
      navigateToPage: vi.fn(),
      __superagentAccessManagerOpenTab: vi.fn(),
      navigator: { clipboard: { writeText: copy } },
    },
    setInterval: vi.fn(),
    setTimeout: (fn: Function, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: any) => clearTimeout(id),
    Event: class { constructor(public type: string) {} },
    alert: vi.fn(),
    Date, Number, String, Array, Math, URL,
  });
  vm.runInContext(js, context);
  return { byId, requested, events, context, listeners, confirm, copy };
}

describe("SuperAgent desktop Runtime Detection UI", () => {
  it("hides agent-owned maintenance and Android screen controls without removing their backend hooks", () => {
    const html = fs.readFileSync(path.resolve("apps/superagent-tray/ui/index.html"), "utf8");
    const css = fs.readFileSync(path.resolve("apps/superagent-tray/ui/styles.css"), "utf8");
    for (const id of ["lifecycle-console", "lan-screen-panel"]) {
      const section = html.match(new RegExp('<section id="' + id + '"[^>]*>'))?.[0] || "";
      expect(section).toContain(" hidden ");
      expect(section).toContain(" inert ");
      expect(section).toMatch(/aria-hidden="true"/);
      expect(css).toContain("#" + id + "[hidden]");
    }
    expect(html).toContain('class="runtime-service-tabs"');
  });
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
    expect(ui.byId("runtime-remote-count").textContent).toContain("0 active/detected");
    expect(ui.byId("runtime-tab-core-count").textContent).toBe("1");
    expect(ui.byId("runtime-tab-mcp-count").textContent).toBe("1");
    expect(ui.byId("runtime-tab-cloudflare-count").textContent).toBe("1");
    expect(ui.byId("runtime-tab-muse-count").textContent).toBe("2");
    expect(ui.byId("runtime-tab-processes-count").textContent).toBe("2");
    expect(ui.byId("runtime-tab-hosts-count").textContent).toBe("1");
    expect(ui.byId("runtime-servers-panel").hidden).toBe(false);
    expect(ui.byId("runtime-processes-panel").hidden).toBe(true);
  });

  it("lists unmanaged cloudflared processes as read-only without leaking command arguments", async () => {
    const ui = mountRuntime({
      scannedAt: Date.now(), healthyCoreCount: 0, activeProcessCount: 0,
      cores: [], processes: [], independentHosts: [],
      remoteServices: [
        {kind: "cloudflare", source: "registry", port: 9227, pid: 101,
          state: "online", transport: "mcp-http", detail: "Verified owner"},
        {kind: "cloudflare", source: "os", port: 8080, pid: 202,
          state: "observed", transport: "quick",
          detail: "Quick Tunnel process; edge health not verified",
          controlReason: "External OS process: read-only",
          canStop: false, canRestart: false},
        {kind: "cloudflare", source: "os", pid: 303,
          state: "observed", transport: "named",
          detail: "<img src=x> process", canStop: false, canRestart: false},
      ],
    });
    await new Promise(resolve => setImmediate(resolve));
    vm.runInContext('runtimeSelectTab("cloudflare")', ui.context);
    expect(ui.byId("runtime-tab-cloudflare-count").textContent).toBe("3");
    expect(ui.byId("runtime-remote-count").textContent).toContain("3 found");
    const html = ui.byId("runtime-remote").innerHTML;
    expect(html).toContain("External Cloudflare Tunnel");
    expect(html).toContain("PID 202");
    expect(html).toContain("quick");
    expect(html).toContain("named");
    expect(html).toContain("Read-only · External process");
    expect(html).toContain("&lt;img src=x&gt;");
    expect(html).not.toContain("<img src=x>");
    const cards = html.split("</article>").filter(part => part.includes('data-runtime-service-kind="cloudflare"'));
    expect(cards).toHaveLength(3);
    expect(cards[1]).not.toContain("runtime-lifecycle");
    expect(cards[2]).not.toContain("runtime-lifecycle");
    await vm.runInContext('runtimeServiceAction({target:{closest:()=>({disabled:false,dataset:{runtimeKind:"cloudflare",runtimeAction:"stop",runtimePort:"8080",runtimePid:"202"}})}})', ui.context);
    expect(ui.requested.some(entry => entry.action === "service_action")).toBe(false);
    expect(ui.byId("runtime-notes").textContent).toContain("OS cloudflared processes");
  });

  it("shows owner-recorded MCP and Quick ingress URLs, never external or token-bearing URLs", async () => {
    const ui = mountRuntime({
      scannedAt: Date.now(), healthyCoreCount: 0, activeProcessCount: 0,
      cores: [], processes: [], independentHosts: [],
      remoteServices: [
        {kind:"mcp",source:"registry",state:"observed",port:9227,pid:100,
          publicUrl:"https://mcp.rcity.web.id/mcp",urlEvidence:"verified local owner"},
        {kind:"cloudflare",source:"registry",state:"online",port:9227,pid:101,
          publicUrl:"https://example-public.trycloudflare.com",urlEvidence:"healthy heartbeat"},
        {kind:"cloudflare",source:"os",state:"observed",pid:102,
          publicUrl:"https://external.trycloudflare.com",transport:"named"},
        {kind:"cloudflare",source:"registry",state:"online",pid:103,
          publicUrl:"https://bad.trycloudflare.com/?token=secret"},
      ],
    });
    await new Promise(resolve => setImmediate(resolve));
    const html=ui.byId("runtime-remote").innerHTML;
    expect(html).toContain("https://mcp.rcity.web.id/mcp");
    expect(html).toContain("https://example-public.trycloudflare.com");
    expect(html).not.toContain("external.trycloudflare.com");
    expect(html).not.toContain("token=secret");
    expect(html.match(/runtime-copy-public-url/g)).toHaveLength(2);
    expect(ui.byId("runtime-tray-gateway").hidden).toBe(true);
    vm.runInContext('runtimeSelectTab("cloudflare")',ui.context);
    expect(ui.byId("runtime-tray-gateway").hidden).toBe(false);
  });

  it("displays the password-protected Tray Quick URL separately and copies only allowlisted URLs", async () => {
    const gateway={active:true, configured:true, mode:"quick", connectorReady:true,
      publicUrl:"https://tray-demo.trycloudflare.com",originPort:19330,routeVerified:false};
    const ui=mountRuntime({
      scannedAt:Date.now(),cores:[],processes:[],independentHosts:[],remoteServices:[],
    },{gateway});
    await new Promise(resolve=>setImmediate(resolve));
    const html=ui.byId("runtime-tray-gateway").innerHTML;
    expect(html).toContain("SuperAgent Tray · Quick Tunnel");
    expect(html).toContain("https://tray-demo.trycloudflare.com");
    expect(html).toContain("public HTTPS reachability not independently verified");
    expect(html).toContain("Copy URL");
    const click=(url:string)=>vm.runInContext(
      `runtimeCopyPublicUrl({target:{closest:()=>({disabled:false,dataset:{runtimeCopyUrl:${JSON.stringify(url)}}})}})`,ui.context
    ) as Promise<void>;
    await click("https://tray-demo.trycloudflare.com");
    await click("https://evil.trycloudflare.com");
    await click("https://tray-demo.trycloudflare.com/?token=abcd");
    expect(ui.copy).toHaveBeenCalledTimes(1);
    expect(ui.copy).toHaveBeenCalledWith("https://tray-demo.trycloudflare.com");
    expect(ui.requested).toContainEqual({action:"desktop_live_action",args:{action:"gateway-status",payload:null}});
    expect(ui.requested.some(entry=>entry.action==="service_action")).toBe(false);
  });

  it("never offers stale, malformed or credential-bearing Tray URLs for copy", async () => {
    const snapshot={scannedAt:Date.now(),cores:[],processes:[],independentHosts:[],remoteServices:[]};
    for (const gateway of [
      {active:false, configured:true, mode:"quick", connectorReady:true, publicUrl:"https://old.trycloudflare.com"},
      {active:true, configured:false, mode:"quick", connectorReady:true, publicUrl:"https://old.trycloudflare.com"},
      {active:true, configured:true, mode:"quick", connectorReady:false, publicUrl:"https://old.trycloudflare.com"},
      {active:true, configured:true, mode:"named", publicUrl:"https://tray.test"},
      {active:true, configured:true, mode:"named", publicUrl:"https://tray.rcity.web.id/?token=secret"},
    ]) {
      const ui=mountRuntime(snapshot,{gateway});
      await new Promise(resolve=>setImmediate(resolve));
      const html=ui.byId("runtime-tray-gateway").innerHTML;
      expect(html).not.toContain("runtime-copy-public-url");
      expect(html).not.toContain("token=secret");
      expect(html).not.toContain("href=");
    }
  });

  it("requires a verified connector, owner and edge OAuth challenge before copying MCP Named URL", async () => {
    const snapshot={scannedAt:Date.now(),cores:[],processes:[],independentHosts:[],remoteServices:[]};
    const named={hostname:"mcp.rcity.web.id",connectorStatus:"verified_local_only",
      anchorStatus:"verified_local",ownerStatus:"verified_local",
      mcpAuthChallengeObserved:true,edgeObserved:true};
    const verified=mountRuntime(snapshot,{named});
    await new Promise(resolve=>setImmediate(resolve));
    expect(verified.byId("runtime-named-mcp-status").innerHTML).toContain("https://mcp.rcity.web.id/mcp");
    expect(verified.byId("runtime-named-mcp-status").innerHTML).toContain("Copy URL");
    const unverified=mountRuntime(snapshot,{named:{...named,ownerStatus:"not_verified"}});
    await new Promise(resolve=>setImmediate(resolve));
    expect(unverified.byId("runtime-named-mcp-status").innerHTML).toContain("Not verified end-to-end");
    expect(unverified.byId("runtime-named-mcp-status").innerHTML).not.toContain("Copy URL");
  });

  it("separates Core, MCP, Cloudflare, Muse, Processes and Hosts into accessible tabs", async () => {
    const ui = mountRuntime({
      scannedAt: Date.now(), healthyCoreCount: 1, activeProcessCount: 1,
      selectedCorePort: 7888,
      cores: [{port: 7888, pid: 1234, state: "online", selected: true, pidVerified: true,
        services: {muse: {watcherActive: true, ownerPresent: true, transport: "websocket"}}}],
      processes: [{pid: 1111, role: "CLI", state: "active", heartbeatAgeSeconds: 2}],
      independentHosts: [{kind: "tline-transport", port: 7891, pid: 2222, state: "active"}],
      remoteServices: [
        {kind: "core-supervisor", port: 7888, pid: 1234, state: "observed"},
        {kind: "mcp", port: 9555, pid: 3333, state: "online"},
        {kind: "cloudflare", port: 9555, pid: 4444, state: "online"},
        {kind: "muse-watch", port: 9225, pid: 5555, state: "online"},
      ],
    });
    await new Promise(resolve => setImmediate(resolve));
    expect(ui.byId("runtime-remote").innerHTML).toContain('data-runtime-service-kind="mcp"');
    expect(ui.byId("runtime-remote").innerHTML).toContain('data-runtime-service-kind="cloudflare"');
    expect(ui.byId("runtime-remote").innerHTML).toContain('data-runtime-service-kind="muse-watch"');
    expect(ui.byId("runtime-remote").dataset.runtimeView).toBe("core");
    expect(ui.byId("runtime-remote-panel").hidden).toBe(false);

    vm.runInContext('runtimeSelectTab("mcp")', ui.context);
    expect(ui.byId("runtime-servers-panel").hidden).toBe(true);
    expect(ui.byId("runtime-remote-panel").hidden).toBe(false);
    expect(ui.byId("runtime-remote").dataset.runtimeView).toBe("mcp");
    expect(ui.byId("runtime-remote-heading").textContent).toBe("Independent MCP Owners");
    expect(ui.byId("runtime-remote-count").textContent).toContain("1 active/detected");
    expect(ui.byId("runtime-tab-mcp").attributes["aria-selected"]).toBe("true");

    const preventDefault = vi.fn();
    const keydown = ui.listeners.get("runtime-tab-mcp:keydown");
    expect(keydown).toBeDefined();
    keydown?.({currentTarget: {dataset: {runtimeTab: "mcp"}}, key: "ArrowRight", preventDefault});
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(ui.byId("runtime-remote").dataset.runtimeView).toBe("cloudflare");
    expect(ui.byId("runtime-tab-cloudflare").focus).toHaveBeenCalledOnce();

    vm.runInContext('runtimeSelectTab("muse")', ui.context);
    expect(ui.byId("runtime-muse-panel").hidden).toBe(false);
    expect(ui.byId("runtime-muse-local").innerHTML).toContain("Stop Muse");
    expect(ui.byId("runtime-remote").dataset.runtimeView).toBe("muse");
    expect(ui.byId("runtime-muse-local").innerHTML).toContain("Regenerate Muse Token");

    vm.runInContext('runtimeSelectTab("processes")', ui.context);
    expect(ui.byId("runtime-processes-panel").hidden).toBe(false);
    expect(ui.byId("runtime-remote-panel").hidden).toBe(true);
    vm.runInContext('runtimeSelectTab("hosts")', ui.context);
    expect(ui.byId("runtime-hosts-panel").hidden).toBe(false);

    // A periodic native snapshot refresh preserves the selected tab.
    vm.runInContext('runtimeRender(runtimeLastResult)', ui.context);
    expect(ui.byId("runtime-hosts-panel").hidden).toBe(false);
    expect(ui.requested.every(item => item.action !== "service_action")).toBe(true);
  });

  it("shows Stopping immediately then animates verified MCP stop out of the list", async () => {
    const owner={kind:"mcp",source:"registry",port:9227,pid:3628,
      state:"observed",canStop:true,canRestart:true,transport:"cloudflare"};
    const snapshot={scannedAt:Date.now(),cores:[],processes:[],
      independentHosts:[],remoteServices:[owner]};
    const ui=mountRuntime(snapshot);
    await new Promise(resolve=>setImmediate(resolve));
    vm.runInContext('runtimeSelectTab("mcp")',ui.context);
    const initial=ui.context.window.__TAURI__.core.invoke;
    let acceptStop: ((value:unknown)=>void)|undefined;
    ui.context.window.__TAURI__.core.invoke=async(action:string,args:any)=>{
      if(action==="service_action")return new Promise(resolve=>{acceptStop=resolve;});
      if(action==="detect_runtime")return {...snapshot,
        remoteServices:[{...owner,state:"stale",canStop:false,canRestart:false}]};
      return initial(action,args);
    };
    const pending=vm.runInContext(
      'runtimeServiceAction({target:{closest:()=>({disabled:false,dataset:{runtimeKind:"mcp",runtimeAction:"stop",runtimePort:"9227",runtimePid:"3628"}})}})',
      ui.context) as Promise<void>;
    expect(ui.byId("runtime-remote").innerHTML).toContain("Stopping…");
    expect(ui.byId("runtime-remote").innerHTML).toContain("runtime-instance--stopping");
    expect(ui.byId("runtime-remote").innerHTML).not.toContain("Regenerate Token");
    expect(ui.byId("runtime-tab-mcp-count").textContent).toBe("1");
    expect(acceptStop).toBeTypeOf("function");
    acceptStop!({success:true,message:"MCP owner stopped gracefully"});
    await pending;
    expect(ui.byId("runtime-remote").innerHTML).toContain("runtime-instance--stopped");
    expect(ui.byId("runtime-remote").innerHTML).toContain("Owner exit verified");
    await new Promise(resolve=>setTimeout(resolve,460));
    expect(ui.byId("runtime-remote").innerHTML).not.toContain("MCP HTTP Server");
    expect(ui.byId("runtime-tab-mcp-count").textContent).toBe("0");
    expect(ui.byId("runtime-remote-empty").hidden).toBe(false);
    expect(ui.requested.filter(item=>item.action==="service_action")).toHaveLength(0);
    const css=fs.readFileSync(path.resolve("apps/superagent-tray/ui/styles.css"),"utf8");
    expect(css).toContain("@keyframes runtime-owner-exit");
    expect(css).toContain(".runtime-instance--stopping");
    expect(css).toContain("prefers-reduced-motion: reduce");
  });

  it("ignores a pre-stop in-flight scan and queues an up-to-date verification scan", async () => {
    const owner={kind:"mcp",source:"registry",port:9227,pid:3628,
      state:"observed",canStop:true,transport:"cloudflare"};
    const snapshot={scannedAt:Date.now(),cores:[],processes:[],
      independentHosts:[],remoteServices:[owner]};
    const ui=mountRuntime(snapshot);
    await new Promise(resolve=>setImmediate(resolve));
    vm.runInContext('runtimeSelectTab("mcp")',ui.context);
    const initial=ui.context.window.__TAURI__.core.invoke;
    let completeOldScan:((value:unknown)=>void)|undefined;
    let reads=0;
    ui.context.window.__TAURI__.core.invoke=async(action:string,args:any)=>{
      if(action==="detect_runtime"){
        reads++;
        return reads===1 ? new Promise(resolve=>{completeOldScan=resolve;}) :
          {...snapshot,remoteServices:[{...owner,state:"stale",canStop:false}]};
      }
      if(action==="service_action")return {success:true,message:"Exited"};
      return initial(action,args);
    };
    const scanning=vm.runInContext("runtimeRefresh(true)",ui.context) as Promise<void>;
    expect(completeOldScan).toBeTypeOf("function");
    const stopping=vm.runInContext(
      'runtimeServiceAction({target:{closest:()=>({disabled:false,dataset:{runtimeKind:"mcp",runtimeAction:"stop",runtimePort:"9227",runtimePid:"3628"}})}})',
      ui.context) as Promise<void>;
    await stopping;
    completeOldScan!(snapshot); // old scan saw owner before it exited
    await scanning;
    await new Promise(resolve=>setImmediate(resolve));
    expect(reads).toBeGreaterThanOrEqual(2);
    await new Promise(resolve=>setTimeout(resolve,460));
    expect(ui.byId("runtime-tab-mcp-count").textContent).toBe("0");
    expect(ui.byId("runtime-remote").innerHTML).not.toContain("MCP HTTP Server");
  });

  it("animates a shutdown-manager verified MCP owner exit without waiting for scheduled polling", async () => {
    const owner={kind:"mcp",source:"registry",port:9227,pid:3628,
      state:"observed",canStop:true,transport:"cloudflare"};
    const snapshot={scannedAt:Date.now(),cores:[],processes:[],
      independentHosts:[],remoteServices:[owner]};
    const ui=mountRuntime(snapshot);
    await new Promise(resolve=>setImmediate(resolve));
    vm.runInContext('runtimeSelectTab("mcp")',ui.context);
    const nativeProgress=ui.listeners.get("tauri:shutdown-manager-progress");
    expect(nativeProgress).toBeTypeOf("function");
    // A blocked or unrelated stop receipt must not hide an owner.
    nativeProgress?.({payload:{stage:"partial",steps:[{
      id:"mcp:9227:3628",status:"blocked"},{id:"mcp:9227:1234",status:"stopped"}]}});
    expect(ui.byId("runtime-remote").innerHTML).toContain("MCP HTTP Server");
    const originalInvoke=ui.context.window.__TAURI__.core.invoke;
    ui.context.window.__TAURI__.core.invoke=async(action:string,args:any)=>{
      if(action==="detect_runtime")return {...snapshot,
        remoteServices:[{...owner,state:"stale",canStop:false}]};
      return originalInvoke(action,args);
    };
    nativeProgress?.({payload:{stage:"complete",steps:[{
      id:"mcp:9227:3628",label:"MCP owner",status:"stopped"}]}});
    expect(ui.byId("runtime-remote").innerHTML).toContain("runtime-instance--stopped");
    await new Promise(resolve=>setTimeout(resolve,460));
    expect(ui.byId("runtime-remote").innerHTML).not.toContain("MCP HTTP Server");
    expect(ui.byId("runtime-tab-mcp-count").textContent).toBe("0");
  });

  it("reverses pending Stop when native control rejects or reports an uncertain outcome", async () => {
    const owner={kind:"mcp",source:"registry",port:9227,pid:3628,
      state:"observed",canStop:true,transport:"cloudflare"};
    const snapshot={scannedAt:Date.now(),cores:[],processes:[],
      independentHosts:[],remoteServices:[owner]};
    const ui=mountRuntime(snapshot);
    await new Promise(resolve=>setImmediate(resolve));
    vm.runInContext('runtimeSelectTab("mcp")',ui.context);
    const initial=ui.context.window.__TAURI__.core.invoke;
    ui.context.window.__TAURI__.core.invoke=async(action:string,args:any)=>{
      if(action==="service_action")throw Error("MCP owner shutdown timeout");
      return initial(action,args);
    };
    await (vm.runInContext(
      'runtimeServiceAction({target:{closest:()=>({disabled:false,dataset:{runtimeKind:"mcp",runtimeAction:"stop",runtimePort:"9227",runtimePid:"3628"}})}})',
      ui.context) as Promise<void>);
    expect(ui.byId("runtime-remote").innerHTML).toContain("MCP HTTP Server");
    expect(ui.byId("runtime-remote").innerHTML).not.toContain("runtime-instance--stopped");
    expect(ui.byId("runtime-tab-mcp-count").textContent).toBe("1");
    expect(ui.byId("runtime-action-feedback").textContent).toContain("Outcome uncertain");
  });

  it("reconciles a fresh scan started in the same millisecond as a verified stop", async () => {
    const owner = {kind:"mcp",source:"registry",port:9227,pid:3628,
      state:"observed",canStop:true,transport:"cloudflare"};
    const snapshot = {scannedAt:Date.now(),cores:[],processes:[],
      independentHosts:[],remoteServices:[owner]};
    const ui = mountRuntime(snapshot);
    await new Promise(resolve => setImmediate(resolve));
    vm.runInContext('runtimeSelectTab("mcp")',ui.context);
    // Date.now() cannot distinguish the ordered receipt/scan on a fast runner.
    const frozen = Date.now();
    ui.context.Date = class FixedDate extends Date {
      static now() { return frozen; }
    };
    await (vm.runInContext(
      'runtimeServiceAction({target:{closest:()=>({disabled:false,dataset:{runtimeKind:"mcp",runtimeAction:"stop",runtimePort:"9227",runtimePid:"3628"}})}})',
      ui.context) as Promise<void>);
    expect(ui.byId("runtime-remote").innerHTML).toContain("MCP HTTP Server");
    expect(ui.byId("runtime-remote").innerHTML).not.toContain("runtime-instance--stopped");
    expect(ui.byId("runtime-tab-mcp-count").textContent).toBe("1");
  });

  it("re-shows an owner if a fresh scan still observes it despite a stop receipt", async () => {
    const owner={kind:"mcp",source:"registry",port:9227,pid:3628,
      state:"observed",canStop:true,transport:"cloudflare"};
    const snapshot={scannedAt:Date.now(),cores:[],processes:[],
      independentHosts:[],remoteServices:[owner]};
    const ui=mountRuntime(snapshot);
    await new Promise(resolve=>setImmediate(resolve));
    vm.runInContext('runtimeSelectTab("mcp")',ui.context);
    await (vm.runInContext(
      'runtimeServiceAction({target:{closest:()=>({disabled:false,dataset:{runtimeKind:"mcp",runtimeAction:"stop",runtimePort:"9227",runtimePid:"3628"}})}})',
      ui.context) as Promise<void>);
    // Verified native receipt briefly displays a 420ms Stopped animation.
    // The fresh runtime scan, not the old pre-stop cache, must then restore
    // the card if the exact owner is still observed alive.
    expect(ui.byId("runtime-remote").innerHTML).toContain("runtime-instance--stopped");
    await new Promise(resolve=>setTimeout(resolve,460));
    await (vm.runInContext("runtimeRefresh(true)",ui.context) as Promise<void>);
    await new Promise(resolve=>setImmediate(resolve));
    expect(ui.byId("runtime-remote").innerHTML).toContain("MCP HTTP Server");
    expect(ui.byId("runtime-remote").innerHTML).not.toContain("runtime-instance--stopped");
    expect(ui.byId("runtime-tab-mcp-count").textContent).toBe("1");
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

  it("shows Regenerate Token button on Cloudflare tunnel card when associated with an active MCP service", async () => {
    const ui = mountRuntime({
      scannedAt: Date.now(), healthyCoreCount: 1, activeProcessCount: 0,
      selectedCorePort: 7888,
      cores: [{ port: 7888, pid: 1234, pidVerified: true, state: "online", selected: true }],
      processes: [], independentHosts: [],
      remoteServices: [
        { kind: "mcp", port: 9227, pid: 25384, state: "observed", canRegenerateToken: true },
        { kind: "cloudflare", port: 9227, pid: 20968, state: "online", transport: "mcp-http", canRegenerateToken: false },
      ],
    });
    await new Promise(resolve => setImmediate(resolve));
    vm.runInContext('runtimeSelectTab("cloudflare")', ui.context);
    const html = ui.byId("runtime-remote").innerHTML;
    expect(html).toContain('data-runtime-service-kind="cloudflare"');
    expect(html).toContain('data-runtime-kind="mcp"');
    expect(html).toContain('data-runtime-port="9227"');
    expect(html).toContain('data-runtime-pid="25384"');
    expect(html).toContain("Regenerate Token");
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

  it("opens a focused connection-result modal and clears private data when closed", async () => {
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
    expect(ui.byId("runtime-create-result-dialog").hidden).toBe(false);
    expect(ui.byId("runtime-create-panel").hidden).toBe(true);
    expect(ui.byId("runtime-result-close").focus).toHaveBeenCalledTimes(1);
    ui.listeners.get("document:keydown")?.({key:"Escape",preventDefault:()=>{}});
    expect(ui.byId("runtime-create-result-dialog").hidden).toBe(true);
    expect(ui.byId("runtime-create-result").hidden).toBe(true);
    expect(ui.byId("runtime-create-result").textContent).toBe("");
    expect(ui.byId("runtime-create-toggle").focus).toHaveBeenCalledTimes(1);
  });

  it("renders endpoint with a working Copy Endpoint button and clipboard interaction", async () => {
    let clipboardText = "";
    const createdElements: any[] = [];
    const ui = mountRuntime({
      scannedAt: Date.now(), healthyCoreCount: 1, activeProcessCount: 0, selectedCorePort: 7888,
      cores: [{ port: 7888, pid: 100, state: "online", selected: true, pidVerified: true }],
      processes: [], independentHosts: [], remoteServices: [],
    });
    const resultView = ui.byId("runtime-create-result");
    resultView.children = [];
    resultView.replaceChildren = function (...nodes: any[]) {
      this.children = [...nodes];
    };
    resultView.appendChild = function (child: any) {
      this.children.push(child);
    };

    ui.context.document.createElement = (tag: string) => {
      const el: any = {
        tagName: tag.toUpperCase(),
        children: [] as any[],
        className: "",
        textContent: "",
        innerHTML: "",
        attributes: {} as Record<string, string>,
        setAttribute(k: string, v: string) { this.attributes[k] = v; },
        appendChild(child: any) { this.children.push(child); },
        append(...items: any[]) { this.children.push(...items); },
        listeners: {} as Record<string, Function>,
        addEventListener(event: string, fn: Function) { this.listeners[event] = fn; },
        classList: {
          add(c: string) { el.className = (el.className + " " + c).trim(); },
          remove(c: string) { el.className = el.className.replace(new RegExp(`\\b${c}\\b`, "g"), "").trim(); },
          contains(c: string) { return el.className.split(" ").includes(c); },
        },
      };
      createdElements.push(el);
      return el;
    };

    ui.context.navigator = {
      clipboard: {
        writeText: vi.fn(async (text: string) => {
          clipboardText = text;
        }),
      },
    };

    const origInvoke = ui.context.window.__TAURI__.core.invoke;
    ui.context.window.__TAURI__.core.invoke = async (action: string, args: any) => {
      if (action === "create_connection") {
        return {
          success: true,
          endpoint: "https://sodium-test.trycloudflare.com/mcp",
          message: "MCP tunnel started.",
        };
      }
      return origInvoke(action, args);
    };

    await new Promise(resolve => setImmediate(resolve));
    ui.byId("runtime-create-kind").value = "mcp-tunnel";
    ui.byId("runtime-create-port").value = "9267";
    ui.byId("runtime-create-provider").value = "cloudflare";
    await (vm.runInContext("runtimeCreateConnection({preventDefault(){}})", ui.context) as Promise<void>);

    expect(resultView.hidden).toBe(false);

    const copyBtn = createdElements.find(
      (el) => el.tagName === "BUTTON" && el.className.includes("runtime-copy-endpoint-btn")
    );
    expect(copyBtn).toBeDefined();
    expect(copyBtn.textContent).toBe("Copy Endpoint");
    expect(copyBtn.attributes["aria-label"]).toContain("Copy endpoint URL");

    await copyBtn.listeners["click"]();
    expect(ui.context.navigator.clipboard.writeText).toHaveBeenCalledWith(
      "https://sodium-test.trycloudflare.com/mcp"
    );
    expect(clipboardText).toBe("https://sodium-test.trycloudflare.com/mcp");
    expect(copyBtn.textContent).toBe("Copied!");
    expect(copyBtn.classList.contains("copied")).toBe(true);

    const css = fs.readFileSync(path.resolve("apps/superagent-tray/ui/styles.css"), "utf8");
    expect(css).toContain(".runtime-result-endpoint-row");
    expect(css).toContain(".runtime-copy-endpoint-btn");
    expect(css).toContain(".runtime-copy-inline.copied");
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
  it("omits the quick panel and blocks Muse actions for an unverified Core",async()=>{
    const ui=mountRuntime({
      scannedAt:Date.now(),healthyCoreCount:0,activeProcessCount:0,
      selectedCorePort:7888,
      cores:[{port:7888,pid:200,pidVerified:false,state:"unverified",
        services:{muse:{watcherActive:false}}}],
      processes:[],independentHosts:[],remoteServices:[],
    });
    await new Promise(resolve=>setImmediate(resolve));
    const html=ui.byId("runtime-servers").innerHTML;
    expect(html).not.toContain("Service Quick Controls");
    expect(html).not.toContain("Start Muse · Telegram");
    expect(html).toContain("Core · :7888");
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
    expect(html).not.toContain("Service Quick Controls");
    expect(html).not.toContain("Start Muse · Telegram");
    expect(html).toContain("Core · :7888");
    await (vm.runInContext('window.__superagentMuseQuickAction("start-telegram")',
      ui.context) as Promise<void>);
    expect(ui.requested.filter(x=>x.action==="service_action")).toHaveLength(0);
  });

  it("keeps MCP setup accessible through Create Connection without the quick panel",async()=>{
    const ui=mountRuntime({
      scannedAt:Date.now(),healthyCoreCount:1,activeProcessCount:0,
      selectedCorePort:7888,
      cores:[{port:7888,pid:300,pidVerified:true,state:"online",
        services:{muse:{watcherActive:false}}}],
      processes:[],independentHosts:[],remoteServices:[],
    });
    await new Promise(resolve=>setImmediate(resolve));
    expect(ui.byId("runtime-servers").innerHTML).not.toContain("Service Quick Controls");
    const panel=ui.byId("runtime-create-panel");
    panel.hidden=true;
    const toggle=ui.listeners.get("runtime-create-toggle:click");
    expect(toggle).toBeTypeOf("function");
    toggle?.({target:ui.byId("runtime-create-toggle")});
    expect(panel.hidden).toBe(false);
    ui.byId("runtime-create-kind").value="mcp-tunnel";
    vm.runInContext("runtimeCreateKindChanged()",ui.context);
    expect(ui.byId("runtime-create-kind").value).toBe("mcp-tunnel");
    expect(ui.requested.filter(x=>x.action==="create_connection")).toHaveLength(0);
  });

  it("removes Chat Agent YOLO toggles from MCP cards but keeps a read-only Security Approval summary", async () => {
    const ui = mountRuntime({
      scannedAt: Date.now(), healthyCoreCount: 1, activeProcessCount: 0,
      selectedCorePort: 7888, cores: [], processes: [], independentHosts: [],
      remoteServices: [{
        kind: "mcp", source: "registry", port: 9227, pid: 8260,
        state: "observed", canStop: true, canRestart: true,
        transport: "mcp-http", detail: "MCP listener", evidence: "owner PID verified",
      }],
    }, {
      mcpRequests: [
        { projectId: "mcp-connection", status: "pending" },
        { projectId: "shop", status: "pending" },
        { projectId: "shop", status: "approved" },
      ],
      mcpIdentities: [{ subject: "Gemini", identityHandle: "idh_abcdef1234567890", scopes: [] }],
    });
    await new Promise(resolve => setImmediate(resolve));
    const owner = ui.byId("runtime-remote").innerHTML;
    expect(owner).toContain("OAuth + Security Approval");
    expect(owner).not.toContain("runtime-yolo-control");
    expect(owner).not.toContain("data-runtime-yolo");
    const overview = ui.byId("runtime-mcp-security").innerHTML;
    expect(overview).toContain('data-runtime-security-tab="connections"');
    expect(overview).toContain('data-runtime-security-tab="mcp"');
    vm.runInContext('runtimeSelectTab("mcp")', ui.context);
    await new Promise(resolve => setImmediate(resolve));
    expect(ui.byId("runtime-mcp-security").hidden).toBe(false);
    expect(ui.byId("runtime-mcp-connection-pending").textContent).toBe("1");
    expect(ui.byId("runtime-mcp-project-pending").textContent).toBe("1");
    expect(ui.byId("runtime-mcp-approved-summary").textContent).toContain("riwayat");
    expect(ui.byId("runtime-mcp-identity-summary").textContent).toContain("bukan jumlah online");
    expect(ui.byId("runtime-mcp-access-status").dataset.state).toBe("ready");
    expect(ui.requested.some(r => r.action === "set_yolo_mode")).toBe(false);
  });

  it("opens dedicated native Security Approval tabs without changing YOLO or granting MCP permissions", async () => {
    const ui = mountRuntime({
      scannedAt: Date.now(), healthyCoreCount: 0, activeProcessCount: 0,
      cores: [], processes: [], remoteServices: [], independentHosts: [],
    });
    await new Promise(resolve => setImmediate(resolve));
    const clickHandler = ui.listeners.get("runtime-remote-panel:click");
    expect(clickHandler).toBeTypeOf("function");
    await clickHandler?.({ target: { closest: (selector:string) => selector === "button[data-runtime-security-tab]"
      ? {dataset:{runtimeSecurityTab:"connections"},disabled:false} : null } });
    expect((ui.context.window as any).navigateToPage).toHaveBeenCalledWith("security");
    expect((ui.context.window as any).__superagentAccessManagerOpenTab).toHaveBeenCalledWith("connections");
    expect(ui.requested.some(x => x.action === "set_yolo_mode" ||
      x.action === "mcp_project_access_action")).toBe(false);
  });

  it("displays MCP permission read failure explicitly instead of reporting zero grants", async () => {
    const ui = mountRuntime({
      scannedAt: Date.now(), healthyCoreCount: 0, activeProcessCount: 0,
      cores: [], processes: [], remoteServices: [], independentHosts: [],
    }, { failMcp: true });
    await new Promise(resolve => setImmediate(resolve));
    vm.runInContext('runtimeSelectTab("mcp")', ui.context);
    await new Promise(resolve => setImmediate(resolve));
    expect(ui.byId("runtime-mcp-connection-pending").textContent).toBe("—");
    expect(ui.byId("runtime-mcp-project-pending").textContent).toBe("—");
    expect(ui.byId("runtime-mcp-access-status").dataset.state).toBe("error");
    expect(ui.byId("runtime-mcp-access-status").textContent).toContain("bukan berarti nol");
  });

  it("changes Chat Agent YOLO only via installed native Tray and never requests an MCP grant", async () => {
    const ui = mountRuntime({
      scannedAt: Date.now(), healthyCoreCount: 0, activeProcessCount: 0,
      cores: [], processes: [], remoteServices: [], independentHosts: [],
    });
    await new Promise(resolve => setImmediate(resolve));
    await vm.runInContext('runtimeSetYoloMode("scoped")', ui.context);
    expect(ui.requested.filter(x => x.action === "set_yolo_mode"))
      .toEqual([{action:"set_yolo_mode",args:{mode:"scoped"}}]);
    expect(ui.requested.some(x => x.action === "mcp_project_access_action")).toBe(false);
    expect(js).not.toContain('fetch("/api/desktop/yolo"');
  });

  it("keeps chat-only YOLO controls on the Core card, not MCP owners", async () => {
    const ui = mountRuntime({
      scannedAt: Date.now(), healthyCoreCount: 1, activeProcessCount: 0,
      cores: [{port:7888,pid:199,state:"online",selected:true,evidence:"authenticated",
        services:{mcp:{active:true}},version:"1.14.105"}],
      processes: [], remoteServices: [{kind:"mcp",pid:299,port:9227,state:"observed"}],
      independentHosts: [],
    });
    await new Promise(resolve => setImmediate(resolve));
    expect(ui.byId("runtime-servers").innerHTML).toContain("Chat Agent YOLO Policy");
    expect(ui.byId("runtime-remote").innerHTML).not.toContain("YOLO Full");
    expect(ui.byId("runtime-remote").innerHTML).not.toContain("data-runtime-yolo");
  });
});
