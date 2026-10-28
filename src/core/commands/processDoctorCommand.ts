import type { SlashCommand } from "./types.js";
import { registry } from "./registry.js";
import { formatProcessStatus } from "./processStatusViews.js";

export const doctorCommand: SlashCommand = {
  name: "doctor",
  description: "Read-only process supervisor diagnostics (usage: /doctor processes)",
  async execute(args, ctx) {
    if (args.trim().toLowerCase() !== "processes") {
      ctx.addLine({ type: "system", content: "Usage: /doctor processes", timestamp: Date.now() });
      return;
    }
    try {
      const content = await formatProcessStatus(ctx.agent?.workingDirectory ?? process.cwd(), true);
      ctx.addLine({ type: "system", content, timestamp: Date.now() });
    } catch {
      ctx.addLine({
        type: "error",
        content: "Process diagnostics unavailable; registry ownership remains unverified.",
        timestamp: Date.now(),
      });
    }
  },
};
registry.register(doctorCommand);
