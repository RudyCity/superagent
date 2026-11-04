/**
 * Unified management tool for SuperAgent agent tiers.
 * All mutating work is delegated to verified owner lifecycle APIs only.
 */
import type { Tool } from "./types.js";
import { MANAGED_SERVICE_NAMES } from "../runtime/serviceManagerTypes.js";

export const manageServicesTool:Tool={
  name:"manage_services",
  description:"Unified control of SuperAgent services: inventory/status/doctor across Core, MCP, Transport, Channel Host, Muse, Telegram, Vision, Guardian, daemon, Tray, external tunnels and process supervisor. Use action=plan first for supervised Core restart/rollback/drain or Reloadable MCP backend reload. Mutations require confirm=true and the returned operationId/expected identity. Legacy Cloudflare Quick Tunnel URL is never changed. Other service actions are explicitly blocked unless owner-safe controls exist.",
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
      expectedOwnerPid:{type:"integer",minimum:1},
      expectedPublicUrl:{type:"string"},
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
