import { registry } from "./registry.js";
import { SlashCommand } from "./types.js";
import { getTrustedDirectories, addTrustedDirectory } from "../config/jsonConfig.js";
import { getWorkspacesFromDb } from "../storage/historyDb.js";
import { workspaceMode } from "../ssh/workspaceMode.js";
import { sshProxy } from "../ssh/sshProxy.js";
import path from "path";
import fs from "fs";

export const workspaceCommand: SlashCommand = {
  name: "workspace",
  aliases: ["w"],
  description: "Manage project workspaces via interactive wizard",
  async execute(_args, ctx) {
    const sshCfg = workspaceMode.getConfig();
    const isSshActive = workspaceMode.isSsh();
    const currentWorkspace = isSshActive && sshCfg
      ? `${sshCfg.username}@${sshCfg.host}:${sshCfg.port}${sshCfg.remoteCwd}`
      : path.resolve(ctx.agent?.workingDirectory || process.cwd());

    if (ctx.setActiveWizard) {
      const trustedDirs = getTrustedDirectories().map(d => d.startsWith("ssh:") ? d : path.resolve(d));
      const allDirs = [...new Set([currentWorkspace, ...trustedDirs])];
      const dbWorkspaces = getWorkspacesFromDb();
      const workspacesMap = new Map(dbWorkspaces.map(w => [path.resolve(w.path), w]));
      
      const options = allDirs.map((dir) => {
        let isActive = dir === currentWorkspace;
        if (!isActive && workspaceMode.isSsh() && sshCfg && (dir.startsWith('ssh:') || (dir.includes('@') && (dir.includes(':/') || dir.includes(':'))))) {
          const parsedDir = workspaceMode.parseSshTarget(dir);
          if (parsedDir) {
            isActive =
              parsedDir.host === sshCfg.host &&
              parsedDir.port === sshCfg.port &&
              parsedDir.username === sshCfg.username &&
              parsedDir.remoteCwd === sshCfg.remoteCwd;
          }
        }
        const prefix = isActive ? "* [active] " : "📁 ";
        const wsRecord = workspacesMap.get(dir);
        const wsName = wsRecord?.name || "";
        const namePart = wsName ? ` [${wsName}]` : "";
        return `${prefix}${namePart} ${dir}`;
      });
      
      options.push("➕ Add a new workspace...");
      options.push("🗑️ Remove a workspace...");
      options.push("📊 View workspace status");
      options.push("❌ Exit Wizard");

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
