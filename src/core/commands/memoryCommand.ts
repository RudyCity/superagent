import { SlashCommand } from "./types.js";
import { registry } from "./registry.js";

export const memoryCommand: SlashCommand = {
  name: "memory",
  description: "Manage and inspect TencentDB long-term memory",
  async execute(args, ctx) {
    ctx.addLine({
      type: "error",
      content: "TencentDB Memory is disabled in this build.",
      timestamp: Date.now(),
    });
  },
};

registry.register(memoryCommand);
