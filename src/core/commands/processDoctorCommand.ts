import type { SlashCommand } from "./types.js";
import { registry } from "./registry.js";
import { formatProcessStatus } from "./processStatusViews.js";
import { formatTerminalDiagnosticsFromDisk } from "./terminalDoctorView.js";

export const doctorCommand: SlashCommand = {
  name: "doctor",
  description: "Read-only diagnostics (usage: /doctor [processes|terminal])",
  async execute(args, ctx) {
    const target = args.trim().toLowerCase();
    if (target === "terminal") {
      ctx.addLine({
        type: "system",
        content: formatTerminalDiagnosticsFromDisk(),
        timestamp: Date.now(),
      });
      return;
    }
    if (target !== "processes") {
      ctx.addLine({
        type: "system",
        content: "Usage: /doctor [processes|terminal]",
        timestamp: Date.now(),
      });
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
