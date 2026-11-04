/**
 * Unified management tool for SuperAgent agent tiers.
 * All mutating work is delegated to verified owner lifecycle APIs only.
 */
import type { Tool } from "./types.js";
import { MANAGED_SERVICE_NAMES } from "../runtime/serviceManagerTypes.js";

export const manageServicesTool:Tool={
  name:"manage_services",
  description:"Unified control of SuperAgent services: inventory/status/doctor across Core, MCP, Transport, Channel Host, Muse, Telegram, Vision, Guardian, daemon, Tray, external tunnels and process supervisor. Use action=plan first for supervised Core restart/rollback/drain or Reloadable MCP backend reload. Mutations require confirm=true and the returned operationId/expected identity. Legacy Cloudflare Quick Tunnel URL is never changed. Sidecar start/stop/restart requires exact owner plan and no public ingress. Vision, Guardian and Tray start/stop/restart require verified independent owner and explicit confirmation; legacy instances are never adopted.",
  parameters:{
    type:"object",
    properties:{
      action:{type:"string",enum:["inventory","status","doctor","plan","start","stop","restart","rollback","drain","reload"]},
      service:{type:"string",enum:["all",...MANAGED_SERVICE_NAMES]},
      port:{type:"integer",minimum:1024,maximum:65535},
      targetAction:{type:"string",enum:["start","stop","restart","rollback","drain","reload"]},
      confirm:{type:"boolean"},
      operationId:{type:"string",minLength:16,maxLength:128},
      expectedBuildDigest:{type:"string",pattern:"^[a-f0-9]{64}$"},
      expectedOwnerPid:{type:"integer",minimum:0},
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
  execute:async args=>{
    try{
      const { manageServices }=await import("../runtime/serviceManager.js");
      return JSON.stringify(await manageServices(args),null,2);
    }
    catch(e){return "Error: "+(e instanceof Error?e.message:"SERVICE_OPERATION_FAILED");}
  },
};
