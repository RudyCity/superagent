import { SlashCommand } from "./types.js";
import { registry } from "./registry.js";

export const memoryCommand: SlashCommand = {
  name: "memory",
  description: "Manage and inspect RMemory long-term memory",
  async execute(args, ctx) {
    ctx.addLine({
      type: "error",
      content: "RMemory Memory is disabled in this build.",
      timestamp: Date.now(),
    });
  },
};

registry.register(memoryCommand);
