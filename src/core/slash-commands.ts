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
    setActiveWizard?: (val: { type: "login" | "model" | "plan_approve" | "permission" | "question" | "resume" | "goal"; step: number; data: Record<string, string> } | null) => void;
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
    case "clear":
      ctx.agent?.clearHistory();
      if (ctx.agent) {
        ctx.agent.planState = "IDLE";
        ctx.agent.goalMode = null;
      }
      ctx.setPlanState?.("IDLE");
      ctx.setGoalMode?.(null);
      ctx.addLine({ type: "system", content: "Conversation cleared.", timestamp: now });
      break;
    case "approve":
      if (ctx.agent) {
        ctx.agent.approvePlan();
        ctx.setPlanState?.("APPROVED");
        ctx.addLine({
          type: "system",
          content: "✓ Implementation plan approved! The agent is now allowed to perform code and file modifications.",
          timestamp: now,
        });
      } else {
        ctx.addLine({ type: "error", content: "Agent not available in this context.", timestamp: now });
      }
      break;
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
        const agentsPath = path.resolve(process.cwd(), "agents.md");
        let fileStatus = "LOADED";
        try {
          await fs.access(agentsPath);
        } catch {
          const defaultContent = `# Project Specifications (agents.md)\n\nThis file contains key information about the project for AI agents to study and align with.\n\n## Project Overview\n- **Name**: superagent\n- **Description**: An interactive CLI coding assistant designed for codebase operations.\n- **Technology Stack**: Node.js, TypeScript, Ink (React), Vercel AI SDK\n\n## Coding Guidelines\n- On Windows, statement separator for terminal commands is \';\' instead of \'&&\'.\n- Always write robust TypeScript code and verify compilation with \'npm run build\'.\n`;
          await fs.writeFile(agentsPath, defaultContent, "utf-8");
          fileStatus = "CREATED";
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

        const auditLines = [
          "┌───[ ⚙️ SYSTEM AUDIT & AGENT INITIALIZATION ]",
          "│ ",
          "│ [HOST INFO]",
          `│ 🖥️ OS Platform   : ${process.platform}`,
          `│ 📦 Node Version   : ${process.version}`,
          `│ 📂 Workspace      : ${process.cwd()}`,
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
        "│  ├─ explorer   : codebase structure, references, APIs, or resources exploration",
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
    case "tasks": {
      const taskList = Array.from(backgroundTasks.entries());
      const lines = [
        "┌───[ ⚙️ RUNNING BACKGROUND TASKS ]",
        "│ ",
      ];
      if (taskList.length === 0) {
        lines.push("│  No active background tasks.");
      } else {
        for (const [id, task] of taskList) {
          lines.push(`│  • ID: ${id} | Command: ${task.command}`);
        }
      }
      lines.push("└──────────────────────────────────────────────");
      ctx.addLine({
        type: "system",
        content: lines.join("\n"),
        timestamp: now,
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
          "  /clear    - Clear conversation history",
          "  /compact  - Show conversation summary",
          "  /goal     - Activate Goal Mode for long-running overnight tasks",
          "              Usage: /goal <description>  (e.g. /goal implement JWT auth end-to-end)",
          "  /init     - Initialize/audit AI agents and system configuration",
          "  /agents   - List active subagents and defined subagent types",
          "  /tasks    - List running background tasks",
          "  /skills   - List all installed agent skills and templates",
          "  /install  - Install a skill from skills.sh (e.g. /install vercel-labs/skills/find-skills)",
          "  /login    - Login to a provider (e.g. /login openrouter sk-or-...)",
          "  /model    - Set or list active AI models (e.g. /model openai/gpt-4o)",
          "  /approve  - Approve the pending implementation plan",
          "  /help     - Show this help",
          "  /quit     - Exit the app",
          "",
          "Shortcuts:",
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
