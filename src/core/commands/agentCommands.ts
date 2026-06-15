import fsCb from "fs";
import path from "path";
import { execa } from "execa";
import { registry } from "./registry.js";
import { SlashCommand } from "./types.js";
import {
  subagentInstances,
  backgroundTasks,
  notifyTasksChanged,
  BackgroundTask,
} from "../tools.js";
import { killProcessTree } from "../tools/shellTools.js";
import { getGlobalConfigDir } from "../config.js";

// /agents command
export const agentsCommand: SlashCommand = {
  name: "agents",
  description: "List active subagents and defined subagent types",
  execute(args, ctx) {
    const activeList = Array.from(subagentInstances.entries());
    const lines = [
      "┌───[ 🤖 ACTIVE SUBAGENTS & TYPES ]",
      "│ ",
      "│ [DEFINED TYPES]",
      "│  ├─ researcher : codebase research & context gathering",
      "│  ├─ coder      : code writing & editing",
      "│  └─ reviewer   : debugging, review & testing",
      "│ ",
      "│ [ACTIVE INSTANCES]",
    ];
    if (activeList.length === 0) {
      lines.push("│  └─ None");
    } else {
      activeList.forEach(([id, inst], index) => {
        const isLast = index === activeList.length - 1;
        const branchChar = isLast ? "└─" : "├─";
        lines.push(`│  ${branchChar} ID: ${id} (${inst.typeName})`);
        const connectChar = isLast ? " " : "│";
        lines.push(`│     ├─ Role: ${inst.role}`);
        if (inst.status === "completed" && (inst as any).result) {
          const snippet = (inst as any).result.length > 60 ? (inst as any).result.slice(0, 57) + "..." : (inst as any).result;
          lines.push(`│     ├─ Status: ${inst.status}`);
          lines.push(`│     └─ Report: ${snippet.replace(/\n/g, " ")}`);
        } else {
          lines.push(`│     └─ Status: ${inst.status}`);
        }
      });
    }
    lines.push("└──────────────────────────────────────────────");
    ctx.addLine({
      type: "system",
      content: lines.join("\n"),
      timestamp: Date.now(),
    });
  }
};

// /worktree command
export const worktreeCommand: SlashCommand = {
  name: "worktree",
  aliases: ["worktrees"],
  description: "Manage Git worktrees (list, prune, remove)",
  async execute(args, ctx) {
    const cleanArgs = args.trim();
    const parts = cleanArgs.split(/\s+/).filter(Boolean);
    const action = parts[0]?.toLowerCase() || "list";

    if (action === "list") {
      ctx.addLine({
        type: "system",
        content: "Retrieving git worktrees...",
        timestamp: Date.now(),
      });
      ctx.setIsProcessing?.(true);
      try {
        const result = await execa("git", ["worktree", "list"]);
        const lines = result.stdout.trim().split("\n").filter(Boolean);
        const formatted = [
          "┌───[ 📁 GIT WORKTREES ]",
          "│",
          ...lines.map((line, index) => {
            const isLast = index === lines.length - 1;
            const branchChar = isLast ? "└─" : "├─";
            return `│  ${branchChar} ${line}`;
          }),
          "└──────────────────────────────────────────────"
        ].join("\n");
        ctx.addLine({
          type: "system",
          content: formatted,
          timestamp: Date.now(),
        });
      } catch (err: any) {
        const isNotGit = err.stderr && err.stderr.toLowerCase().includes("not a git repository");
        const errorMsg = isNotGit ? "Not a Git repository." : err.message;
        ctx.addLine({
          type: "error",
          content: `Failed to retrieve worktrees: ${errorMsg}`,
          timestamp: Date.now(),
        });
      } finally {
        ctx.setIsProcessing?.(false);
      }
    } else if (action === "prune") {
      ctx.addLine({
        type: "system",
        content: "Pruning stale git worktrees...",
        timestamp: Date.now(),
      });
      ctx.setIsProcessing?.(true);
      try {
        await execa("git", ["worktree", "prune"]);
        ctx.addLine({
          type: "system",
          content: "Stale git worktrees pruned successfully.",
          timestamp: Date.now(),
        });
      } catch (err: any) {
        ctx.addLine({
          type: "error",
          content: `Failed to prune worktrees: ${err.message}`,
          timestamp: Date.now(),
        });
      } finally {
        ctx.setIsProcessing?.(false);
      }
    } else if (action === "remove" || action === "delete") {
      const target = parts.slice(1).join(" ").trim();
      if (!target) {
        ctx.addLine({
          type: "error",
          content: "Usage: /worktrees remove <path-or-branch> [--force]",
          timestamp: Date.now(),
        });
        return;
      }
      ctx.addLine({
        type: "system",
        content: `Removing git worktree "${target}"...`,
        timestamp: Date.now(),
      });
      ctx.setIsProcessing?.(true);
      try {
        const removeArgs = ["worktree", "remove"];
        if (target.includes("--force") || target.includes("-f")) {
          removeArgs.push("--force");
        }
        const cleanedTarget = target.replace("--force", "").replace("-f", "").trim();
        removeArgs.push(cleanedTarget);
        
        await execa("git", removeArgs);
        
        // Prune after removal
        try {
          await execa("git", ["worktree", "prune"]);
        } catch {}

        ctx.addLine({
          type: "system",
          content: `Git worktree "${cleanedTarget}" removed successfully.`,
          timestamp: Date.now(),
        });
      } catch (err: any) {
        ctx.addLine({
          type: "error",
          content: `Failed to remove worktree: ${err.message}`,
          timestamp: Date.now(),
        });
      } finally {
        ctx.setIsProcessing?.(false);
      }
    } else {
      ctx.addLine({
        type: "error",
        content: `Unknown worktree action: "${action}". Available actions: list, prune, remove`,
        timestamp: Date.now(),
      });
    }
  }
};

