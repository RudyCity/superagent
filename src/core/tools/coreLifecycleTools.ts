/** Narrow Core development management tool, no arbitrary process signals. */
import type { Tool } from "./types.js";
import { controlCoreLifecycle, prepareCoreLifecycle, coreAction, corePort } from "../runtime/coreLifecycleControl.js";
import { validateCoreOperationId } from "../runtime/coreLifecycleLedger.js";

export const manageCoreTool: Tool = {
  name: "manage_core",
  description: "Manage supervised SuperAgent development/API Core: status, plan, restart, rollback, drain. Safe blue-green restart after code changes; MCP/Telegram/Muse stay connected. Unsupervised Core cannot be restarted. Build dist before rolling a compiled worker. Mutations require confirm=true.",
  parameters: {
    type: "object",
    properties: {
      action: {type:"string", enum:["status","plan","restart","rollback","drain"]},
      port: {type:"integer", minimum:1024, maximum:65535},
      confirm: {type:"boolean", description:"Must be true for restart, rollback or drain."},
      targetAction: {type:"string",enum:["restart","rollback","drain"],description:"Action planned by action=plan."},
      operationId: {type:"string",description:"Stable operation ID from the plan; reuse after timeout."},
      expectedBuildDigest: {type:"string",description:"Expected build SHA-256 from plan."},
    },
    required:["action"],
  },
  execute: async args => {
    try {
      if(args.action==="plan"){
        if(args.targetAction!=="restart"&&args.targetAction!=="rollback"&&args.targetAction!=="drain")
          throw new Error("CORE_CONTROL_PLAN_TARGET_REQUIRED");
        return JSON.stringify(await prepareCoreLifecycle(args.targetAction,corePort(args.port)),null,2);
      }
      const action=coreAction(args.action);
      if(action!=="status" && (!args.operationId || !args.expectedBuildDigest))
        throw new Error("CORE_OPERATION_PLAN_REQUIRED: call manage_core action=plan first");
      const result = await controlCoreLifecycle(action,corePort(args.port),args.confirm===true,
        undefined,action==="status"?{}:{
          operationId:validateCoreOperationId(args.operationId),
          expectedBuildDigest:args.expectedBuildDigest as string,
        });
      return JSON.stringify(result,null,2);
    } catch (error) {
      return "Error: "+(error instanceof Error ? error.message : String(error));
    }
  },
};
