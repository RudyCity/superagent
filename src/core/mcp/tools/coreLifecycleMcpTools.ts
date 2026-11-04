/** Direct, permission-gated MCP tools for opt-in supervised Core lifecycle. */
import { controlCoreLifecycle, prepareCoreLifecycle, corePort, type CoreLifecycleAction } from "../../runtime/coreLifecycleControl.js";
import { validateCoreOperationId } from "../../runtime/coreLifecycleLedger.js";

const port = {type:"integer",minimum:1024,maximum:65535,
  description:"Supervised Core public port, default 7888."};
const confirm = {type:"boolean",
  description:"Explicitly acknowledge the lifecycle mutation; must be true."};
const operationId = {type:"string",minLength:16,maxLength:128,
  description:"Stable operation ID from superagent_core_plan; reuse on timeout retries."};
const expectedBuildDigest = {type:"string",pattern:"^[a-f0-9]{64}$",
  description:"Expected source/dist content SHA-256 from plan."};
export const CORE_LIFECYCLE_MCP_TOOL_DEFS = [
  {name:"superagent_core_status", description:"Read-only supervised API Core status and worker generation; no changes.",
   inputSchema:{type:"object",properties:{port}}},
  {name:"superagent_core_plan", description:"Read-only Core lifecycle preflight: get operationId and expectedBuildDigest for an authorized mutation.",
   inputSchema:{type:"object",properties:{port,action:{type:"string",enum:["restart","rollback","drain"]}},required:["action"]}},
  {name:"superagent_core_restart", description:"Verified blue-green restart of supervised development Core; does not restart MCP Tunnel, Muse or Telegram. Requires confirm=true; never kills unsupervised processes.",
   inputSchema:{type:"object",properties:{port,confirm,operationId,expectedBuildDigest},required:["confirm","operationId","expectedBuildDigest"]}},
  {name:"superagent_core_rollback", description:"Rollback supervised development Core to a retained generation. Requires confirm=true.",
   inputSchema:{type:"object",properties:{port,confirm,operationId,expectedBuildDigest},required:["confirm","operationId","expectedBuildDigest"]}},
  {name:"superagent_core_drain", description:"Guarded retirement of idle retained Core generations. Requires confirm=true; active sessions preserved.",
   inputSchema:{type:"object",properties:{port,confirm,operationId,expectedBuildDigest},required:["confirm","operationId","expectedBuildDigest"]}},
] as const;
export const CORE_LIFECYCLE_MCP_TOOL_CLASSIFICATIONS = {
  superagent_core_status:"safe",
  superagent_core_plan:"safe",
  superagent_core_restart:"dangerous",
  superagent_core_rollback:"dangerous",
  superagent_core_drain:"dangerous",
} as const;

export async function dispatchCoreLifecycleMcpTool(name:string,args:Record<string,unknown>={}) {
  try {
    const action = name.replace(/^superagent_core_/,"") as CoreLifecycleAction | "plan";
    if (!["status","plan","restart","rollback","drain"].includes(action))
      throw new Error("CORE_CONTROL_UNKNOWN_TOOL");
    // Core control targets only the LOCAL authenticated supervisor.
    if (Object.keys(args).some(key=>!["port","confirm","action","operationId","expectedBuildDigest"].includes(key)))
      throw new Error("CORE_CONTROL_UNEXPECTED_ARGUMENT");
    if(action==="plan") {
      if(args.action!=="restart"&&args.action!=="rollback"&&args.action!=="drain")
        throw new Error("CORE_CONTROL_INVALID_PREPARE_ACTION");
      const prepared=await prepareCoreLifecycle(args.action,corePort(args.port));
      return {content:[{type:"text" as const,text:JSON.stringify(prepared)}]};
    }
    if(action!=="status" && (!args.operationId || !args.expectedBuildDigest))
      throw new Error("CORE_OPERATION_PLAN_REQUIRED: call superagent_core_plan first");
    const result = await controlCoreLifecycle(action as CoreLifecycleAction,corePort(args.port),
      args.confirm===true,undefined,action==="status"?{}:{
        operationId:validateCoreOperationId(args.operationId),
        expectedBuildDigest:args.expectedBuildDigest as string,
      });
    return {content:[{type:"text" as const,text:JSON.stringify(result)}]};
  } catch(error) {
    return {content:[{type:"text" as const,text:error instanceof Error ? error.message : "CORE_CONTROL_FAILED"}],isError:true};
  }
}
