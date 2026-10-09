import { registry } from "./registry.js";
import { SlashCommand } from "./types.js";

const VALID_MODES = ["implement", "debug", "plan", "research", "review", "ask"] as const;
type OperationalMode = typeof VALID_MODES[number];

const MODE_DESCRIPTIONS: Record<OperationalMode, string> = {
  implement: "Full toolset (file editing, shell execution, testing, build). Recommended for code writing and modifications.",
  ask: "Q&A mode with read/search tools. No file writes or mutating commands.",
  debug: "Bug investigation and repair mode. Terminal debugging and file repair enabled.",
  plan: "Architectural planning mode via manage_plan. Source edits require plan approval.",
  research: "Read-only exploration and code investigation.",
  review: "Code quality and security review mode.",
};

export const modeCommand: SlashCommand = {
  name: "mode",
  description: "View or switch active operational mode (e.g. /mode implement, /mode ask, /mode debug)",
  execute(args, ctx) {
    const now = Date.now();
    const rawInput = args.trim().toLowerCase();

    if (!rawInput) {
      const activeMode = ctx.agent?.activeModeOverride || "auto (based on classification)";
      const lines = [
        `Operational Mode Status:`,
        `  Active Mode: ${activeMode}`,
        ``,
        `Available Modes:`,
        ...VALID_MODES.map((m) => `  - ${m.padEnd(10)}: ${MODE_DESCRIPTIONS[m]}`),
        ``,
        `Usage: /mode <mode-name>`,
        `Example: /mode implement`,
      ];
      ctx.addLine({
        type: "system",
        content: lines.join("\n"),
        timestamp: now,
      });
      return;
    }

    let targetMode: OperationalMode = rawInput as OperationalMode;
    if (rawInput === "code" || rawInput === "edit" || rawInput === "write") {
      targetMode = "implement";
    } else if (rawInput === "fix") {
      targetMode = "debug";
    } else if (rawInput === "qna" || rawInput === "tanya") {
      targetMode = "ask";
    }

    if (!VALID_MODES.includes(targetMode)) {
      ctx.addLine({
        type: "error",
        content: `Invalid mode '${args}'. Available modes: ${VALID_MODES.join(", ")}`,
        timestamp: now,
      });
      return;
    }

    if (ctx.agent) {
      const res = ctx.agent.setMode(targetMode, `User executed /mode ${targetMode}`);
      const explanation = MODE_DESCRIPTIONS[targetMode];
      ctx.addLine({
        type: "system",
        content: `Active mode successfully switched to '${targetMode}'.\n${explanation}\nTools have been updated accordingly.`,
        timestamp: now,
      });
    } else {
      ctx.addLine({
        type: "system",
        content: `Mode selected: '${targetMode}'. (Will take effect when agent initializes)`,
        timestamp: now,
      });
    }
  },
};

registry.register(modeCommand);
