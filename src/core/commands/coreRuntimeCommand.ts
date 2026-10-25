import { registry } from "./registry.js";
import type { SlashCommand } from "./types.js";
import { formatCoreSupervisorStatus, requestCoreSupervisor } from "../runtime/coreSupervisor.js";

export const coreRuntimeCommand: SlashCommand = {
  name: "core",
  description: "Inspect or roll supervised API worker without touching MCP, Muse, Telegram or background processes",
  async execute(args, ctx) {
    const parts = args.trim().split(/\s+/).filter(Boolean);
    const action = (parts[0] || "status").toLowerCase();
    if (action === "help") {
      ctx.addLine({
        type: "system",
        content: [
          "/core status [--port 7888]",
          "/core restart [--port 7888]",
          "/core rollback [--port 7888]",
          "/core drain [--port 7888]",
          "Start supervisor separately: superagent core start --port 7888",
          "Safe login-time Core bootstrap: superagent core boot --port 7888",
          "Inspect cold reboot blockers without changing processes: superagent core boot-audit --port 7888",
          "Opt-in guardian for NEW owned Core only: superagent core guard --port 7888",
          "Guardian metadata status: superagent core guard-status --port 7888",
          "If its process crashes: superagent core recover --port 7888",
          "Separate opt-in T-Line front door: superagent transport start --port 7891 --core-port 7888",
          "Independent Muse/Telegram owner: superagent channel-host serve --port 7892 --mode idle",
          "Unsupervised CLI/server instances cannot be rolled automatically.",
          "Previous workers are retained; MCP, Muse, Telegram and jobs are not stopped.",
        ].join("\n"),
        timestamp: Date.now(),
      });
      return;
    }
    if (action !== "status" && action !== "restart" && action !== "rollback" && action !== "drain") {
      ctx.addLine({ type: "error", content: "Use /core status, /core restart, /core rollback, /core drain or /core help", timestamp: Date.now() });
      return;
    }
    const idx = parts.indexOf("--port");
    const port = idx === -1 ? 7888 : Number(parts[idx + 1]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      ctx.addLine({ type: "error", content: "Invalid --port (1-65535)", timestamp: Date.now() });
      return;
    }
    try {
      const result = await requestCoreSupervisor(action, port);
      ctx.addLine({ type: "system", content: formatCoreSupervisorStatus(result), timestamp: Date.now() });
    } catch (error) {
      ctx.addLine({ type: "error", content: String(error), timestamp: Date.now() });
    }
  },
};

registry.register(coreRuntimeCommand);
