import { Tool } from "./types.js";

export const switchModeTool: Tool = {
  name: "switch_mode",
  description:
    "Switch the agent's active operational mode. When in 'ask' mode (or other restricted modes) and the task requires modifying files, running commands, creating a plan, or fixing bugs (due to classifier misclassification or user request), call this tool immediately to switch to 'implement', 'debug', 'plan', 'research', 'review', or 'ask'. Switching to 'implement' or 'debug' immediately unlocks all file modification tools (write_to_file, replace_file_content) and terminal execution tools (run_command, bash).",
  parameters: {
    type: "object",
    properties: {
      mode: {
        type: "string",
        enum: ["implement", "debug", "plan", "research", "review", "ask"],
        description:
          "Target mode to switch to. 'implement' unlocks all file write and shell tools for writing code and completing tasks; 'debug' unlocks all tools for fixing errors; 'plan' for architectural planning; 'research' for read-only exploration; 'review' for code quality review; 'ask' for Q&A.",
      },
      reason: {
        type: "string",
        description:
          "Reason for switching mode (e.g. 'Classifier mistakenly chose ask mode; user requested file modifications').",
      },
    },
    required: ["mode"],
  },
  execute: async (args: Record<string, unknown>) => {
    const { agentLocalStorage } = await import("../agent.js");
    const agent = agentLocalStorage.getStore();
    const targetMode = String(args.mode || "") as
      | "implement"
      | "debug"
      | "plan"
      | "research"
      | "review"
      | "ask";
    const reason = typeof args.reason === "string" ? args.reason : "Mode switched by agent";

    const validModes = ["implement", "debug", "plan", "research", "review", "ask"];
    if (!validModes.includes(targetMode)) {
      return `Error: Invalid mode '${targetMode}'. Available modes: ${validModes.join(", ")}`;
    }

    if (!agent) {
      return `Mode switched to '${targetMode}'. (No active agent instance in context)`;
    }

    const previousMode = agent.activeModeOverride || "ask";
    agent.setMode(targetMode, reason);

    const toolExplanation =
      targetMode === "implement" || targetMode === "debug"
        ? "Full toolset unlocked: file modification (write_to_file, replace_file_content) and shell execution (run_command, bash) are now enabled."
        : targetMode === "plan"
        ? "Planning mode active: use manage_plan to propose an implementation plan."
        : `Active mode set to '${targetMode}'.`;

    return `Successfully switched mode from '${previousMode}' to '${targetMode}'. ${toolExplanation} Proceed with fulfilling the user's request immediately.`;
  },
};
