import { registry } from "./registry.js";
import { SlashCommand } from "./types.js";
import { getTrustedDirectories, addTrustedDirectory } from "../config/jsonConfig.js";
import { getWorkspacesFromDb } from "../storage/historyDb.js";
import { workspaceMode } from "../ssh/workspaceMode.js";
import { sshProxy } from "../ssh/sshProxy.js";
import path from "path";

export const workspaceCommand: SlashCommand = {
  name: "workspace",
  aliases: ["w"],
  description: "Manage project workspaces and workspace chains via interactive wizard",
  async execute(_args, ctx) {
    const sshCfg = workspaceMode.getConfig();
    const isSshActive = workspaceMode.isSsh();
    const currentWorkspace = isSshActive && sshCfg
      ? `${sshCfg.username}@${sshCfg.host}:${sshCfg.port}${sshCfg.remoteCwd}`
      : path.resolve(ctx.agent?.workingDirectory || process.cwd());

    if (ctx.setActiveWizard) {
      const options = [
        "📁 Select & Switch Workspace...",
        "➕ Add a new workspace...",
        "🗑️ Remove a workspace...",
        "📊 View workspace status",
        "🔗 Manage workspace chains...",
        "❌ Exit Wizard",
      ];

      ctx.setActiveWizard({
        type: "workspace",
        step: 1,
        data: {},
      });
      ctx.setWizardOptions?.(options);
      ctx.setWizardSelectedIndex?.(0);
    }
  }
};

registry.register(workspaceCommand);