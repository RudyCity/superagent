import fs from "fs/promises";
import fsCb from "fs";
import path from "path";
import { execa } from "execa";
import { Agent } from "./agent.js";
import { 
  getInstalledSkills, 
  getConfiguredProviders, 
  switchActiveProvider, 
  listHistorySessions, 
  fetchAndCacheModels, 
  updateEnvFile, 
  getContextWindowLimit,
  getGlobalConfigDir,
} from "./config.js";
import {
  createCheckpoint,
  listCheckpointsForSession,
  deleteCheckpointsForSession,
  restoreCheckpoint,
  restoreCheckpointById,
  terminateActiveTasksAndSubagents,
} from "./checkpoints.js";
import os from "os";
import { searchHistory } from "./historySearch.js";
import { getToolDescription } from "./permissions.js";
import { allTools, backgroundTasks, subagentInstances, notifyTasksChanged, BackgroundTask } from "./tools.js";
import { killProcessTree } from "./tools/shellTools.js";
import { formatArgs } from "../utils/text.js";

export interface ChatLine {
  type:
    | "user"
    | "assistant"
    | "tool_start"
    | "tool_end"
    | "error"
    | "system";
  content: string;
  timestamp: number;
}

export function formatPresetValue(preset: any): string {
  if (!preset) return "";
  if (typeof preset === "string") {
    return preset;
  }
  if (Array.isArray(preset)) {
    return `[ ${preset.map(p => formatPresetValue(p)).join(" ; ")} ]`;
  }
  if (typeof preset === "object" && preset !== null) {
    const parts: string[] = [];
    if (preset.command) {
      parts.push(`cmd: "${preset.command}"`);
    }
    if (preset.description) {
      parts.push(`desc: "${preset.description}"`);
    }
    if (preset.cwd) {
      parts.push(`cwd: "${preset.cwd}"`);
    }
    if (preset.background) {
      parts.push("bg: true");
    }
    if (preset.env && Object.keys(preset.env).length > 0) {
      parts.push(`env: ${JSON.stringify(preset.env)}`);
    }
    return `{ ${parts.join(", ")} }`;
  }
  return JSON.stringify(preset);
}

export function getPresetLabel(key: string, val: any): string {
  if (val && typeof val === "object" && val.name) {
    return val.name;
  }
  return key;
}

export function findPreset(presets: Record<string, any>, nameOrKey: string): { key: string; value: any } | null {
  if (presets[nameOrKey] !== undefined) {
    return { key: nameOrKey, value: presets[nameOrKey] };
  }
  const lowerName = nameOrKey.toLowerCase();
  for (const k of Object.keys(presets)) {
    if (k.toLowerCase() === lowerName) {
      return { key: k, value: presets[k] };
    }
    const val = presets[k];
    if (val && typeof val === "object" && val.name && String(val.name).toLowerCase() === lowerName) {
      return { key: k, value: val };
    }
  }
  return null;
}

export function getProviderLabel(): string {
  const active = process.env.ACTIVE_PROVIDER;
  if (active) {
    const prefix = `PROVIDER_${active.toUpperCase()}`;
    const baseUrl = process.env[`${prefix}_BASE_URL`] || "";
    if (baseUrl) {
      try {
        const url = new URL(baseUrl);
        return `${active} (${url.host})`;
      } catch {
        return active;
      }
    }
    return active;
  }
  if (process.env.CUSTOM_BASE_URL) {
    try {
      const url = new URL(process.env.CUSTOM_BASE_URL);
      return `custom (${url.host})`;
    } catch {
      return "custom";
    }
  }
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  return "openai";
}

export function getDefaultModel(): string {
  if (process.env.CUSTOM_BASE_URL) return "custom";
  if (process.env.ANTHROPIC_API_KEY) return "claude-sonnet-4-20250514";
  return "gpt-4o";
}

