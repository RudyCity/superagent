/**
 * A single MCP endpoint for audited SuperAgent service lifecycle.
 * Dangerous classification applies to the whole tool, including read-only
 * operations, to prevent one mixed-mode schema from advertising readOnlyHint.
 */
import { MANAGED_SERVICE_NAMES } from "../../runtime/serviceManagerTypes.js";

export const SERVICE_MANAGER_MCP_TOOL_DEFS=[{
  name:"superagent_manage_services",
  description:"Unified SuperAgent runtime manager. Inventory Core, MCP, Transport, Channel Host, Muse, Telegram, Vision, Guardian, daemon, Tray, process registry and tunnels. Includes ready/health dashboard, bounded event timeline, declarative profiles, guarded watchdog, manual operation reconciliation, and transactional Tray upgrade/rollback. Safe mutations: independently verified Core cold start (plan then confirm), supervised Core restart/rollback/drain, verified sidecar and native Tray start/stop/restart, URL-preserving Reloadable MCP backend reload; destructive Quick Tunnel stop requires public disruption acknowledgment. Explicit read-only plan required before a mutation. Never arbitrary PID kill, implicit auto-start, or Legacy Cloudflare URL rotation. Requires write OAuth scope and local YOLO.",
  inputSchema:{
    type:"object",
    properties:{
      action:{type:"string",enum:["inventory","status","doctor","health","dashboard","logs","profile","configure","reconcile","watchdog","plan","start","stop","restart","rollback","drain","reload","upgrade","recycle"]},
      service:{type:"string",enum:["all",...MANAGED_SERVICE_NAMES]},
      port:{type:"integer",minimum:1024,maximum:65535},
      targetAction:{type:"string",enum:["start","stop","restart","rollback","drain","reload","upgrade","recycle"]},
      confirm:{type:"boolean",description:"Must be true for mutations."},
      operationId:{type:"string",minLength:16,maxLength:128},
      expectedBuildDigest:{type:"string",pattern:"^[a-f0-9]{64}$"},
      expectedReleaseRevision:{type:"string",pattern:"^[a-f0-9]{24}$"},
      expectedCurrentDigest:{type:["string","null"],pattern:"^[a-f0-9]{64}$",
        description:"Previous installed Tray digest from release plan (nullable)."},
      revision:{type:"string",description:"Optimistic profile revision returned by action=profile."},
      autoRecover:{type:"boolean",description:"Explicit opt-in guarded recovery; default off."},
      startOnBoot:{type:"boolean",description:"Explicit opt-in, never for MCP or public tunnels."},
      failureThreshold:{type:"integer",minimum:2,maximum:12},
      maxRestartsPerHour:{type:"integer",minimum:0,maximum:6},
      intervalSeconds:{type:"integer",minimum:10,maximum:300},
      reviewed:{type:"boolean",description:"Operator confirmed uncertain operation outcome, requires no owner present."},
      limit:{type:"integer",minimum:1,maximum:200},
      expectedOwnerPid:{type:"integer",minimum:0},
      expectedProcessIdentity:{type:"string",description:"Exact process birth identity returned by Core recycle planning."},
      expectedLegacyCommandDigest:{type:"string",pattern:"^[a-f0-9]{64}$"},
      clientMode:{type:"string",enum:["tline","chrome-extension"]},
      expectedExecutablePath:{type:"string",description:"Exact executable path for Tray legacy recycle."},
      expectedPublicUrl:{type:"string"},
      expectedInstanceId:{type:"string",description:"From sidecar start/stop/restart plan: instance id or absent."},
      expectedSupervisorPid:{type:"integer",minimum:1,
        description:"Supervisor PID from Guardian plan; must match existing authenticated Core."},
      expectedWorkerPid:{type:"integer",minimum:1,description:"Exact Core daemon worker PID from plan."},
      expectedRunning:{type:"boolean",description:"Scheduler running state from daemon plan."},
      noActiveJobs:{type:"boolean",description:"Must be true: no scheduled job in progress."},
      noCoreShutdown:{type:"boolean",
        description:"Required true for Guardian: watchdog lifecycle never stops/restarts Core."},
      noPublicIngress:{type:"boolean",description:"Must be true for sidecar lifecycle; stop refused if public tunnel attached."},
      corePort:{type:"integer",minimum:1024,maximum:65535},
      channelMode:{type:"string",enum:["idle","muse-ws","telegram-fallback"]},
      wsPort:{type:"integer",minimum:1024,maximum:65535},
      expectedLocalUrl:{type:"string",description:"Exact local origin in owner-verified tunnel plan."},
      allowPublicDisruption:{type:"boolean",description:"EXPLICIT acknowledgment: stopping Quick Tunnel disconnects clients and URL may change."},
    },
    required:["action"],
  },
}] as const;
export const SERVICE_MANAGER_MCP_TOOL_CLASSIFICATIONS={
  superagent_manage_services:"dangerous",
} as const;
export async function dispatchServiceManagerMcpTool(args:Record<string,unknown>={}) {
  try {
    const { manageServices }=await import("../../runtime/serviceManager.js");
    const result=await manageServices(args);
    return {content:[{type:"text" as const,text:JSON.stringify(result)}]};
  }catch(e) {
    return {content:[{type:"text" as const,
      text:e instanceof Error?e.message:"SERVICE_OPERATION_FAILED"}],isError:true};
  }
}
