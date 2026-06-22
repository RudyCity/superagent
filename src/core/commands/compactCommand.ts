import { registry } from "./registry.js";
import { SlashCommand, getDefaultModel } from "./types.js";
import { getContextWindowLimit, getEffectiveMasterModel } from "../config.js";

// /compact command
export const compactCommand: SlashCommand = {
  name: "compact",
  description: "Show conversation summary",
  execute(args, ctx) {
    const currentModel = getEffectiveMasterModel("auto") || getDefaultModel();
    const limit = getContextWindowLimit(currentModel);
    const conversation = ctx.agent?.getHistory();
    const summary = conversation?.getCompactSummary(limit) || "No history.";
    ctx.addLine({ type: "system", content: summary, timestamp: Date.now() });

    const cm = conversation?.getContextManager?.();
    if (cm) {
      const history = cm.getHistory();
      const tokensSaved = history.reduce(
        (sum: number, e: any) => sum + (e.tokensBefore - e.tokensAfter),
        0
      );
      const lines = [
        "",
        `Context Manager: active`,
        `  Compactions performed: ${history.length}`,
        `  Total tokens saved: ${tokensSaved.toLocaleString()}`,
        `  State: ${cm.getState()}`,
      ];
      if (history.length > 0) {
        const last = history[history.length - 1];
        lines.push(
          `  Last strategy: ${last.strategy} (${new Date(last.timestamp).toLocaleTimeString()})`
        );
      }
      ctx.addLine({ type: "system", content: lines.join("\n"), timestamp: Date.now() });
    }
  },
};

registry.register(compactCommand);