export function handleSlashCommand(
  cmd: string,
  ctx: {
    addLine: (line: ChatLine) => void;
    exit: () => void;
    agent: Agent | null;
    clearLines?: () => void;
    setContextLimit?: (limit: number) => void;
    setActiveWizard?: (val: { type: "login" | "model" | "plan_approve" | "permission" | "question" | "resume" | "goal" | "checkpoint" | "skills"; step: number; data: Record<string, string> } | null) => void;
    setWizardOptions?: (options: string[]) => void;
    setWizardSelectedIndex?: (index: number) => void;
    resumeSession?: () => Promise<void>;
    resumeFromPath?: (filePath: string) => Promise<void>;
    setPlanState?: (state: "IDLE" | "PLANNING_PENDING" | "APPROVED") => void;
    setGoalMode?: (val: { goal: string; startedAt: number } | null) => void;
    setIsProcessing?: (val: boolean) => void;
  }
) {
  const [name] = cmd.slice(1).split(" ");
  const now = Date.now();

  if (name.toLowerCase().startsWith("skill-")) {
    const slug = name.toLowerCase().slice(6);
    const skills = getInstalledSkills();
    const matchedSkill = skills.find(s => {
      const sSlug = s.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
      return sSlug === slug;
    });

    if (matchedSkill) {
      ctx.addLine({
        type: "user",
        content: `❯ /skill-${slug}`,
        timestamp: now,
      });
      ctx.addLine({
        type: "system",
        content: `Activating skill "${matchedSkill.name}"...\nInstruction path: ${matchedSkill.path}`,
        timestamp: now,
      });
      ctx.setIsProcessing?.(true);
      ctx.agent?.sendMessage(
        `I would like you to use the following skill: "${matchedSkill.name}".\nPlease read its instruction file at "${matchedSkill.path}" using a file read tool first, and then help me with my request based on its instructions.`
      ).catch((err: any) => {
        ctx.addLine({ type: "error", content: `Skill activation error: ${err.message}`, timestamp: Date.now() });
      });
    } else {
      ctx.addLine({
        type: "error",
        content: `Skill "${slug}" not found.`,
        timestamp: now,
      });
    }
    return;
  }

  switch (name.toLowerCase()) {
    case "new":
      if (ctx.agent) {
        const sessionFilePath = ctx.agent.getCurrentHistoryFilePath();
        deleteCheckpointsForSession(sessionFilePath).catch(() => {});
      }
      ctx.agent?.clearHistory();
      if (ctx.agent) {
        ctx.agent.planState = "IDLE";
        ctx.agent.goalMode = null;
      }
      ctx.setPlanState?.("IDLE");
      ctx.setGoalMode?.(null);
      ctx.clearLines?.();
      ctx.addLine({ type: "system", content: "New conversation started. History and terminal cleared.", timestamp: now });
      break;
    case "resume": {
      const isMulti = ctx.agent?.isMultiAgent || false;
      const sessions = listHistorySessions(isMulti);
      if (sessions.length === 0) {
        ctx.addLine({ type: "system", content: "No previous sessions found. Start a conversation first!", timestamp: now });
        break;
      }
      const relTime = (d: Date) => {
        const diff = Math.floor((Date.now() - d.getTime()) / 1000);
        if (diff < 60) return `${diff}s ago`;
        if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
        if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
        return `${Math.floor(diff / 86400)}d ago`;
      };
      const sessionOptions = sessions.map(
        (s) => `📁 ${s.displayName}  |  ${s.messageCount} msgs  |  ${relTime(s.lastModified)}`
      );
      ctx.setActiveWizard?.({
        type: "resume",
        step: 1,
        data: {},
      });
      ctx.setWizardOptions?.(sessionOptions);
      ctx.setWizardSelectedIndex?.(0);
      break;
    }
    case "search-history": {
      const query = cmd.slice(name.length + 2).trim();
      if (!query) {
        ctx.addLine({
          type: "error",
          content: "Usage: /search-history <query-text>\nExample: /search-history refactor background task",
          timestamp: now,
        });
        break;
      }
      ctx.addLine({
        type: "system",
        content: `Searching conversation history for: "${query}"...`,
        timestamp: now,
      });
      ctx.setIsProcessing?.(true);
      searchHistory(query, ctx.agent?.isMultiAgent || false)
        .then((result) => {
          ctx.addLine({
            type: "system",
            content: result,
            timestamp: Date.now(),
          });
        })
        .catch((err: any) => {
          ctx.addLine({
            type: "error",
            content: `History search failed: ${err.message}`,
            timestamp: Date.now(),
          });
        })
        .finally(() => {
          ctx.setIsProcessing?.(false);
        });
      break;
    }
    case "clear":
      if (ctx.agent) {
        const sessionFilePath = ctx.agent.getCurrentHistoryFilePath();
        deleteCheckpointsForSession(sessionFilePath).catch(() => {});
      }
      ctx.agent?.clearHistory();
      if (ctx.agent) {
        ctx.agent.planState = "IDLE";
        ctx.agent.goalMode = null;
      }
      ctx.setPlanState?.("IDLE");
      ctx.setGoalMode?.(null);
      ctx.addLine({ type: "system", content: "Conversation cleared.", timestamp: now });
      break;

    case "checkpoint": {
      if (!ctx.agent) {
        ctx.addLine({ type: "error", content: "Agent not initialized.", timestamp: now });
        break;
      }

      const args = cmd.slice(name.length + 2).trim();
      const sessionFilePath = ctx.agent.getCurrentHistoryFilePath();
      const messages = ctx.agent.getHistory().getMessages();
      const planState = ctx.agent.planState;

      const parts = args.split(/\s+/);
      const subCommands = ["init", "all", "preset", "bg", "stop"];
      const subCommand = parts[0] ? parts[0].toLowerCase() : "";

      if (subCommand === "list") {
        ctx.addLine({ type: "system", content: "Retrieving checkpoints...", timestamp: now });
        listCheckpointsForSession(sessionFilePath)
          .then((checkpoints) => {
            if (checkpoints.length === 0) {
              ctx.addLine({ type: "system", content: "No checkpoints found for this session.", timestamp: Date.now() });
              return;
            }
            const outputLines = [
              "┌───[ 📋 SESSION CHECKPOINTS ]",
              "│ ",
            ];
            checkpoints.forEach((c) => {
              const dateStr = new Date(c.timestamp).toLocaleTimeString();
              const gitInfo = c.gitSha ? ` | Git: ${c.gitSha}` : "";
              outputLines.push(`│ • ID  : ${c.id}`);
              outputLines.push(`│   Name: ${c.name} (${dateStr}${gitInfo})`);
              outputLines.push(`│   Msgs: ${c.messages.length} messages`);
              outputLines.push("│ ");
            });
            outputLines.pop(); // remove last empty spacer
            outputLines.push("└───────────────────────────────");
            ctx.addLine({ type: "system", content: outputLines.join("\n"), timestamp: Date.now() });
          })
          .catch((err) => {
            ctx.addLine({ type: "error", content: `Failed to list checkpoints: ${err.message}`, timestamp: Date.now() });
          });
      } else if (subCommand === "restore") {
        const targetId = parts[1];
        if (!targetId) {
          ctx.addLine({ type: "error", content: "Usage: /checkpoint restore <checkpoint_id>", timestamp: now });
          break;
        }

        ctx.addLine({ type: "system", content: `Restoring checkpoint ${targetId}...`, timestamp: now });
        restoreCheckpointById(targetId, sessionFilePath)
          .then(async (checkpoint) => {
            if (!checkpoint) {
              ctx.addLine({ type: "error", content: `Checkpoint with ID "${targetId}" not found.`, timestamp: Date.now() });
              return;
            }

            // Kill active tasks/subagents
            terminateActiveTasksAndSubagents();

            // Reload agent history and sync planState
            if (ctx.resumeFromPath) {
              await ctx.resumeFromPath(sessionFilePath);
            }
            ctx.setPlanState?.(checkpoint.planState);

            ctx.addLine({
              type: "system",
              content: `✓ Checkpoint "${checkpoint.name}" successfully restored! (${checkpoint.messages.length} messages)`,
              timestamp: Date.now()
            });

            if (checkpoint.gitSha) {
              const targetCwd = ctx.agent?.workingDirectory || process.cwd();
              try {
                await execa("git", ["stash", "--include-untracked"], { cwd: targetCwd, reject: false });
                const checkoutRes = await execa("git", ["checkout", checkpoint.gitSha], { cwd: targetCwd, reject: false });
                if (checkoutRes.failed) {
                  ctx.addLine({
                    type: "error",
                    content: `Git restore gagal: ${checkoutRes.stderr || checkoutRes.message}. Riwayat percakapan tetap dipulihkan.`,
                    timestamp: Date.now()
                  });
                } else {
                  ctx.addLine({
                    type: "system",
                    content: `✓ Workspace dipulihkan ke Git commit: ${checkpoint.gitSha} (uncommitted changes di-stash)`,
                    timestamp: Date.now()
                  });
                }
              } catch (gitErr: any) {
                ctx.addLine({
                  type: "error",
                  content: `Git restore gagal: ${gitErr.message}. Riwayat percakapan tetap dipulihkan.`,
                  timestamp: Date.now()
                });
              }
            }
          })
          .catch((err) => {
            ctx.addLine({ type: "error", content: `Failed to restore checkpoint: ${err.message}`, timestamp: Date.now() });
          });
      } else {
        // Create a checkpoint
        const checkpointName = args || `Manual: Checkpoint at ${new Date(now).toLocaleTimeString()}`;
        ctx.addLine({ type: "system", content: `Creating checkpoint "${checkpointName}"...`, timestamp: now });
        createCheckpoint(sessionFilePath, checkpointName, messages, planState, ctx.agent?.workingDirectory)
          .then((c) => {
            const gitInfo = c.gitSha ? ` (Git: ${c.gitSha})` : "";
            ctx.addLine({
              type: "system",
              content: `✓ Checkpoint created successfully!\n  ID  : ${c.id}\n  Name: ${c.name}${gitInfo}`,
              timestamp: Date.now(),
            });
          })
          .catch((err) => {
            ctx.addLine({ type: "error", content: `Failed to create checkpoint: ${err.message}`, timestamp: Date.now() });
          });
      }
      break;
    }

    case "goal": {
      const goalArg = cmd.slice(name.length + 2).trim();
      if (!goalArg) {
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
        break;
      }
      if (!ctx.agent) {
        ctx.addLine({ type: "error", content: "Agent not available.", timestamp: now });
        break;
      }
      ctx.agent.goalMode = goalArg;
      ctx.setGoalMode?.({ goal: goalArg, startedAt: now });
      ctx.addLine({
        type: "system",
        content: [
          "🎯 GOAL MODE ACTIVATED",
          `   Objective : ${goalArg}`,
          "   Iterations: up to 200 steps (auto-continue enabled)",
          "   The agent will not stop until the goal is achieved.",
          "   Use Ctrl+C to abort at any time.",
        ].join("\n"),
        timestamp: now,
      });
      ctx.addLine({
        type: "user",
        content: `❯ /goal ${goalArg}`,
        timestamp: now,
      });
      // Write goal to scratchpad
      import("fs/promises").then(async (fsModule) => {
        import("path").then(async (pathModule) => {
          try {
            const scratchDir = pathModule.resolve(process.cwd(), "scratch");
            await fsModule.mkdir(scratchDir, { recursive: true });
            const scratchPath = pathModule.join(scratchDir, "scratchpad.md");
            let existing = "";
            try { existing = await fsModule.readFile(scratchPath, "utf-8"); } catch { /* ok */ }
            const goalBlock = `\n\n## 🎯 ACTIVE GOAL (set ${new Date(now).toISOString()})\n${goalArg}\n`;
            const cleaned = existing.replace(/\n\n## 🎯 ACTIVE GOAL[\s\S]*?(?=\n\n##|$)/g, "");
            await fsModule.writeFile(scratchPath, cleaned + goalBlock, "utf-8");
          } catch { /* ignore */ }
        });
      });
      ctx.setIsProcessing?.(true);
      ctx.agent.sendMessage(
        `GOAL MODE: Your primary objective is to achieve the following goal completely and verifiably:\n\n"${goalArg}"\n\nBegin immediately. Plan thoroughly, execute step by step, verify completion, and report back with GOAL_COMPLETE or GOAL_PARTIAL.`
      ).catch((err: any) => {
        ctx.addLine({ type: "error", content: `Goal mode error: ${err.message}`, timestamp: Date.now() });
      });
      break;
    }
    case "compact": {
      const currentModel = process.env.MODEL || getDefaultModel();
      const limit = getContextWindowLimit(currentModel);
      const summary = ctx.agent?.getHistory().getCompactSummary(limit);
      ctx.addLine({ type: "system", content: summary || "No history.", timestamp: now });
      break;
    }
    case "init":
      (async () => {
        const cwd = process.cwd();

        // ── Git Setup ──────────────────────────────────
        let gitStatus = "NOT DETECTED";
        let gitBranch = "";
        let gitSha = "";
        let gitInitialized = false;

        try {
          const { stdout } = await execa("git", ["rev-parse", "--is-inside-work-tree"], { cwd, reject: false });
          if (stdout?.trim() === "true") {
            gitStatus = "ACTIVE";
          }
        } catch {}

        if (gitStatus !== "ACTIVE") {
          // Auto-initialize git
          ctx.addLine({ type: "system", content: "🔧 Git not detected. Initializing repository...", timestamp: now });
          try {
            await execa("git", ["init"], { cwd });
            gitStatus = "INITIALIZED";
            gitInitialized = true;

            // Create .gitignore if it doesn't exist
            const gitignorePath = path.join(cwd, ".gitignore");
            try {
              await fs.access(gitignorePath);
            } catch {
              const defaultGitignore = [
                "node_modules/",
                "dist/",
                "build/",
                ".env",
                ".env.local",
                "*.log",
                ".DS_Store",
                "Thumbs.db",
                "",
              ].join("\n");
              await fs.writeFile(gitignorePath, defaultGitignore, "utf-8");
              ctx.addLine({ type: "system", content: "📄 Created default .gitignore", timestamp: Date.now() });
            }

            ctx.addLine({ type: "system", content: "✓ Git repository initialized successfully!", timestamp: Date.now() });
          } catch (gitErr: any) {
            ctx.addLine({ type: "error", content: `Git init failed: ${gitErr.message}`, timestamp: Date.now() });
            gitStatus = "FAILED";
          }
        }

        // Gather git info if repo exists
        if (gitStatus === "ACTIVE" || gitStatus === "INITIALIZED") {
          try {
            const { stdout: branch } = await execa("git", ["branch", "--show-current"], { cwd, reject: false });
            gitBranch = branch?.trim() || "(detached)";
          } catch {}
          try {
            const { stdout: sha } = await execa("git", ["rev-parse", "--short", "HEAD"], { cwd, reject: false });
            gitSha = sha?.trim() || (gitInitialized ? "(no commits yet)" : "unknown");
          } catch {
            gitSha = gitInitialized ? "(no commits yet)" : "unknown";
          }
        }

        // ── agents.md Setup ────────────────────────────
        const agentsPath = path.resolve(cwd, "agents.md");
        let fileStatus = "LOADED";
        try {
          await fs.access(agentsPath);
        } catch {
          // Auto-detect project info from package.json or directory name
          let detectedName = path.basename(cwd);
          let detectedDesc = "A software project.";
          let detectedTech = "Unknown";

          try {
            const pkgPath = path.join(cwd, "package.json");
            const pkgContent = await fs.readFile(pkgPath, "utf-8");
            const pkg = JSON.parse(pkgContent);
            if (pkg.name) detectedName = pkg.name;
            if (pkg.description) detectedDesc = pkg.description;

            // Detect tech stack from dependencies
            const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
            const techs: string[] = [];
            if (allDeps["typescript"]) techs.push("TypeScript");
            else techs.push("JavaScript");
            if (allDeps["react"] || allDeps["react-dom"]) techs.push("React");
            if (allDeps["next"]) techs.push("Next.js");
            if (allDeps["vue"]) techs.push("Vue");
            if (allDeps["svelte"]) techs.push("Svelte");
            if (allDeps["express"]) techs.push("Express");
            if (allDeps["fastify"]) techs.push("Fastify");
            if (allDeps["ink"]) techs.push("Ink (CLI)");
            if (allDeps["electron"]) techs.push("Electron");
            if (allDeps["vite"]) techs.push("Vite");
            if (allDeps["tailwindcss"]) techs.push("Tailwind CSS");
            if (allDeps["prisma"] || allDeps["@prisma/client"]) techs.push("Prisma");
            if (allDeps["mongoose"]) techs.push("MongoDB/Mongoose");
            if (techs.length > 0) detectedTech = techs.join(", ");
          } catch {
            // No package.json — check for other project types
            try {
              await fs.access(path.join(cwd, "requirements.txt"));
              detectedTech = "Python";
            } catch {}
            try {
              await fs.access(path.join(cwd, "Cargo.toml"));
              detectedTech = "Rust";
            } catch {}
            try {
              await fs.access(path.join(cwd, "go.mod"));
              detectedTech = "Go";
            } catch {}
            try {
              await fs.access(path.join(cwd, "pom.xml"));
              detectedTech = "Java (Maven)";
            } catch {}
          }

          if (detectedTech === "Unknown" && ctx.setActiveWizard) {
            ctx.setActiveWizard({
              type: "login",
              step: 10,
              data: { gitStatus, gitBranch, gitSha },
            });
            ctx.setWizardOptions?.([
              "1. Node.js (TypeScript)",
              "2. Node.js (JavaScript)",
              "3. Python",
              "4. Rust",
              "5. Go",
              "6. Ask AI to describe & build it (Dynamic)"
            ]);
            ctx.setWizardSelectedIndex?.(0);
            return;
          }

          const defaultContent = [
            `# Project Specifications (agents.md)`,
            ``,
            `This file contains key information about the project for AI agents to study and align with.`,
            ``,
            `## Project Overview`,
            `- **Name**: ${detectedName}`,
            `- **Description**: ${detectedDesc}`,
            `- **Technology Stack**: ${detectedTech}`,
            ``,
            `## Coding Guidelines`,
            `- On Windows, statement separator for terminal commands is ';' instead of '&&'.`,
            `- Always verify compilation and run tests before committing.`,
            ``,
          ].join("\n");

          await fs.writeFile(agentsPath, defaultContent, "utf-8");
          fileStatus = "CREATED";
          ctx.addLine({ type: "system", content: `📄 Generated agents.md (detected: ${detectedName}, ${detectedTech})`, timestamp: Date.now() });
        }

        let projectName = "Unknown";
        let projectTech = "Unknown";
        try {
          const content = await fs.readFile(agentsPath, "utf-8");
          const nameMatch = content.match(/-\s*\*\*Name\*\*:\s*(.*)/i);
          if (nameMatch) projectName = nameMatch[1].trim();
          const techMatch = content.match(/-\s*\*\*Technology Stack\*\*:\s*(.*)/i);
          if (techMatch) projectTech = techMatch[1].trim();
        } catch (err: any) {
          ctx.addLine({ type: "error", content: `Failed to read agents.md: ${err.message}`, timestamp: now });
          return;
        }

        const modelName = process.env.MODEL || getDefaultModel();
        let limit = getContextWindowLimit(modelName);
        if (process.env.CONTEXT_WINDOW_LIMIT) {
          const parsed = parseInt(process.env.CONTEXT_WINDOW_LIMIT, 10);
          if (!isNaN(parsed)) limit = parsed;
        }

        const gitStatusLabel = gitStatus === "ACTIVE" ? "✓ ACTIVE" : gitStatus === "INITIALIZED" ? "✓ INITIALIZED (new)" : `✗ ${gitStatus}`;

        const auditLines = [
          "┌───[ ⚙️ SYSTEM AUDIT & AGENT INITIALIZATION ]",
          "│ ",
          "│ [HOST INFO]",
          `│ 🖥️ OS Platform   : ${process.platform}`,
          `│ 📦 Node Version   : ${process.version}`,
          `│ 📂 Workspace      : ${cwd}`,
          "│ ",
          "│ [VERSION CONTROL]",
          `│ 🔀 Git Status     : ${gitStatusLabel}`,
          ...(gitBranch ? [`│ 🌿 Branch         : ${gitBranch}`] : []),
          ...(gitSha ? [`│ 📌 HEAD           : ${gitSha}`] : []),
          "│ ",
          "│ [COGNITIVE CORE]",
          `│ ✦ Provider        : ${process.env.CUSTOM_BASE_URL ? "custom" : process.env.ANTHROPIC_API_KEY ? "anthropic" : "openai"}`,
          `│ ✦ Active Model    : ${modelName}`,
          `│ ✦ Context Limit   : ${limit.toLocaleString()} tokens`,
          `│ ✦ Streaming       : ${process.env.DISABLE_STREAMING === "true" ? "DISABLED" : "ENABLED"}`,
          "│ ",
          "│ [PROJECT METADATA]",
          `│ 📄 Registry File  : ${fileStatus} (${agentsPath})`,
          `│ 📂 Project Name   : ${projectName}`,
          `│ 🛠️ Tech Stack      : ${projectTech}`,
          "│ ",
          "│ [SYSTEM TOOLS]",
          `│ 🛠️ Loaded Tools (${allTools.length}): ${allTools.map(t => t.name).join(", ")}`,
          "│ ",
          "└──────────────────────────────────────────────"
        ];

        ctx.addLine({
          type: "system",
          content: auditLines.join("\n"),
          timestamp: now,
        });
      })().catch(err => {
        ctx.addLine({ type: "error", content: `Init failed: ${err.message}`, timestamp: now });
      });
      break;
    case "login": {
      const args = cmd.slice(name.length + 2).trim();
      if (!args) {
        if (ctx.setActiveWizard) {
          const list = getConfiguredProviders();
          if (list.length > 0) {
            ctx.setActiveWizard({
              type: "login",
              step: 1,
              data: {},
            });
            ctx.setWizardOptions?.([
              "1. Add / Log in to a Provider",
              "2. Switch Active Provider",
              "3. List Configured Providers"
            ]);
          } else {
            ctx.setActiveWizard({
              type: "login",
              step: 2,
              data: {},
            });
            ctx.setWizardOptions?.(["1. OpenRouter (Recommended)", "2. OpenAI", "3. Anthropic", "4. Custom Endpoint"]);
          }
          ctx.setWizardSelectedIndex?.(0);
        } else {
          ctx.addLine({
            type: "system",
            content: [
              "Usage:",
              "  /login <api_key> (auto-detects OpenRouter, Anthropic, OpenAI)",
              "  /login openrouter <api_key>",
              "  /login anthropic <api_key>",
              "  /login openai <api_key>",
              "  /login custom <base_url> <api_key>",
            ].join("\n"),
            timestamp: now,
          });
        }
        break;
      }

      const parts = args.split(/\s+/);
      let provider = "";
      let apiKey = "";
      let baseUrl = "";

      if (parts[0].toLowerCase() === "custom") {
        if (parts.length < 3) {
          ctx.addLine({
            type: "error",
            content: "Error: /login custom requires <base_url> and <api_key>",
            timestamp: now,
          });
          break;
        }
        provider = "custom";
        baseUrl = parts[1];
        apiKey = parts[2];
      } else if (["openrouter", "anthropic", "openai"].includes(parts[0].toLowerCase())) {
        if (parts.length < 2) {
          ctx.addLine({
            type: "error",
            content: `Error: /login ${parts[0]} requires <api_key>`,
            timestamp: now,
          });
          break;
        }
        provider = parts[0].toLowerCase();
        apiKey = parts[1];
      } else {
        apiKey = parts[0];
        if (apiKey.startsWith("sk-or-")) {
          provider = "openrouter";
        } else if (apiKey.startsWith("sk-ant-")) {
          provider = "anthropic";
        } else {
          provider = "openai";
        }
      }

      const profileName = provider;
      const prefix = `PROVIDER_${profileName.toUpperCase()}`;
      const updates: Record<string, string> = {
        ACTIVE_PROVIDER: profileName,
        [`${prefix}_TYPE`]: provider,
        [`${prefix}_API_KEY`]: apiKey,
      };

      if (baseUrl) {
        updates[`${prefix}_BASE_URL`] = baseUrl;
      } else if (provider === "openrouter") {
        updates[`${prefix}_BASE_URL`] = "https://openrouter.ai/api/v1";
      }

      try {
        updateEnvFile(updates);
        const envPath = switchActiveProvider(profileName);
        ctx.addLine({
          type: "system",
          content: `Successfully logged in. Configured provider: ${profileName} (${provider}).\nSaved to: ${envPath}`,
          timestamp: now,
        });

        if (provider === "openrouter" && !process.env.MODEL) {
          updateEnvFile({ MODEL: "google/gemini-2.5-flash" });
        }

        fetchAndCacheModels()
          .then(() => {
            const currentModel = process.env.MODEL || getDefaultModel();
            const limit = getContextWindowLimit(currentModel);
            if (ctx.setContextLimit) {
              ctx.setContextLimit(limit);
            }
          })
          .catch(() => {});
      } catch (err: any) {
        ctx.addLine({
          type: "error",
          content: `Failed to save login credentials: ${err.message}`,
          timestamp: now,
        });
      }
      break;
    }
    case "model": {
      const modelName = cmd.slice(name.length + 2).trim();
      if (modelName) {
        try {
          const envPath = updateEnvFile({ MODEL: modelName });
          const limit = getContextWindowLimit(modelName);
          if (ctx.setContextLimit) {
            ctx.setContextLimit(limit);
          }
          ctx.addLine({
            type: "system",
            content: `Model changed to: ${modelName}\nContext limit: ${limit.toLocaleString()} tokens\nSaved to: ${envPath}`,
            timestamp: now,
          });
          fetchAndCacheModels()
            .then(() => {
              const newLimit = getContextWindowLimit(modelName);
              if (ctx.setContextLimit) {
                ctx.setContextLimit(newLimit);
              }
            })
            .catch(() => {});
        } catch (err: any) {
          ctx.addLine({
            type: "error",
            content: `Failed to set model: ${err.message}`,
            timestamp: now,
          });
        }
      } else {
        const currentModel = process.env.MODEL || getDefaultModel();
        ctx.addLine({
          type: "system",
          content: `Current Model: ${currentModel}`,
          timestamp: now,
        });

        if (ctx.setActiveWizard) {
          ctx.setActiveWizard({
            type: "model",
            step: 1,
            data: {},
          });
          const list = getConfiguredProviders();
          const options = list.map(p => `${p.name} (${p.type}${p.baseUrl ? ` - ${p.baseUrl}` : ""})${p.isActive ? " [Active]" : ""}`);
          ctx.setWizardOptions?.(options.length > 0 ? options : ["1. OpenRouter (Recommended)", "2. OpenAI", "3. Anthropic", "4. Custom Endpoint"]);
          ctx.setWizardSelectedIndex?.(0);
        }
      }
      break;
    }
    case "agents": {
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
        timestamp: now,
      });
      break;
    }
    case "worktree":
    case "worktrees": {
      ctx.addLine({
        type: "system",
        content: "Retrieving git worktrees...",
        timestamp: now,
      });
      ctx.setIsProcessing?.(true);
      execa("git", ["worktree", "list"])
        .then((result) => {
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
        })
        .catch((err) => {
          const isNotGit = err.stderr && err.stderr.toLowerCase().includes("not a git repository");
          const errorMsg = isNotGit ? "Not a Git repository." : err.message;
          ctx.addLine({
            type: "error",
            content: `Failed to retrieve worktrees: ${errorMsg}`,
            timestamp: Date.now(),
          });
        })
        .finally(() => {
          ctx.setIsProcessing?.(false);
        });
      break;
    }
    case "processes":
    case "procs": {
      const args = cmd.slice(name.length + 2).trim();
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

      const windowTasks  = taskList.filter(([, t]) => (t as any).isDetachedWindow);
      const bgTasks      = taskList.filter(([, t]) => !(t as any).isDetachedWindow);

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

      (async () => {
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
      })().catch(err => {
        lines.push(`│   Error parsing task checklist: ${err.message}`);
        lines.push("└──────────────────────────────────────────────");
        ctx.addLine({
          type: "system",
          content: lines.join("\n"),
          timestamp: now,
        });
      });
      break;
    }
    case "install": {
      const args = cmd.slice(name.length + 2).trim();
      if (!args) {
        ctx.addLine({
          type: "error",
          content: "Usage: /install <owner/repo> (e.g. /install vercel-labs/skills/find-skills)",
          timestamp: now,
        });
        break;
      }
      ctx.addLine({
        type: "system",
        content: `Installing skill "${args}" via skills.sh...`,
        timestamp: now,
      });

      (async () => {
        try {
          const isWin = process.platform === "win32";
          const shell = isWin ? "powershell.exe" : true;
          const result = await execa("npx", ["skills", "add", args], {
            shell,
            cwd: process.cwd(),
            reject: false,
          });
          if (result.failed) {
            ctx.addLine({
              type: "error",
              content: `Failed to install skill: ${result.stderr || result.stdout || "Unknown error"}`,
              timestamp: Date.now(),
            });
          } else {
            ctx.addLine({
              type: "system",
              content: `✓ Successfully installed skill: ${args}!\nOutput:\n${result.stdout}`,
              timestamp: Date.now(),
            });
          }
        } catch (err: any) {
          ctx.addLine({
            type: "error",
            content: `Failed to execute install command: ${err.message}`,
            timestamp: Date.now(),
          });
        }
      })();
      break;
    }
    case "skills": {
      const skills = getInstalledSkills();
      if (skills.length === 0) {
        ctx.addLine({
          type: "system",
          content: "No skills installed. Use /install <owner/repo> to install skills.",
          timestamp: now,
        });
        break;
      }
      const options = skills.map(s => `• ${s.name} - ${s.description.slice(0, 50)}${s.description.length > 50 ? "..." : ""}`);
      ctx.setActiveWizard?.({
        type: "skills",
        step: 1,
        data: {},
      });
      ctx.setWizardOptions?.(options);
      ctx.setWizardSelectedIndex?.(0);
      break;
    }
    case "terminal": {
      const args = cmd.slice(name.length + 2).trim();
      const cwd = process.cwd();

      if (args.toLowerCase() === "init") {
        ctx.addLine({
          type: "user",
          content: "❯ /terminal init",
          timestamp: Date.now()
        });
        ctx.addLine({
          type: "system",
          content: "Starting interactive preset creator wizard guided by AI...",
          timestamp: Date.now()
        });
        ctx.setIsProcessing?.(true);
        ctx.agent?.sendMessage(
          "USER COMMAND: /terminal init\n\n" +
          "You are initializing terminal presets for the user's workspace. Follow these steps:\n" +
          "1. Inspect the workspace files (e.g. read package.json scripts/dependencies, Cargo.toml, go.mod, requirements.txt, or list directories) to identify the project type and find common commands.\n" +
          "2. Dynamically construct AI suggestions/recommendations of potential terminal preset commands (e.g. dev/start servers, watch processes, test suites, builds) based on your discovery.\n" +
          "3. Ask the user to select which commands they want to set up as presets. You MUST call the `ask_question` tool with `isMultiSelect: true` so the user can check/uncheck multiple suggested commands using Space and Enter.\n" +
          "4. Once selected, guide them or define the preset names, custom working directories, and env variables if needed.\n" +
          "5. Write the final configuration back to the local project file `.superagent-r/terminal-presets.json` using a file writing tool. Confirm to the user once it is completed."
        ).catch((err: any) => {
          ctx.addLine({ type: "error", content: `Wizard error: ${err.message}`, timestamp: Date.now() });
        });
        break;
      }

      // /terminal stop [id|all] — kill running terminal processes
      if (args.toLowerCase() === "stop" || args.toLowerCase().startsWith("stop ")) {
        const stopArg = args.slice(4).trim().toLowerCase();
        const termTasks = Array.from(backgroundTasks.entries()).filter(([id]) => id.startsWith("term-"));

        if (termTasks.length === 0) {
          ctx.addLine({
            type: "system",
            content: "🖥️ No running terminal processes to stop.",
            timestamp: Date.now()
          });
          return;
        }

        if (!stopArg || stopArg === "all") {
          // Stop all terminal processes
          let count = 0;
          for (const [id, task] of termTasks) {
            try { killProcessTree(task.process.pid); } catch {}
            // Append exit marker so the viewer loop breaks
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
            content: `🛑 Stopped ${count} terminal process${count !== 1 ? "es" : ""}.`,
            timestamp: Date.now()
          });
        } else {
          // Stop specific task by ID (accept with or without "term-" prefix)
          const fullId = stopArg.startsWith("term-") ? stopArg : `term-${stopArg}`;
          const task = backgroundTasks.get(fullId);
          if (!task) {
            const ids = termTasks.map(([id]) => id).join(", ");
            ctx.addLine({
              type: "error",
              content: `Error: Terminal process "${fullId}" not found.\nRunning IDs: ${ids || "(none)"}`,
              timestamp: Date.now()
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
          backgroundTasks.delete(fullId);
          notifyTasksChanged();
          ctx.addLine({
            type: "system",
            content: `🛑 Stopped terminal process [${fullId}]: "${task.command}"`,
            timestamp: Date.now()
          });
        }
        return;
      }

      // /terminal bg [preset] <name|command> — run headless in background, capture output
      if (args.toLowerCase() === "bg" || args.toLowerCase().startsWith("bg ")) {
        const bgRaw = args.slice(2).trim(); // everything after "bg"

        (async () => {
          // Load presets
          const localPresetDir = path.join(cwd, ".superagent-r");
          const localPresetPath = path.join(localPresetDir, "terminal-presets.json");
          const localRootPresetPath = path.join(cwd, "terminal-presets.json");
          const globalPresetPath = path.join(os.homedir(), ".superagent-r", "terminal-presets.json");
          const paths = [localPresetPath, localRootPresetPath, globalPresetPath];
          let presets: Record<string, any> = {};
          for (const p of paths) {
            try {
              const content = await fs.readFile(p, "utf-8");
              const data = JSON.parse(content);
              presets = data?.presets ?? data;
              break;
            } catch { /* ignore */ }
          }

          if (!bgRaw) {
            // Show list of bg-able presets
            const keys = Object.keys(presets);
            const presetsList = keys.length > 0
              ? keys.map(k => `  • ${getPresetLabel(k, presets[k])}: ${formatPresetValue(presets[k])}`).join("\n")
              : "  (No presets configured)";
            ctx.addLine({
              type: "system",
              content: [
                "🖥️ TERMINAL BG — Run preset or command silently in background",
                "Usage:",
                "  /terminal bg <command>          - Run any command in background",
                "  /terminal bg preset <name>      - Run a configured preset in background",
                "  /terminal bg <preset_name>      - Run preset directly by name",
                "",
                "Available Presets:",
                presetsList,
              ].join("\n"),
              timestamp: Date.now()
            });
            return;
          }

          // Resolve command string from preset or raw input
          let commandStr = bgRaw;
          let bgPresetName = "";
          if (bgRaw.toLowerCase().startsWith("preset ")) {
            const requestedName = bgRaw.slice(7).trim();
            const found = findPreset(presets, requestedName);
            if (!found) {
              ctx.addLine({ type: "error", content: `Error: Preset "${requestedName}" not found.`, timestamp: Date.now() });
              return;
            }
            bgPresetName = getPresetLabel(found.key, found.value);
            const val = found.value;
            commandStr = typeof val === "object" && val !== null ? (val.command || JSON.stringify(val)) : String(val);
          } else {
            const found = findPreset(presets, bgRaw);
            if (found) {
              bgPresetName = getPresetLabel(found.key, found.value);
              const val = found.value;
              commandStr = typeof val === "object" && val !== null ? (val.command || JSON.stringify(val)) : String(val);
            }
          }

          const taskId = `term-bg-${Math.random().toString(36).substring(2, 9)}`;
          const tasksLogDir = process.env.SUPERAGENT_SESSION_PATH
            ? path.join(path.dirname(process.env.SUPERAGENT_SESSION_PATH), "tasks")
            : path.join(getGlobalConfigDir(), "tasks");
          if (!fsCb.existsSync(tasksLogDir)) fsCb.mkdirSync(tasksLogDir, { recursive: true });
          const logPath = path.join(tasksLogDir, `${taskId}.log`);
          try { fsCb.writeFileSync(logPath, ""); } catch { /* ignore */ }

          // Resolve shell
          let shellPath: string | boolean = true;
          if (process.platform === "win32") {
            shellPath = "powershell.exe";
          }

          const proc = execa(commandStr, {
            shell: shellPath,
            cwd,
            reject: false,
            all: true,
          });

          const task: BackgroundTask = {
            id: taskId,
            command: commandStr,
            process: proc,
            output: [],
            logPath,
          };

          backgroundTasks.set(taskId, task);
          notifyTasksChanged();

          proc.all?.on("data", (data: Buffer) => {
            const text = data.toString();
            task.output.push(text);
            if (task.output.length > 1000) task.output.shift();
            try { fsCb.appendFileSync(logPath, text); } catch { /* ignore */ }
          });

          proc.on("close", (code: number | null) => {
            task.hasExited = true;
            task.exitCode = code;
            const exitMsg = `\n[Process exited with code ${code}]`;
            task.output.push(exitMsg);
            try { fsCb.appendFileSync(logPath, exitMsg); } catch { /* ignore */ }
            notifyTasksChanged();
          });

          ctx.addLine({
            type: "system",
            content: [
              `⚙️ Background process started [ID: ${taskId}]`,
              `  Command : ${commandStr}`,
              `  Log     : ${logPath}`,
              bgPresetName ? `  Preset  : ${bgPresetName}` : "",
              `Use /processes to monitor, or /processes stop ${taskId} to kill.`,
            ].filter(Boolean).join("\n"),
            timestamp: Date.now()
          });
        })().catch(err => {
          ctx.addLine({ type: "error", content: `Failed to start background process: ${err.message}`, timestamp: Date.now() });
        });
        return;
      }
      
      const loadPresetsAndRun = async () => {
        const localPresetDir = path.join(cwd, ".superagent-r");
        const localPresetPath = path.join(localPresetDir, "terminal-presets.json");
        const localRootPresetPath = path.join(cwd, "terminal-presets.json");
        const globalPresetPath = path.join(os.homedir(), ".superagent-r", "terminal-presets.json");

        const paths = [localPresetPath, localRootPresetPath, globalPresetPath];
        let presets: Record<string, string | string[]> = {};
        for (const p of paths) {
          try {
            const content = await fs.readFile(p, "utf-8");
            const data = JSON.parse(content);
            if (data && data.presets) {
              presets = data.presets;
            } else {
              presets = data;
            }
            break;
          } catch {
            // ignore
          }
        }

        if (!args) {
          const keys = Object.keys(presets);
          const presetsList = keys.length > 0
            ? keys.map(k => `  • ${getPresetLabel(k, presets[k])}: ${formatPresetValue(presets[k])}`).join("\n")
            : "  (No presets configured)";
          ctx.addLine({
            type: "system",
            content: [
              "🖥️ TERMINAL COMMAND & PRESETS",
              "Usage:",
              "  /terminal <command>         - Run command in a new terminal window",
              "  /terminal all               - Launch ALL configured presets at once",
              "  /terminal preset <name>     - Run a configured preset",
              "  /terminal <preset_name>     - Run a preset directly (if name matches)",
              "",
              "Available Presets:",
              presetsList,
              "",
              "Presets can be configured in `.superagent-r/terminal-presets.json` or `terminal-presets.json`.",
            ].join("\n"),
            timestamp: Date.now()
          });
          return;
        }

        let commandToRun: any = args;
        let isPreset = false;
        let presetName = "";

        // Declare runCmd up-front so it can be referenced by the "all" branch below
        const runCmd = async (singleCmd: any, labelOverride?: string) => {
          let commandStr = "";
          let runCwd = cwd;
          let runEnv = { ...process.env };

          if (typeof singleCmd === "object" && singleCmd !== null) {
            commandStr = singleCmd.command || "";
            if (singleCmd.cwd) {
              runCwd = path.resolve(cwd, singleCmd.cwd);
            }
            if (singleCmd.env) {
              runEnv = { ...runEnv, ...singleCmd.env };
            }
          } else {
            commandStr = String(singleCmd);
          }

          if (!commandStr) return;

          const taskId    = `term-${Math.random().toString(36).substring(2, 9)}`;
          const windowLabel = labelOverride || presetName || commandStr.split(" ")[0];

          // ── Log file setup ────────────────────────────────────────────
          const logDir  = path.join(getGlobalConfigDir(), "tasks");
          if (!fsCb.existsSync(logDir)) fsCb.mkdirSync(logDir, { recursive: true });
          const logPath = path.join(logDir, `${taskId}.log`);
          const closeSignalPath = path.join(logDir, `${taskId}.closed.json`);
          fsCb.writeFileSync(logPath, `[Terminal: ${windowLabel}]\n[Command: ${commandStr}]\n[Started: ${new Date().toISOString()}]\n\n`);
          try { fsCb.rmSync(closeSignalPath, { force: true }); } catch { /* ignore */ }

          ctx.addLine({
            type: "system",
            content: `🖥️ Spawning terminal [ID: ${taskId}]: "${commandStr}" (cwd: ${runCwd})\n   Log: ${logPath}`,
            timestamp: Date.now()
          });

          // ── Spawn the REAL process (we keep the handle for output capture) ──
          let shellExe: string | boolean = true;
          if (process.platform === "win32") shellExe = "powershell.exe";

          const proc = execa(commandStr, {
            shell: shellExe,
            cwd: runCwd,
            env: runEnv,
            reject: false,
            all: true,
          });

          const task: BackgroundTask = {
            id: taskId,
            command: commandStr,
            process: proc,
            output: [],
            logPath,
            isDetachedWindow: true,
            windowLabel,
          };

          backgroundTasks.set(taskId, task);
          notifyTasksChanged();

          // Stream stdout+stderr → task.output[] AND log file
          proc.all?.on("data", (data: Buffer) => {
            const text = data.toString();
            task.output.push(text);
            if (task.output.length > 2000) task.output.shift();
            try { fsCb.appendFileSync(logPath, text); } catch { /* ignore */ }
          });

          // ── Open a VIEWER window that tails the log file ───────────────
          // Write a temp PS1 polling script so the window shows live output
          // and cleanly prompts on exit (Get-Content -Wait never exits on its own).
          try {
            const safeLog   = logPath.replace(/\\/g, "\\\\").replace(/'/g, "''");
            const safeTitle = windowLabel.replace(/"/g, "");
            const safeCwd   = runCwd.replace(/"/g, "");

            if (process.platform === "win32") {
              const safeCloseSignal = closeSignalPath.replace(/\\/g, "\\\\").replace(/'/g, "''");
              // Write a polling viewer script to avoid Get-Content -Wait never-exit bug.
              // The finally block signals Superagent when the user closes the viewer window.
              const viewerScript = [
                `$logPath = '${safeLog}'`,
                `$closeSignalPath = '${safeCloseSignal}'`,
                `$lastPos = 0`,
                `try {`,
                `  Write-Host "=== ${safeTitle} === (close window to stop process)" -ForegroundColor Cyan`,
                `  Write-Host ''`,
                `  while ($true) {`,
                `    try {`,
                `      $bytes = [System.IO.File]::ReadAllBytes($logPath)`,
                `      if ($bytes.Length -gt $lastPos) {`,
                `        $chunk = [System.Text.Encoding]::UTF8.GetString($bytes, $lastPos, $bytes.Length - $lastPos)`,
                `        Write-Host $chunk -NoNewline`,
                `        $lastPos = $bytes.Length`,
                `      }`,
                `      if ($lastPos -gt 0) {`,
                `        $tail = [System.Text.Encoding]::UTF8.GetString($bytes)`,
                `        if ($tail -match '\\[Process exited') { break }`,
                `      }`,
                `    } catch {}`,
                `    Start-Sleep -Milliseconds 200`,
                `  }`,
                `  Write-Host ''`,
                `  Write-Host '[Process finished. Press Enter to close.]' -ForegroundColor Green`,
                `  Read-Host`,
                `} finally {`,
                `  try {`,
                `    $payload = @{ action = 'closed'; timestamp = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress`,
                `    [System.IO.File]::WriteAllText($closeSignalPath, $payload, [System.Text.Encoding]::UTF8)`,
                `  } catch {}`,
                `  try { Remove-Item $MyInvocation.MyCommand.Path -Force } catch {}`,
                `}`,
              ].join("\n");
              const viewerScriptPath = path.join(logDir, `${taskId}-viewer.ps1`);
              fsCb.writeFileSync(viewerScriptPath, viewerScript, "utf8");

              const viewerProc = execa(
                "cmd.exe",
                ["/c", `start /wait "${safeTitle}" /D "${safeCwd}" powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${viewerScriptPath}"`],
                { detached: true, stdio: "ignore", windowsVerbatimArguments: true, reject: false }
              );
              const handleViewerExit = () => {
                if (!task.hasExited) {
                  const closeMsg = `\n[Terminal window closed; process killed at ${new Date().toISOString()}]`;
                  task.hasExited = true;
                  task.exitCode = null;
                  task.output.push(closeMsg);
                  try { fsCb.appendFileSync(logPath, closeMsg); } catch { /* ignore */ }
                  try { killProcessTree(proc.pid); } catch { /* ignore */ }
                  backgroundTasks.delete(taskId);
                  notifyTasksChanged();
                }
              };
              viewerProc.on("close", handleViewerExit);
              viewerProc.on("exit", handleViewerExit);
            } else if (process.platform === "darwin") {
              const script = `tell application "Terminal" to do script "tail -f '${safeLog}'"`;
              execa("osascript", ["-e", script], { detached: true, stdio: "ignore" }).unref();
            } else {
              execa("x-terminal-emulator", ["-e", `bash -c "tail -f '${safeLog}'"`],
                { detached: true, stdio: "ignore", reject: false }).unref();
            }
          } catch { /* viewer is optional — main process still runs */ }

          // ── Track exit (we have the real handle now) ───────────────────
          proc.on("close", (code: number | null) => {
            task.hasExited = true;
            task.exitCode  = code;
            const exitMsg  = `\n[Process exited with code ${code} at ${new Date().toISOString()}]`;
            task.output.push(exitMsg);
            try { fsCb.appendFileSync(logPath, exitMsg); } catch { /* ignore */ }
            notifyTasksChanged();
          });

          // ── Add to chat as context for AI (do NOT sendMessage — that wakes AI) ──
          ctx.addLine({
            type: "system",
            content:
              `[TERMINAL CONTEXT] ID: ${taskId} | Label: ${windowLabel}\n` +
              `  Command : ${commandStr}\n` +
              `  Log     : ${logPath}\n` +
              `  AI can read this log file to see the live output.`,
            timestamp: Date.now(),
          });
        };

        if (args.toLowerCase() === "all") {
          // `/terminal all` — launch every preset in its own window
          const keys = Object.keys(presets);
          if (keys.length === 0) {
            ctx.addLine({
              type: "system",
              content: "No presets configured. Run `/terminal init` to set some up.",
              timestamp: Date.now()
            });
            return;
          }
          ctx.addLine({
            type: "system",
            content: `🚀 Launching all ${keys.length} preset(s)…`,
            timestamp: Date.now()
          });
          for (const k of keys) {
            const val = presets[k];
            const label = getPresetLabel(k, val);
            if (Array.isArray(val)) {
              for (const item of val) {
                await runCmd(item, label);
              }
            } else {
              await runCmd(val, label);
            }
          }
          return;
        } else if (args.toLowerCase() === "preset") {
          // `/terminal preset` with no name — show list of presets
          const keys = Object.keys(presets);
          const presetsList = keys.length > 0
            ? keys.map(k => `  • ${getPresetLabel(k, presets[k])}: ${formatPresetValue(presets[k])}`).join("\n")
            : "  (No presets configured)";
          ctx.addLine({
            type: "system",
            content: [
              "🖥️ TERMINAL COMMAND & PRESETS",
              "Usage:",
              "  /terminal preset <name>     - Run a configured preset",
              "  /terminal <preset_name>     - Run a preset directly (if name matches)",
              "",
              "Available Presets:",
              presetsList,
              "",
              "Presets can be configured in `.superagent-r/terminal-presets.json` or `terminal-presets.json`.",
              "Run `/terminal init` to set up presets with AI guidance.",
            ].join("\n"),
            timestamp: Date.now()
          });
          return;
        } else if (args.toLowerCase().startsWith("preset ")) {
          const requestedName = args.slice(7).trim();
          const found = findPreset(presets, requestedName);
          if (found) {
            commandToRun = found.value;
            isPreset = true;
            presetName = getPresetLabel(found.key, found.value);
          } else {
            ctx.addLine({
              type: "error",
              content: `Error: Preset "${requestedName}" not found. Run /terminal preset to see available presets.`,
              timestamp: Date.now()
            });
            return;
          }
        } else {
          const found = findPreset(presets, args);
          if (found) {
            commandToRun = found.value;
            isPreset = true;
            presetName = getPresetLabel(found.key, found.value);
          }
        }

        if (Array.isArray(commandToRun)) {
          ctx.addLine({
            type: "system",
            content: `Running preset "${presetName}" with ${commandToRun.length} commands...`,
            timestamp: Date.now()
          });
          for (const c of commandToRun) {
            await runCmd(c);
          }
        } else {
          await runCmd(commandToRun);
        }
      };

      loadPresetsAndRun().catch(err => {
        ctx.addLine({
          type: "error",
          content: `Failed to execute terminal command: ${err.message}`,
          timestamp: Date.now()
        });
      });
      break;
    }
    case "help":
      ctx.addLine({
        type: "system",
        content: [
          "Commands:",
          "  /new      - Start new session (clear history & screen)",
          "  /resume   - Resume a conversation session from history via wizard dialog",
          "  /search-history - Search all previous local workspace conversation history files",
          "                    Usage: /search-history <query-text>",
          "  /clear    - Clear conversation history",
          "  /compact  - Show conversation summary",
          "  /checkpoint - Manage checkpoints to save/restore conversation state",
          "                Usage: /checkpoint [list|restore <id>|<name>]",
          "  /goal     - Activate Goal Mode for long-running overnight tasks",
          "              Usage: /goal <description>  (e.g. /goal implement JWT auth end-to-end)",
          "  /init     - Initialize project (Git setup, agents.md generation, system audit)",
          "  /agents   - List active subagents and defined subagent types",
          "  /worktrees - List all registered Git worktrees (alias: /worktree)",
          "  /processes - List running background processes (shortcut: /procs)",
          "  /processes stop [id|all] - Stop background processes",
          "  /terminal - Run a command or preset in a new window or background",
          "              Usage: /terminal <command> or /terminal preset <name>",
          "              Background: /terminal bg <command> or /terminal bg preset <name>",
          "              Stop:  /terminal stop [id|all]  - Kill running terminal processes",
          "  /skills   - List all installed agent skills and templates",
          "  /install  - Install a skill from skills.sh (e.g. /install vercel-labs/skills/find-skills)",
          "  /login    - Login to a provider (e.g. /login openrouter sk-or-...)",
          "  /model    - Set or list active AI models (e.g. /model openai/gpt-4o)",
          "  /help     - Show this help",
          "  /quit     - Exit the app",
          "",
          "Shortcuts:",
          "  Ctrl+P    - Show checkpoints interactive wizard dialog",
          "  Ctrl+C    - Abort / Exit",
        ].join("\n"),
        timestamp: now,
      });
      break;
    case "quit":
    case "exit":
      ctx.exit();
      break;
    default:
      ctx.addLine({
        type: "error",
        content: `Unknown command: /${name}`,
        timestamp: now,
      });
  }
}
