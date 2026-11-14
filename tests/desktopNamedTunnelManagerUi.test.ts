import {describe, expect, it, vi} from "vitest";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const source = fs.readFileSync(path.resolve("apps/superagent-tray/ui/named-tunnel-manager.js"), "utf8");
const markup = fs.readFileSync(path.resolve("apps/superagent-tray/ui/index.html"), "utf8");
const styles = fs.readFileSync(path.resolve("apps/superagent-tray/ui/named-tunnel-manager.css"), "utf8");
const tunnelId = "b2e8c6d9-9317-4d9e-b381-826af22e1778";
const config = {
  version:1, connectorMode:"remote-managed", tunnelId, hostname:"mcp.rcity.web.id",
  anchorPort:19320, ownerPort:19321, tokenFilePath:"",
  credentialsFilePath:"", cloudflaredPath:"C:\\trusted\\cloudflared.exe",
};
const defaultStatus = {
  quickTunnelUntouched:true, tunnelId, hostname:"mcp.rcity.web.id",
  anchorPort:19320,ownerPort:19321,configured:true,
  tokenVerified:true, anchorStatus:"not_verified",
  ownerStatus:"not_verified", connectorStatus:"not_started", edgeObserved:false,
  mcpAuthChallengeObserved:false, oauthVerified:false, geminiVerified:false,
};
type Options = {
  status?: Record<string,unknown>;
  health?: Record<string,unknown>;
  plan?: Record<string,unknown>;
  failStatus?: string;
  failPlan?: string;
  confirm?: boolean;
};
function setup(opts:Options = {}) {
  const elements = new Map<string,any>();
  const listeners = new Map<string, (event?:any)=>any>();
  const nativeCalls:Array<{command:string, args?:any}> = [];
  const confirmations:string[] = [];
  const existingClicks:string[] = [];
  const named = (id:string) => {
    if (!elements.has(id)) elements.set(id,{
      value:"", textContent:"", disabled:false, hidden:false, checked:false,
      dataset:{}, events:{} as Record<string,any>,
      addEventListener(event:string, fn:any) { listeners.set(id+":"+event, fn); },
      setAttribute(name:string, value:any) { this[name]=value; },
      click() { if (!this.disabled) {
        existingClicks.push(id);
        return listeners.get(id+":click")?.();
      }},
      focus:vi.fn(), scrollIntoView:vi.fn(),
    });
    return elements.get(id);
  };
  for (const [field, value] of Object.entries({
    "named-tunnel-id":config.tunnelId, "named-tunnel-hostname":config.hostname,
    "named-tunnel-anchor-port":config.anchorPort, "named-tunnel-owner-port":config.ownerPort,
  })) named(field).value = String(value);
  for (const id of ["named-tunnel-import-clipboard","named-tunnel-import-token",
    "named-tunnel-check","named-tunnel-start"]) named(id);
  const invoke = vi.fn(async (command:string, args?:any) => {
    nativeCalls.push({command,args});
    if (command === "get_named_tunnel_settings") return {settings:{...config}};
    if (command === "get_named_tunnel_manager_status") {
      if (opts.failStatus) throw Error(opts.failStatus);
      return {...defaultStatus, ...opts.status};
    }
    if (command === "get_named_tunnel_health") return {
      quickTunnelUntouched:true,tunnelId,connectorStatus:"not_started",
      edgeObserved:false,mcpAuthChallengeObserved:false,edgeHttpStatus:530,
      ...opts.health,
    };
    if (command === "plan_named_tunnel_stack") {
      if (opts.failPlan) throw Error(opts.failPlan);
      return opts.plan || {noRuntimeMutation:true,requiresNativeApproval:true,
        status:{...defaultStatus, ...opts.status},availableActions:["start-anchor"]};
    }
    if (command === "named_tunnel_stack_action")
      return {quickTunnelUntouched:true,reviewed:true,
        status:{...defaultStatus},action:args.action};
    throw Error("Unexpected command "+command);
  });
  const doc = {readyState:"complete",getElementById:named};
  const win = {
    __TAURI__:{core:{invoke},event:{listen:vi.fn(async()=>()=>{})}},
    addEventListener:(event:string, fn:any)=>listeners.set("window:"+event,fn),
    confirm:(message:string)=>{confirmations.push(message);return opts.confirm!==false;},
  };
  vm.runInNewContext(source, {document:doc,window:win,Promise,Number,String,
    Object,Array,RegExp,Error,Boolean});
  return {named,listeners,nativeCalls,confirmations,existingClicks,invoke};
}
async function flush() {
  await new Promise<void>((resolve)=>setImmediate(resolve));
  await new Promise<void>((resolve)=>setImmediate(resolve));
}
function click(ui:ReturnType<typeof setup>,id:string) {
  return ui.listeners.get(id+":click")?.();
}
describe("Cloudflare Named Tunnel Manager UI", () => {
  it("integrates the five-step accessible native manager without replacing legacy settings", () => {
    expect(markup).toContain("./named-tunnel-manager.js");
    expect(markup).toContain("./named-tunnel-manager.css");
    expect(markup).toContain('id="named-tunnel-settings-form"');
    expect(markup).toContain('id="named-tunnel-import-clipboard"');
    for (const suffix of ["step1","step2","step3","step4","step5",
      "refresh","plan","start-anchor","start-owner","stop-owner","stop-anchor",
      "review","ack","start-connector","check-connector"])
      expect(markup).toContain('id="named-manager-'+suffix+'"');
    expect(markup).toMatch(/aria-live="polite"/);
    expect(styles).toContain("var(--bg-surface)");
    expect(styles).toContain("max-width: 375px");
  });

  it("only reads persisted settings and manager status on load, never invoking mutations", async () => {
    const ui=setup(); await flush();
    expect(ui.nativeCalls.map(x=>x.command).sort()).toEqual([
      "get_named_tunnel_health","get_named_tunnel_manager_status","get_named_tunnel_settings",
    ]);
    expect(ui.named("named-manager-step1").textContent).toBe("Saved and matched");
    expect(ui.named("named-manager-start-anchor").disabled).toBe(true);
    expect(ui.named("named-manager-review").disabled).toBe(true);
    expect(ui.confirmations).toHaveLength(0);
  });

  it("fails closed when the backend command is missing and does not expose exception secrets", async () => {
    const ui=setup({failStatus:"unknown command: --token SECRET-DO-NOT-ECHO"});
    await flush();
    expect(ui.named("named-manager-plan").disabled).toBe(true);
    for (const action of ["start-anchor","start-owner","stop-owner","stop-anchor"])
      expect(ui.named("named-manager-"+action).disabled).toBe(true);
    expect(ui.named("named-manager-message").textContent).not.toContain("SECRET-DO-NOT-ECHO");
    expect(ui.nativeCalls).toHaveLength(3);
  });

  it("uses a fresh, exact native plan and explicit human approval before starting an Anchor", async () => {
    const ui=setup(); await flush();
    expect(ui.named("named-manager-plan").disabled).toBe(false);
    click(ui,"named-manager-plan"); await flush();
    expect(ui.named("named-manager-start-anchor").disabled).toBe(false);
    expect(ui.named("named-manager-start-owner").disabled).toBe(true);
    click(ui,"named-manager-start-anchor"); await flush();
    const actions=ui.nativeCalls.filter(x=>x.command==="named_tunnel_stack_action");
    expect(actions).toHaveLength(1);
    expect(actions[0].args).toEqual({action:"start-anchor",expectedTunnelId:tunnelId,reviewed:true});
    expect(ui.confirmations).toHaveLength(1);
    expect(ui.confirmations[0]).toContain("Quick Tunnel");
    expect(ui.named("named-manager-start-anchor").disabled).toBe(true);
  });

  it("rejects a mismatched plan identity or missing no-Quick-Tunnel-mutation proof", async () => {
    for (const plan of [
      {noRuntimeMutation:true,requiresNativeApproval:true,
        status:{...defaultStatus,tunnelId:"wrong"},availableActions:["start-anchor"]},
      {noRuntimeMutation:false,requiresNativeApproval:true,
        status:{...defaultStatus},availableActions:["start-anchor"]},
      {noRuntimeMutation:true,requiresNativeApproval:true,
        status:{...defaultStatus},availableActions:[]},
    ]) {
      const ui=setup({plan}); await flush();
      click(ui,"named-manager-plan"); await flush();
      expect(ui.named("named-manager-start-anchor").disabled).toBe(true);
      click(ui,"named-manager-start-anchor"); await flush();
      expect(ui.nativeCalls.some(x=>x.command==="named_tunnel_stack_action")).toBe(false);
    }
  });

  it("invalidates plans after profile edits and never adopts an unsaved tunnel", async () => {
    const ui=setup(); await flush();
    click(ui,"named-manager-plan"); await flush();
    expect(ui.named("named-manager-start-anchor").disabled).toBe(false);
    ui.named("named-tunnel-anchor-port").value="19322";
    ui.listeners.get("named-tunnel-anchor-port:input")?.();
    expect(ui.named("named-manager-start-anchor").disabled).toBe(true);
    click(ui,"named-manager-start-anchor"); await flush();
    expect(ui.nativeCalls.some(x=>x.command==="named_tunnel_stack_action")).toBe(false);
    expect(ui.named("named-manager-message").textContent).toContain("Unsaved");
  });

  it("never sends an OS action when operator cancels confirmation", async () => {
    const ui=setup({confirm:false}); await flush();
    click(ui,"named-manager-plan"); await flush();
    click(ui,"named-manager-start-anchor"); await flush();
    expect(ui.confirmations).toHaveLength(1);
    expect(ui.nativeCalls.some(x=>x.command==="named_tunnel_stack_action")).toBe(false);
  });

  it("reuses existing native credential/connector controls, never duplicating their commands", async () => {
    const ui=setup({status:{
      anchor:{state:"verified_local",verified:true},
      owner:{state:"verified_local",verified:true},
    }}); await flush();
    click(ui,"named-manager-import-clipboard");
    click(ui,"named-manager-import-file");
    click(ui,"named-manager-check-connector");
    click(ui,"named-manager-start-connector");
    expect(ui.existingClicks).toEqual([
      "named-tunnel-import-clipboard","named-tunnel-import-token",
      "named-tunnel-check","named-tunnel-start",
    ]);
    expect(ui.nativeCalls.map(x=>x.command).sort()).toEqual([
      "get_named_tunnel_health","get_named_tunnel_manager_status","get_named_tunnel_settings",
    ]);
  });

  it("keeps cutover review read-only and gated on independently verified evidence", async () => {
    const ui=setup({status:{oauthVerified:true,geminiVerified:true},health:{
      edgeObserved:true,mcpAuthChallengeObserved:true,edgeHttpStatus:401,
    }}); await flush();
    expect(ui.named("named-manager-review").disabled).toBe(true);
    ui.named("named-manager-ack").checked=true;
    ui.listeners.get("named-manager-ack:change")?.();
    expect(ui.named("named-manager-review").disabled).toBe(false);
    click(ui,"named-manager-review"); await flush();
    expect(ui.nativeCalls.map(x=>x.command)).not.toContain("named_tunnel_stack_action");
    expect(ui.named("named-manager-message").textContent).toContain("No cutover command");
  });

  it("blocks stack plan and controls if native status violates Quick Tunnel safety", async () => {
    const ui=setup({status:{quickTunnelUntouched:false,tokenVerified:true}});
    await flush();
    expect(ui.named("named-manager-step1").dataset.state).toBe("blocked");
    expect(ui.named("named-manager-plan").disabled).toBe(true);
    click(ui,"named-manager-plan"); await flush();
    expect(ui.nativeCalls.some(x=>x.command==="plan_named_tunnel_stack")).toBe(false);
  });
});