// /processes command
export const processesCommand: SlashCommand = {
  name: "processes",
  aliases: ["procs"],
  description: "List running background processes",
  async execute(args, ctx) {
    const now = Date.now();
    const lowerArgs = args.toLowerCase();

    if (lowerArgs === "stop" || lowerArgs.startsWith("stop ")) {
      const stopArg = args.slice(4).trim();
      const taskList = Array.from(backgroundTasks.entries());

      if (taskList.length === 0) {
        ctx.addLine({
          type: "system",
          content: "⚙️ No running background processes to stop.",
          timestamp: Date.now(),
        });
        return;
      }

      if (!stopArg || stopArg.toLowerCase() === "all") {
        let count = 0;
        for (const [id, task] of taskList) {
          try { killProcessTree(task.process.pid); } catch {}
          try {
            if (task.logPath) {
              fsCb.appendFileSync(task.logPath, `\n[Process exited via force stop at ${new Date().toISOString()}]\n`);
            }
          } catch {}
          task.hasExited = true;
          backgroundTasks.delete(id);
          count++;
        }
        notifyTasksChanged();
        ctx.addLine({
          type: "system",
          content: `🛑 Stopped ${count} background process${count !== 1 ? "es" : ""}.`,
          timestamp: Date.now(),
        });
        return;
      }

      const task = backgroundTasks.get(stopArg);
      if (!task) {
        const ids = taskList.map(([id]) => id).join(", ");
        ctx.addLine({
          type: "error",
          content: `Error: Background process "${stopArg}" not found.\nRunning IDs: ${ids || "(none)"}`,
          timestamp: Date.now(),
        });
        return;
      }

      try { killProcessTree(task.process.pid); } catch {}
      try {
        if (task.logPath) {
          fsCb.appendFileSync(task.logPath, `\n[Process exited via force stop at ${new Date().toISOString()}]\n`);
        }
      } catch {}
      task.hasExited = true;
      backgroundTasks.delete(stopArg);
      notifyTasksChanged();
      ctx.addLine({
        type: "system",
        content: `🛑 Stopped background process [${stopArg}]: "${task.command}"`,
        timestamp: Date.now(),
      });
      return;
    }

    const taskList = Array.from(backgroundTasks.entries());
    const lines = [
      "┌───[ ⚙️ RUNNING BACKGROUND PROCESSES ]",
      "│ ",
    ];

    const windowTasks = taskList.filter(([, t]) => (t as any).isDetachedWindow);
    const bgTasks = taskList.filter(([, t]) => !(t as any).isDetachedWindow);

    if (windowTasks.length > 0) {
      lines.push("│  🖥️  TERMINAL WINDOWS (detached)");
      for (const [id, task] of windowTasks) {
        const label = (task as any).windowLabel || task.command.split(" ")[0];
        lines.push(`│    • [${id}] "${label}"  →  ${task.command}`);
        lines.push(`│       status: running (window alive — stop with /terminal stop ${id})`);
      }
      lines.push("│ ");
    }

    if (bgTasks.length > 0) {
      lines.push("│  ⚙️  HEADLESS BACKGROUND TASKS");
      for (const [id, task] of bgTasks) {
        lines.push(`│    • ID: ${id} | Command: ${task.command}`);
      }
      lines.push("│ ");
    }

    if (taskList.length === 0) {
      lines.push("│  No active background processes.");
    }
    lines.push("├──────────────────────────────────────────────");
    lines.push("│ ");
    const taskPath = ctx.agent ? ctx.agent.getTaskFilePath() : path.resolve(process.cwd(), "task.md");
    const taskBasename = path.basename(taskPath);
    lines.push(`│ [ 📋 CHECKLIST FROM ${taskBasename} ]`);

    try {
      const fsPromises = await import("fs/promises");
      const taskContent = await fsPromises.readFile(taskPath, "utf-8");
      const taskLines = taskContent.split(/\r?\n/);
      let totalTasks = 0;
      let completedTasks = 0;
      let parsedTasks: string[] = [];

      for (const line of taskLines) {
        const match = line.match(/^\s*-\s*`\[([xX/ ])\]`?\s*(.*)$/) || line.match(/^\s*-\s*\[([xX/ ])\]\s*(.*)$/);
        if (match) {
          totalTasks++;
          const status = match[1];
          const text = match[2].trim();
          if (status.toLowerCase() === "x") {
            completedTasks++;
            parsedTasks.push(`│   [✓] ${text}`);
          } else if (status === "/") {
            parsedTasks.push(`│   [/] ${text} (in progress)`);
          } else {
            parsedTasks.push(`│   [ ] ${text}`);
          }
        }
      }

      if (totalTasks > 0) {
        const pct = Math.round((completedTasks / totalTasks) * 100);
        const barLength = 20;
        const filled = Math.round((pct / 100) * barLength);
        const bar = "█".repeat(filled) + "░".repeat(barLength - filled);
        lines.push(`│   Progress: [${bar}] ${pct}% (${completedTasks}/${totalTasks} completed)`);
        lines.push("│ ");
        lines.push(...parsedTasks);
      } else {
        lines.push(`│   No checklist items found in ${taskBasename}.`);
      }
    } catch {
      lines.push(`│   ${taskBasename} not found or unreadable in history dir.`);
    }

    lines.push("└──────────────────────────────────────────────");
    ctx.addLine({
      type: "system",
      content: lines.join("\n"),
      timestamp: now,
    });
  }
};

