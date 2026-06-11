import fs from "fs/promises";
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
  getContextWindowLimit 
} from "./config.js";
import {
  createCheckpoint,
  listCheckpointsForSession,
  deleteCheckpointsForSession,
  restoreCheckpoint,
  restoreCheckpointById,
  terminateActiveTasksAndSubagents,
} from "./checkpoints.js";
import { searchHistory } from "./historySearch.js";
import { getToolDescription } from "./permissions.js";
import { allTools, backgroundTasks, subagentInstances } from "./tools.js";
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
    setActiveWizard?: (val: { type: "login" | "model" | "plan_approve" | "permission" | "question" | "resume" | "goal" | "checkpoint"; step: number; data: Record<string, string> } | null) => void;
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
      const sessions = listHistorySessions();
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
      searchHistory(query)
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
              ctx.addLine({
                type: "system",
                content: `ℹ Note: Workspace files were at Git commit: ${checkpoint.gitSha}\n  To sync workspace codebase files, run: git checkout ${checkpoint.gitSha}`,
                timestamp: Date.now()
              });
            }
          })
          .catch((err) => {
            ctx.addLine({ type: "error", content: `Failed to restore checkpoint: ${err.message}`, timestamp: Date.now() });
          });
      } else {
        // Create a checkpoint
        const checkpointName = args || `Manual: Checkpoint at ${new Date(now).toLocaleTimeString()}`;
        ctx.addLine({ type: "system", content: `Creating checkpoint "${checkpointName}"...`, timestamp: now });
        createCheckpoint(sessionFilePath, checkpointName, messages, planState)
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
    case "processes":
    case "procs": {
      const taskList = Array.from(backgroundTasks.entries());
      const lines = [
        "┌───[ ⚙️ RUNNING BACKGROUND PROCESSES ]",
        "│ ",
      ];
      if (taskList.length === 0) {
        lines.push("│  No active background processes.");
      } else {
        for (const [id, task] of taskList) {
          lines.push(`│  • ID: ${id} | Command: ${task.command}`);
        }
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
      const lines = [
        "┌───[ 📂 INSTALLED AGENT SKILLS ]",
        "│ ",
      ];
      if (skills.length === 0) {
        lines.push("│  No skills installed. Use /install <owner/repo> to install skills.");
      } else {
        for (const s of skills) {
          lines.push(`│  • Name        : ${s.name}`);
          lines.push(`│    Description : ${s.description}`);
          lines.push(`│    Path        : ${s.path}`);
          lines.push("│ ");
        }
        lines.pop();
      }
      lines.push("└──────────────────────────────────────────────");
      ctx.addLine({
        type: "system",
        content: lines.join("\n"),
        timestamp: now,
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
          "  /processes - List running background processes (shortcut: /procs)",
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
