/**
 * A single MCP endpoint for audited SuperAgent service lifecycle.
 * Dangerous classification applies to the whole tool, including read-only
 * operations, to prevent one mixed-mode schema from advertising readOnlyHint.
 */
import { MANAGED_SERVICE_NAMES } from "../../runtime/serviceManagerTypes.js";

export const SERVICE_MANAGER_MCP_TOOL_DEFS=[{
  name:"superagent_manage_services",
  description:"Unified SuperAgent runtime manager. Inventory Core, MCP, T-Line Transport, Channel Host, Muse, Telegram, Vision, Guardian, daemon, Tray and tunnels. Safe mutations: supervised Core rolling restart/rollback/drain; URL-preserving Reloadable MCP backend reload. Explicit read-only plan required before a mutation. Never arbitrary PID kill, auto-start, or Legacy Cloudflare URL rotation. Requires write OAuth scope and local YOLO.",
  inputSchema:{
    type:"object",
    properties:{
      action:{type:"string",enum:["inventory","status","doctor","plan","start","stop","restart","rollback","drain","reload"]},
      service:{type:"string",enum:["all",...MANAGED_SERVICE_NAMES]},
      port:{type:"integer",minimum:1024,maximum:65535},
      targetAction:{type:"string",enum:["start","stop","restart","rollback","drain","reload"]},
      confirm:{type:"boolean",description:"Must be true for mutations."},
      operationId:{type:"string",minLength:16,maxLength:128},
      expectedBuildDigest:{type:"string",pattern:"^[a-f0-9]{64}$"},
      expectedOwnerPid:{type:"integer",minimum:1},
      expectedPublicUrl:{type:"string"},
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