// /goal command
export const goalCommand: SlashCommand = {
  name: "goal",
  description: "Activate Goal Mode for long-running overnight tasks",
  async execute(args, ctx) {
    const now = Date.now();
    if (!args) {
      if (ctx.setActiveWizard) {
        ctx.setActiveWizard({ type: "goal", step: 1, data: {} });
        ctx.setWizardOptions?.([]);
        ctx.setWizardSelectedIndex?.(0);
      } else {
        ctx.addLine({
          type: "error",
          content: "Usage: /goal <description of what you want achieved>\nExample: /goal implement JWT auth end-to-end with tests",
          timestamp: now,
        });
      }
      return;
    }
    if (!ctx.agent) {
      ctx.addLine({ type: "error", content: "Agent not available.", timestamp: now });
      return;
    }
    ctx.agent.goalMode = args;
    ctx.setGoalMode?.({ goal: args, startedAt: now });
    ctx.addLine({
      type: "system",
      content: [
        "🎯 GOAL MODE ACTIVATED",
        `   Objective : ${args}`,
        "   Iterations: up to 200 steps (auto-continue enabled)",
        "   The agent will not stop until the goal is achieved.",
        "   Use Ctrl+C to abort at any time.",
      ].join("\n"),
      timestamp: now,
    });
    ctx.addLine({
      type: "user",
      content: `❯ /goal ${args}`,
      timestamp: now,
    });
    
    // Write goal to scratchpad
    try {
      const fsPromises = await import("fs/promises");
      const pathModule = await import("path");
      const scratchDir = pathModule.resolve(process.cwd(), "scratch");
      await fsPromises.mkdir(scratchDir, { recursive: true });
      const scratchPath = pathModule.join(scratchDir, "scratchpad.md");
      let existing = "";
      try { existing = await fsPromises.readFile(scratchPath, "utf-8"); } catch {}
      const goalBlock = `\n\n## 🎯 ACTIVE GOAL (set ${new Date(now).toISOString()})\n${args}\n`;
      const cleaned = existing.replace(/\n\n## 🎯 ACTIVE GOAL[\s\S]*?(?=\n\n##|$)/g, "");
      await fsPromises.writeFile(scratchPath, cleaned + goalBlock, "utf-8");
    } catch {}

    ctx.setIsProcessing?.(true);
    ctx.agent.sendMessage(
      `GOAL MODE: Your primary objective is to achieve the following goal completely and verifiably:\n\n"${args}"\n\nBegin immediately. Plan thoroughly, execute step by step, verify completion, and report back with GOAL_COMPLETE or GOAL_PARTIAL.`
    ).catch((err: any) => {
      ctx.addLine({ type: "error", content: `Goal mode error: ${err.message}`, timestamp: Date.now() });
    });
  }
};

// Register agent commands
registry.register(agentsCommand);
registry.register(worktreeCommand);
registry.register(processesCommand);
registry.register(goalCommand);
