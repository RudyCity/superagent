/** Narrow Core development management tool, no arbitrary process signals. */
import type { Tool } from "./types.js";
import { controlCoreLifecycle, coreAction, corePort } from "../runtime/coreLifecycleControl.js";

export const manageCoreTool: Tool = {
  name: "manage_core",
  description: "Manage supervised SuperAgent development/API Core: status, restart, rollback, drain. Safe blue-green restart after code changes; MCP/Telegram/Muse stay connected. Unsupervised Core cannot be restarted. Build dist before rolling a compiled worker. Mutations require confirm=true.",
  parameters: {
    type: "object",
    properties: {
      action: {type:"string", enum:["status","restart","rollback","drain"]},
      port: {type:"integer", minimum:1024, maximum:65535},
      confirm: {type:"boolean", description:"Must be true for restart, rollback or drain."},
    },
    required:["action"],
  },
  execute: async args => {
    try {
      const result = await controlCoreLifecycle(
        coreAction(args.action), corePort(args.port), args.confirm === true);
      return JSON.stringify(result, null, 2);
    } catch (error) {
      return "Error: "+(error instanceof Error ? error.message : String(error));
    }
  },
};
