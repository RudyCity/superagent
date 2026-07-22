import { registry } from "./registry.js";
import { SlashCommand } from "./types.js";
import { getTrustedDirectories, addTrustedDirectory } from "../config/jsonConfig.js";
import { getWorkspacesFromDb } from "../storage/historyDb.js";
import path from "path";
import fs from "fs";

export const workspaceCommand: SlashCommand = {
  name: "workspace",
  aliases: ["w"],
  description: "Manage project workspaces (list, add, use)",
  async execute(args, ctx) {
    const currentWorkspace = path.resolve(ctx.agent?.workingDirectory || process.cwd());
    const now = Date.now();

    // If no args and wizard is supported, launch wizard
    if (!args.trim()) {
      if (ctx.setActiveWizard) {
        const trustedDirs = getTrustedDirectories().map(d => path.resolve(d));
        const allDirs = [...new Set([currentWorkspace, ...trustedDirs])];
        
        const options = allDirs.map((dir) => {
          const isActive = dir === currentWorkspace;
          const prefix = isActive ? "* [active] " : "📁 ";
          return `${prefix}${dir}`;
        });
        
        options.push("➕ Add a new workspace...");

        ctx.setActiveWizard({
          type: "workspace",
          step: 1,
          data: {},
        });
        ctx.setWizardOptions?.(options);
        ctx.setWizardSelectedIndex?.(0);
        return;
      }
    }

    const parts = args.trim().split(/\s+/);
    let action = parts[0].toLowerCase() || "list";
    let targetArg = parts.slice(1).join(" ").trim();

    // If action is not a known command but exists as a path or index, treat as "use"
    if (action !== "list" && action !== "add" && action !== "use" && action !== "select") {
      const combined = args.trim();
      const index = parseInt(combined, 10);
      const trustedDirs = getTrustedDirectories().map(d => path.resolve(d));
      const allDirs = [...new Set([currentWorkspace, ...trustedDirs])];

      if ((!isNaN(index) && index >= 1 && index <= allDirs.length) || fs.existsSync(path.resolve(currentWorkspace, combined))) {
        action = "use";
        targetArg = combined;
      }
    }

    if (action === "list") {
      const trustedDirs = getTrustedDirectories().map(d => path.resolve(d));
      const allDirs = [...new Set([currentWorkspace, ...trustedDirs])];
      const dbWorkspaces = getWorkspacesFromDb();
      const workspacesMap = new Map(dbWorkspaces.map(w => [path.resolve(w.path), w]));

      ctx.addLine({
        type: "system",
        content: `Current Active Workspace: ${currentWorkspace}\nRegistered Workspaces:`,
        timestamp: now
      });

      if (allDirs.length === 0) {
        ctx.addLine({
          type: "system",
          content: "  No workspaces registered.",
          timestamp: now
        });
        return;
      }

      allDirs.forEach((dir, idx) => {
        const isActive = dir === currentWorkspace;
        const marker = isActive ? "*" : "-";
        const label = isActive ? " (active)" : "";
        const wsRecord = workspacesMap.get(dir);
        const namePart = wsRecord?.name ? ` [${wsRecord.name}]` : "";
        ctx.addLine({
          type: "system",
          content: `  ${marker} ${idx + 1}:${namePart} ${dir}${label}`,
          timestamp: now
        });
      });
      return;
    }

    if (action === "add") {
      if (!targetArg) {
        ctx.addLine({
          type: "error",
          content: "Error: Please specify a workspace path to add. Usage: /workspace add <path> [name]",
          timestamp: now
        });
        return;
      }

      let resolvedPath = "";
      let wsName: string | undefined = undefined;

      const fullPath = path.resolve(currentWorkspace, targetArg);
      if (fs.existsSync(fullPath)) {
        resolvedPath = fullPath;
      } else {
        let found = false;
        const lastSpaceIndices: number[] = [];
        for (let i = 0; i < targetArg.length; i++) {
          if (targetArg[i] === " " || targetArg[i] === "\t") {
            lastSpaceIndices.push(i);
          }
        }
        for (let i = lastSpaceIndices.length - 1; i >= 0; i--) {
          const splitIdx = lastSpaceIndices[i];
          const pathPart = targetArg.slice(0, splitIdx).trim();
          const namePart = targetArg.slice(splitIdx + 1).trim();
          if (namePart.includes("/") || namePart.includes("\\")) {
            continue;
          }
          const cleanPathPart = pathPart.replace(/^["']|["']$/g, "");
          const testPath = path.resolve(currentWorkspace, cleanPathPart);
          if (fs.existsSync(testPath)) {
            resolvedPath = testPath;
            wsName = namePart.replace(/^["']|["']$/g, "");
            found = true;
            break;
          }
        }
        if (!found) {
          resolvedPath = fullPath;
        }
      }

      if (!fs.existsSync(resolvedPath)) {
        ctx.addLine({
          type: "error",
          content: `Error: Path does not exist: ${resolvedPath}`,
          timestamp: now
        });
        return;
      }

      const stats = fs.statSync(resolvedPath);
      if (!stats.isDirectory()) {
        ctx.addLine({
          type: "error",
          content: `Error: Path is not a directory: ${resolvedPath}`,
          timestamp: now
        });
        return;
      }

      addTrustedDirectory(resolvedPath, wsName);

      const addedLabel = wsName ? `Added workspace "${wsName}": ${resolvedPath}` : `Added workspace: ${resolvedPath}`;
      ctx.addLine({
        type: "system",
        content: addedLabel,
        timestamp: now
      });
      return;
    }

    if (action === "use" || action === "select") {
      if (!targetArg) {
        ctx.addLine({
          type: "error",
          content: "Error: Please specify a workspace path or index. Usage: /workspace use <path-or-index>",
          timestamp: now
        });
        return;
      }

      const trustedDirs = getTrustedDirectories().map(d => path.resolve(d));
      const allDirs = [...new Set([currentWorkspace, ...trustedDirs])];

      let targetPath = "";

      // Check if target is an index
      const index = parseInt(targetArg, 10);
      if (!isNaN(index) && index >= 1 && index <= allDirs.length) {
        targetPath = allDirs[index - 1];
      } else {
        targetPath = path.resolve(currentWorkspace, targetArg);
      }

      if (!fs.existsSync(targetPath)) {
        ctx.addLine({
          type: "error",
          content: `Error: Workspace path does not exist: ${targetPath}`,
          timestamp: now
        });
        return;
      }

      const stats = fs.statSync(targetPath);
      if (!stats.isDirectory()) {
        ctx.addLine({
          type: "error",
          content: `Error: Path is not a directory: ${targetPath}`,
          timestamp: now
        });
        return;
      }

      // Add targetPath to trusted directory if it isn't there already
      addTrustedDirectory(targetPath);

      // Switch CWD and agent working directory
      if (ctx.setWorkingDirectory) {
        ctx.setWorkingDirectory(targetPath);
      } else {
        process.chdir(targetPath);
        if (ctx.agent) {
          ctx.agent.workingDirectory = targetPath;
        }
      }

      if (ctx.agent) {
        ctx.agent.resetInternalState();
        await ctx.agent.clearHistory();
        ctx.agent.planState = "IDLE";
        ctx.agent.goalMode = null;
      }
      if (ctx.setPlanState) ctx.setPlanState("IDLE");
      if (ctx.clearLines) ctx.clearLines();

      ctx.addLine({
        type: "system",
        content: `Switched workspace to: ${targetPath}\nStarted a new chat session for this workspace.`,
        timestamp: now
      });
      return;
    }

    ctx.addLine({
      type: "error",
      content: `Error: Unknown action "${action}". Available actions: list, add, use`,
      timestamp: now
    });
  }
};

registry.register(workspaceCommand);
