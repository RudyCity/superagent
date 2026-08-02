import { registry } from "./registry.js";
import { SlashCommand } from "./types.js";
import { workspaceMode } from "../ssh/workspaceMode.js";

/**
 * /ssh — SSH workspace management commands.
 *
 * Subcommands:
 *   /ssh status            — Show current SSH connection and allowed paths
 *   /ssh expand <path>     — Add an absolute path to the SSH allowed-paths whitelist
 *   /ssh allowed           — List all currently whitelisted extra paths
 */
export const sshCommand: SlashCommand = {
  name: "ssh",
  description: "Manage SSH workspace settings (expand boundary, view status)",
  execute(args, ctx) {
    const now = Date.now();
    const [subCmd, ...rest] = (args || "").trim().split(/\s+/);
    const subArg = rest.join(" ").trim();

    if (!workspaceMode.isSsh()) {
      ctx.addLine({
        type: "system",
        content: "No active SSH workspace. Connect to an SSH workspace first.",
        timestamp: now,
      });
      return;
    }

    const cfg = workspaceMode.getConfig()!;

    switch (subCmd?.toLowerCase()) {
      case "expand": {
        if (!subArg) {
          ctx.addLine({
            type: "error",
            content: "Usage: /ssh expand <absolute-path>  (e.g. /ssh expand /var/www/html)",
            timestamp: now,
          });
          return;
        }
        if (!subArg.startsWith("/")) {
          ctx.addLine({
            type: "error",
            content: `Path must be absolute (start with /). Got: "${subArg}"`,
            timestamp: now,
          });
          return;
        }
        workspaceMode.addAllowedPath(subArg);
        ctx.addLine({
          type: "system",
          content: `SSH workspace expanded: "${subArg}" is now accessible.\nAll tools (read, write, edit, glob, grep, shell) can now operate within that path.`,
          timestamp: now,
        });
        return;
      }

      case "allowed": {
        const extra = workspaceMode.getAllowedPaths();
        if (extra.length === 0) {
          ctx.addLine({
            type: "system",
            content: `No extra allowed paths configured. Primary workspace: ${cfg.remoteCwd}\nUse /ssh expand <path> to add more.`,
            timestamp: now,
          });
        } else {
          ctx.addLine({
            type: "system",
            content: [
              `SSH allowed paths:`,
              `  Primary workspace: ${cfg.remoteCwd}`,
              `  Extra paths:`,
              ...extra.map(p => `    - ${p}`),
            ].join("\n"),
            timestamp: now,
          });
        }
        return;
      }

      case "status":
      case "":
      case undefined: {
        const extra = workspaceMode.getAllowedPaths();
        const extraStr = extra.length > 0 ? `\n  Extra allowed paths:\n${extra.map(p => `    - ${p}`).join("\n")}` : "";
        ctx.addLine({
          type: "system",
          content: [
            `SSH Workspace Status`,
            `  Host:      ${cfg.username}@${cfg.host}:${cfg.port}`,
            `  Workspace: ${cfg.remoteCwd}`,
            `  Auth:      ${cfg.privateKeyPath ? `key (${cfg.privateKeyPath})` : "password"}`,
            extraStr,
            ``,
            `Commands:`,
            `  /ssh expand <path>  — allow access to additional absolute path`,
            `  /ssh allowed        — list all whitelisted extra paths`,
          ].filter(l => l !== null).join("\n"),
          timestamp: now,
        });
        return;
      }

      default: {
        ctx.addLine({
          type: "error",
          content: `Unknown ssh subcommand: "${subCmd}". Available: status, expand, allowed`,
          timestamp: now,
        });
      }
    }
  },
};

registry.register(sshCommand);
