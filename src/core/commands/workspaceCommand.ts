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

    const trimmedArgs = (_args || "").trim();
    if (trimmedArgs.startsWith("create")) {
      const parts = trimmedArgs.split(/\s+/);
      const projectName = parts[1] || "";
      if (ctx.setActiveWizard) {
        if (projectName) {
          const { getDefaultProjectDir } = await import("../project/projectScaffolder.js");
          const defaultTarget = getDefaultProjectDir(projectName);
          ctx.setActiveWizard({
            type: "workspace",
            step: 21,
            data: { projectName, defaultTarget },
          });
        } else {
          ctx.setActiveWizard({
            type: "workspace",
            step: 20,
            data: {},
          });
        }
        ctx.setWizardOptions?.([]);
        ctx.setWizardSelectedIndex?.(0);
        return;
      }
    }

    if (ctx.setActiveWizard) {
      const options = [
        "1. Select & Switch Workspace...",
        "2. Add a new workspace...",
        "3. Create new instant project (Superagent base)...",
        "4. Remove a workspace...",
        "5. View workspace status",
        "6. Manage workspace chains...",
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