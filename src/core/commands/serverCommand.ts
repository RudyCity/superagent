import { registry } from "./registry.js";
import type { SlashCommand, SlashCommandContext } from "./types.js";
import { getTunnelStatus } from "../remoteAgent/cloudflareTunnel.js";

function line(ctx: SlashCommandContext, type: "system" | "error", content: string): void {
  ctx.addLine({ type, content, timestamp: Date.now() });
}

export const serverCommand: SlashCommand = {
  name: "server",
  description: "Manage SuperAgent REST/SSE server exposure and its Cloudflare tunnel",
  async execute(args, ctx) {
    const parts = args.trim().split(/\s+/).filter(Boolean);
    const resource = (parts[0] || "help").toLowerCase();
    if (resource === "help" || resource === "-h" || resource === "--help") {
      line(ctx, "system", [
        "SuperAgent HTTP server exposure",
        "",
        "  /server tunnel list",
        "  /server tunnel start [--port <n>]",
        "  /server tunnel stop [--port <n>]",
        "  /server tunnel restart [--port <n>]",
        "  /server tunnel status [--port <n>]",
        "  /server tunnel doctor",
        "",
        "This command only manages REST/SSE exposure (default port 7888).",
        "Muse WebSocket tunnel: /muse tunnel. MCP providers: /mcp tunnel.",
      ].join("\n"));
      return;
    }

    if (resource !== "tunnel") {
      line(ctx, "error", `Unknown server action "${resource}". Use /server tunnel or /server help.`);
      return;
    }

    const action = (parts[1] || "status").toLowerCase();
    const rawArgs = parts.slice(2);
    if (rawArgs.some((arg) => ["--mcp", "--mcp-port", "--mcp-auth", "--provider", "--tunnel-id", "--openai", "--openai-tunnel"].includes(arg.toLowerCase()))) {
      line(ctx, "error", "MCP tunnel options do not belong under /server. Use /mcp tunnel.");
      return;
    }

    const portIdx = rawArgs.findIndex((arg) => arg === "--port" || arg === "-p");
    let port = 7888;
    if (portIdx !== -1 && rawArgs[portIdx + 1]) {
      const parsed = Number.parseInt(rawArgs[portIdx + 1], 10);
      if (!Number.isInteger(parsed) || parsed <= 0 || parsed >= 65536) {
        line(ctx, "error", "Invalid --port. Use an integer between 1 and 65535.");
        return;
      }
      port = parsed;
    }

    if (action === "list" || action === "status") {
      const status = getTunnelStatus(port);
      if (!status.isRunning) {
        line(ctx, "system", `SuperAgent REST/SSE tunnel on port ${port}: INACTIVE\nStart it with: /server tunnel start${port !== 7888 ? ` --port ${port}` : ""}`);
        return;
      }
      if (status.serviceKind !== "superagent-http") {
        line(ctx, "error", `Port ${port} is owned by ${status.serviceKind || "unknown service"}, not the SuperAgent REST/SSE server. No changes made.`);
        return;
      }
      line(ctx, "system", [
        `SuperAgent REST/SSE tunnel (port ${port}): ACTIVE`,
        `- Endpoint : ${status.publicUrl}`,
        `- Local    : ${status.localUrl || `http://127.0.0.1:${port}`}`,
        `- PID      : ${status.pid}`,
        `- Uptime   : ${status.uptimeSeconds}s`,
        `- Owner    : ${status.serviceKind}`,
        "",
        `Stop: /server tunnel stop${port !== 7888 ? ` --port ${port}` : ""}`,
      ].join("\n"));
      return;
    }

    if (action === "doctor") {
      try {
        const { findCloudflaredBinary } = await import("../remoteAgent/cloudflareTunnel.js");
        const binary = await findCloudflaredBinary();
        const status = getTunnelStatus(port);
        const checks = [
          `- cloudflared: ${binary ? `FOUND (${binary})` : "NOT FOUND"}`,
          `- REST/SSE tunnel: ${status.isRunning && status.serviceKind === "superagent-http" ? "ACTIVE" : "INACTIVE"}`,
          `- Port: ${port}`,
        ];
        line(ctx, binary ? "system" : "error", ["SuperAgent REST/SSE tunnel diagnostics", ...checks].join("\n"));
      } catch (err: any) {
        line(ctx, "error", `REST/SSE tunnel doctor failed: ${err?.message || String(err)}`);
      }
      return;
    }

    if (!["start", "stop", "restart", "prompt", "url", "guide"].includes(action)) {
      line(ctx, "error", `Unknown server tunnel action "${action}". Available: start, stop, restart, list, status, doctor.`);
      return;
    }

    // Reuse the existing HTTPS transport lifecycle without exposing an internal
    // bypass flag in user-entered Muse command arguments.
    const { handleMuseTunnelSubcommand } = await import("./museTunnelSubcommand.js");
    const forwarded = ["tunnel", action, "--https", ...rawArgs];
    await handleMuseTunnelSubcommand(forwarded, ctx, Date.now(), { internalServerHttp: true });
  },
};

registry.register(serverCommand);
