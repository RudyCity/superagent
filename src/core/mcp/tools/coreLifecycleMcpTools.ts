/** Direct, permission-gated MCP tools for opt-in supervised Core lifecycle. */
import { controlCoreLifecycle, corePort, type CoreLifecycleAction } from "../../runtime/coreLifecycleControl.js";

const port = {type:"integer",minimum:1024,maximum:65535,
  description:"Supervised Core public port, default 7888."};
const confirm = {type:"boolean",
  description:"Explicitly acknowledge the lifecycle mutation; must be true."};
export const CORE_LIFECYCLE_MCP_TOOL_DEFS = [
  {name:"superagent_core_status", description:"Read-only supervised API Core status and worker generation; no changes.",
   inputSchema:{type:"object",properties:{port}}},
  {name:"superagent_core_restart", description:"Verified blue-green restart of supervised development Core; does not restart MCP Tunnel, Muse or Telegram. Requires confirm=true; never kills unsupervised processes.",
   inputSchema:{type:"object",properties:{port,confirm},required:["confirm"]}},
  {name:"superagent_core_rollback", description:"Rollback supervised development Core to a retained generation. Requires confirm=true.",
   inputSchema:{type:"object",properties:{port,confirm},required:["confirm"]}},
  {name:"superagent_core_drain", description:"Guarded retirement of idle retained Core generations. Requires confirm=true; active sessions preserved.",
   inputSchema:{type:"object",properties:{port,confirm},required:["confirm"]}},
] as const;
export const CORE_LIFECYCLE_MCP_TOOL_CLASSIFICATIONS = {
  superagent_core_status:"safe",
  superagent_core_restart:"dangerous",
  superagent_core_rollback:"dangerous",
  superagent_core_drain:"dangerous",
} as const;

export async function dispatchCoreLifecycleMcpTool(name:string,args:Record<string,unknown>={}) {
  try {
    const action = name.replace(/^superagent_core_/,"") as CoreLifecycleAction;
    if (!["status","restart","rollback","drain"].includes(action))
      throw new Error("CORE_CONTROL_UNKNOWN_TOOL");
    // Core control targets the local authenticated supervisor, never a remote project.
    if (Object.keys(args).some(key=>!["port","confirm"].includes(key)))
      throw new Error("CORE_CONTROL_UNEXPECTED_ARGUMENT");
    const result = await controlCoreLifecycle(action,corePort(args.port),args.confirm===true);
    return {content:[{type:"text" as const,text:JSON.stringify(result)}]};
  } catch(error) {
    return {content:[{type:"text" as const,text:error instanceof Error ? error.message : "CORE_CONTROL_FAILED"}],isError:true};
  }
}
