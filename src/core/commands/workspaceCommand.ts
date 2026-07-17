import { registry } from "./registry.js";
import { SlashCommand } from "./types.js";
import { getTrustedDirectories, addTrustedDirectory } from "../config/jsonConfig.js";
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

      ctx.addLine({
        type: "system",
        content: "Registered Workspaces:",
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
        ctx.addLine({
          type: "system",
          content: `  ${marker} ${idx + 1}: ${dir}${label}`,
          timestamp: now
        });
      });
      return;
    }

    if (action === "add") {
      if (!targetArg) {
        ctx.addLine({
          type: "error",
          content: "Error: Please specify a workspace path to add. Usage: /workspace add <path>",
          timestamp: now
        });
        return;
      }

      const resolvedPath = path.resolve(currentWorkspace, targetArg);

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

      addTrustedDirectory(resolvedPath);

      ctx.addLine({
        type: "system",
        content: `Added workspace: ${resolvedPath}`,
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

      ctx.addLine({
        type: "system",
        content: `Switched workspace to: ${targetPath}`,
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
