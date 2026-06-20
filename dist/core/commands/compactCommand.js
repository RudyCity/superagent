import { registry } from "./registry.js";
import { getDefaultModel } from "./types.js";
import { getContextWindowLimit, getEffectiveMasterModel } from "../config.js";
// /compact command
export const compactCommand = {
    name: "compact",
    description: "Show conversation summary",
    execute(args, ctx) {
        const currentModel = getEffectiveMasterModel("auto") || getDefaultModel();
        const limit = getContextWindowLimit(currentModel);
        const summary = ctx.agent?.getHistory().getCompactSummary(limit);
        ctx.addLine({ type: "system", content: summary || "No history.", timestamp: Date.now() });
    }
};
registry.register(compactCommand);
//# sourceMappingURL=compactCommand.js.map