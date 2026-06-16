import fs from "fs/promises";
import path from "path";
import { execa } from "execa";
import { registry } from "./registry.js";
import { SlashCommand, getDefaultModel, getProviderLabel } from "./types.js";
import { deleteCheckpointsForSession } from "../checkpoints.js";
import { 
  allTools, 
  superagentInstances, 
  subagentInstances, 
  notifySuperagentsChanged, 
  notifySubagentsChanged, 
  setHistoricalSuperagentTokens 
} from "../tools.js";

// /new command
export const newCommand: SlashCommand = {
  name: "new",
  aliases: ["clear"],
  description: "Start new session (clear history & screen)",
  async execute(args, ctx) {
    const isMulti = ctx.agent?.isMultiAgent || false;
    const sessionFilePath = ctx.agent?.getCurrentHistoryFilePath() || "";
    if (sessionFilePath) {
      deleteCheckpointsForSession(sessionFilePath).catch(() => {});
    }
    ctx.agent?.clearHistory();
    if (ctx.agent) {
      ctx.agent.planState = "IDLE";
      ctx.agent.goalMode = null;
    }

    // Cleanup multi-agent instances and tokens
    for (const inst of superagentInstances.values()) {
      if (inst.status === "running" && inst.agent && typeof inst.agent.abort === "function") {
        try {
          inst.agent.abort();
        } catch {}
      }
    }
    superagentInstances.clear();
    notifySuperagentsChanged();

    for (const inst of subagentInstances.values()) {
      if (inst.status === "running" && inst.agent && typeof inst.agent.abort === "function") {
        try {
          inst.agent.abort();
        } catch {}
      }
    }
    subagentInstances.clear();
    notifySubagentsChanged();

    setHistoricalSuperagentTokens(0);

    ctx.setPlanState?.("IDLE");
    ctx.setGoalMode?.(null);
    ctx.clearLines?.();
    ctx.addLine({ type: "system", content: "New conversation started. History and terminal cleared.", timestamp: Date.now() });
  }
};

// /exit command
export const exitCommand: SlashCommand = {
  name: "exit",
  aliases: ["quit"],
  description: "Exit the app",
  execute(args, ctx) {
    ctx.exit();
  }
};

// /help command
export const helpCommand: SlashCommand = {
  name: "help",
  description: "Show this help",
  execute(args, ctx) {
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
        "  /worktrees - Manage Git worktrees (alias: /worktree)",
        "               Usage: /worktrees [list|prune|remove <path-or-branch>]",
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
        "  /settings - Show current rate limit & concurrency settings",
        "  /setting-concurrency <0|1> - Set LLM concurrency limit",
        "  /setting-rpm <number>      - Set rate limit RPM",
        "  /setting-capacity <number> - Set rate limit capacity",
        "  /help     - Show this help",
        "  /quit     - Exit the app",
        "",
        "Shortcuts:",
        "  Ctrl+P    - Show checkpoints interactive wizard dialog",
        "  Ctrl+C    - Abort / Exit",
      ].join("\n"),
      timestamp: Date.now(),
    });
  }
};

// /init command
export const initCommand: SlashCommand = {
  name: "init",
  description: "Initialize project (Git setup, agents.md generation, system audit)",
  async execute(args, ctx) {
    const cwd = process.cwd();
    const now = Date.now();

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
      ctx.addLine({ type: "system", content: "🔧 Git not detected. Initializing repository...", timestamp: now });
      try {
        await execa("git", ["init"], { cwd });
        gitStatus = "INITIALIZED";
        gitInitialized = true;

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
      let detectedName = path.basename(cwd);
      let detectedDesc = "A software project.";
      let detectedTech = "Unknown";

      try {
        const pkgPath = path.join(cwd, "package.json");
        const pkgContent = await fs.readFile(pkgPath, "utf-8");
        const pkg = JSON.parse(pkgContent);
        if (pkg.name) detectedName = pkg.name;
        if (pkg.description) detectedDesc = pkg.description;

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
    let limit = 256000;
    let configAudit = "";
    try {
      const { getContextWindowLimit, getActiveConfigAudit } = await import("../config.js");
      limit = getContextWindowLimit(modelName);
      configAudit = getActiveConfigAudit();
    } catch {}

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
      configAudit,
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
  }
};

// Register core commands
registry.register(newCommand);
registry.register(exitCommand);
registry.register(helpCommand);
registry.register(initCommand);
