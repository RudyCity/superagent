import fs from "fs/promises";
import path from "path";
import { execa } from "execa";
import { registry } from "./registry.js";
import { getDefaultModel } from "./types.js";
import { deleteCheckpointsForSession } from "../checkpoints.js";
import { getGlobalConfigDir, ensureGlobalConfigDir, getEffectiveMasterModel } from "../config.js";
import { allTools, superagentInstances, subagentInstances, notifySuperagentsChanged, notifySubagentsChanged, setHistoricalSuperagentTokens, clearActiveToolOutput, scheduledJobs, } from "../tools.js";
// /new command
export const newCommand = {
    name: "new",
    aliases: ["clear"],
    description: "Start new session (clear history & screen)",
    async execute(args, ctx) {
        const isMulti = ctx.agent?.isMultiAgent || false;
        const sessionFilePath = ctx.agent?.getCurrentHistoryFilePath() || "";
        if (sessionFilePath) {
            deleteCheckpointsForSession(sessionFilePath).catch(() => { });
            // Also clean up the task history file so it doesn't orphan
            const taskHistoryPath = sessionFilePath.replace(/\.json$/, "_task_history.md");
            fs.unlink(taskHistoryPath).catch(() => { });
            // Clean up global knowledge entries from this session
            import("../pinnedKnowledge.js").then(({ removeSessionFromKnowledge }) => {
                removeSessionFromKnowledge(sessionFilePath);
            }).catch(() => { });
        }
        // ── 1. Keep running background tasks ──────────────────
        // ── 2. Clear active tool output buffer ────────────────
        clearActiveToolOutput();
        // ── 3. Clear scheduled jobs ───────────────────────────
        scheduledJobs.clear();
        // ── 4. Clear conversation history & agent state ───────
        if (ctx.agent) {
            ctx.agent.resetInternalState();
            await ctx.agent.clearHistory();
            ctx.agent.planState = "IDLE";
            ctx.agent.goalMode = null;
        }
        // ── 5. Cleanup multi-agent instances and tokens ───────
        for (const inst of superagentInstances.values()) {
            if (inst.status === "running" && inst.agent && typeof inst.agent.abort === "function") {
                try {
                    inst.agent.abort();
                }
                catch { }
            }
        }
        superagentInstances.clear();
        notifySuperagentsChanged();
        for (const inst of subagentInstances.values()) {
            if (inst.status === "running" && inst.agent && typeof inst.agent.abort === "function") {
                try {
                    inst.agent.abort();
                }
                catch { }
            }
        }
        subagentInstances.clear();
        notifySubagentsChanged();
        setHistoricalSuperagentTokens(0);
        // ── 6. Clear session environment variable ─────────────
        delete process.env.SUPERAGENT_SESSION_PATH;
        // ── 7. Write session separator to persistent log ───────
        try {
            ensureGlobalConfigDir();
            const logPath = path.join(getGlobalConfigDir(), "superagent.log");
            const separator = `\n${"═".repeat(72)}\n[NEW SESSION] ${new Date().toISOString()} — History, logs, and state cleared.\n${"═".repeat(72)}\n`;
            await fs.appendFile(logPath, separator, "utf-8");
        }
        catch { }
        // ── 8. Reset UI state ─────────────────────────────────
        ctx.setPlanState?.("IDLE");
        ctx.setGoalMode?.(null);
        ctx.clearLines?.();
        // ── 9. Clear arrow-key input history ──────────────────
        ctx.setInputHistory?.([]);
        try {
            const inputHistoryPath = path.join(getGlobalConfigDir(), "input-history.json");
            await fs.writeFile(inputHistoryPath, "[]", "utf-8");
        }
        catch { /* non-fatal */ }
        ctx.addLine({ type: "system", content: "✓ New conversation started. History, logs, and state cleared.", timestamp: Date.now() });
    }
};
// /exit command
export const exitCommand = {
    name: "exit",
    aliases: ["quit"],
    description: "Exit the app",
    execute(args, ctx) {
        ctx.exit();
    }
};
// /help command
export const helpCommand = {
    name: "help",
    description: "Show this help",
    execute(args, ctx) {
        ctx.addLine({
            type: "system",
            content: [
                "Commands:",
                "  /new      - Start new session (clear history & screen)",
                "  /resume   - Resume a conversation session from history via wizard dialog",
                "  /search-history - Search conversation history (shortcut: /sh)",
                "                    Usage: /search-history <query> [--all] [--debug]",
                "                    --all: search across ALL sessions/projects",
                "                    --debug: show live AI matching step-by-step logs",
                "  /knowledge - Browse & search global pinned knowledge (shortcut: /k)",
                "               Usage: /knowledge [query|projects|list]",
                "               Pins from all sessions are stored in a global store",
                "               AI agents can access via search_pinned_knowledge & load_pinned_session tools",
                "  /clear    - Clear conversation history",
                "  /compact          - Show conversation summary and ContextManager status",
                "  /compact now      - Force compaction (skip threshold check)",
                "  /compaction-history - View compaction audit trail (shortcut: /ch)",
                "  /pin      - Pin important messages (full content + agent tag stored)",
                "              Usage: /pin [index|last|unpin <idx>|list|list-messages|view <idx>|tag <idx> <label>]",
                "              Note: Use /pin list-messages to see correct indexes",
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
                "              Visible: /terminal <command> or /terminal preset <name>",
                "              Background: /terminal bg <command> or /terminal bg preset <name>",
                "              All presets: /terminal all  - Launch ALL presets at once",
                "              Init wizard: /terminal init - AI-guided preset setup",
                "              List presets: /terminal preset (no name) or /terminal (no args)",
                "              Stop: /terminal stop [id|all]  - Kill running terminal processes",
                "              Shortcut: !<command> (e.g. !npm run dev)",
                "  /skills   - List all installed agent skills and templates",
                "  /install  - Install a skill from skills.sh (e.g. /install vercel-labs/skills/find-skills)",
                "  /image paste      - Attach an image from the system clipboard",
                "  /image attach <p> - Attach an image from the specified file path",
                "  /ih       - Manage custom internal hook tools (alias: /internal-hooks)",
                "              /ih init <name>  - Scaffold a new hook project",
                "              /ih dev <name>   - Run the hook's dev script with test-payload.json input",
                "              /ih list         - List all discovered internal hooks and their status",
                "              /ih active       - Select which hooks to activate via checkbox dialog",
                "  /login    - Login to a provider (e.g. /login openrouter sk-or-...)",
                "  /model    - Set or list active AI models (e.g. /model openai/gpt-4o)",
                "  /settings - Show current rate limit & concurrency settings",
                "  /setting-concurrency <0|1> - Set LLM concurrency limit",
                "  /setting-rpm <number>      - Set rate limit RPM",
                "  /setting-capacity <number> - Set rate limit capacity",
                "  /setting-streaming <on|off> - Enable or disable streaming",
                "  /setting-context-limit <number> - Set context window limit (0 = auto)",
                "  /setting-max-iterations <number> - Set max agent iterations",
                "  /setting-tencentdb <on|off|status|show-bg-procs|hide-bg-procs> [gatewayUrl] - Configure TencentDB Memory Gateway",
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
export const initCommand = {
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
        }
        catch { }
        if (gitStatus !== "ACTIVE") {
            ctx.addLine({ type: "system", content: "🔧 Git not detected. Initializing repository...", timestamp: now });
            try {
                await execa("git", ["init"], { cwd });
                gitStatus = "INITIALIZED";
                gitInitialized = true;
                const gitignorePath = path.join(cwd, ".gitignore");
                try {
                    await fs.access(gitignorePath);
                }
                catch {
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
            }
            catch (gitErr) {
                ctx.addLine({ type: "error", content: `Git init failed: ${gitErr.message}`, timestamp: Date.now() });
                gitStatus = "FAILED";
            }
        }
        if (gitStatus === "ACTIVE" || gitStatus === "INITIALIZED") {
            try {
                const { stdout: branch } = await execa("git", ["branch", "--show-current"], { cwd, reject: false });
                gitBranch = branch?.trim() || "(detached)";
            }
            catch { }
            try {
                const { stdout: sha } = await execa("git", ["rev-parse", "--short", "HEAD"], { cwd, reject: false });
                gitSha = sha?.trim() || (gitInitialized ? "(no commits yet)" : "unknown");
            }
            catch {
                gitSha = gitInitialized ? "(no commits yet)" : "unknown";
            }
        }
        // ── agents.md Setup ────────────────────────────
        const agentsPath = path.resolve(cwd, "agents.md");
        let fileStatus = "LOADED";
        try {
            await fs.access(agentsPath);
        }
        catch {
            let detectedName = path.basename(cwd);
            let detectedDesc = "A software project.";
            let detectedTech = "Unknown";
            try {
                const pkgPath = path.join(cwd, "package.json");
                const pkgContent = await fs.readFile(pkgPath, "utf-8");
                const pkg = JSON.parse(pkgContent);
                if (pkg.name)
                    detectedName = pkg.name;
                if (pkg.description)
                    detectedDesc = pkg.description;
                const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
                const techs = [];
                if (allDeps["typescript"])
                    techs.push("TypeScript");
                else
                    techs.push("JavaScript");
                if (allDeps["react"] || allDeps["react-dom"])
                    techs.push("React");
                if (allDeps["next"])
                    techs.push("Next.js");
                if (allDeps["vue"])
                    techs.push("Vue");
                if (allDeps["svelte"])
                    techs.push("Svelte");
                if (allDeps["express"])
                    techs.push("Express");
                if (allDeps["fastify"])
                    techs.push("Fastify");
                if (allDeps["ink"])
                    techs.push("Ink (CLI)");
                if (allDeps["electron"])
                    techs.push("Electron");
                if (allDeps["vite"])
                    techs.push("Vite");
                if (allDeps["tailwindcss"])
                    techs.push("Tailwind CSS");
                if (allDeps["prisma"] || allDeps["@prisma/client"])
                    techs.push("Prisma");
                if (allDeps["mongoose"])
                    techs.push("MongoDB/Mongoose");
                if (techs.length > 0)
                    detectedTech = techs.join(", ");
            }
            catch {
                try {
                    await fs.access(path.join(cwd, "requirements.txt"));
                    detectedTech = "Python";
                }
                catch { }
                try {
                    await fs.access(path.join(cwd, "Cargo.toml"));
                    detectedTech = "Rust";
                }
                catch { }
                try {
                    await fs.access(path.join(cwd, "go.mod"));
                    detectedTech = "Go";
                }
                catch { }
                try {
                    await fs.access(path.join(cwd, "pom.xml"));
                    detectedTech = "Java (Maven)";
                }
                catch { }
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
            if (nameMatch)
                projectName = nameMatch[1].trim();
            const techMatch = content.match(/-\s*\*\*Technology Stack\*\*:\s*(.*)/i);
            if (techMatch)
                projectTech = techMatch[1].trim();
        }
        catch (err) {
            ctx.addLine({ type: "error", content: `Failed to read agents.md: ${err.message}`, timestamp: now });
            return;
        }
        const modelName = getEffectiveMasterModel("auto") || getDefaultModel();
        let limit = 256000;
        let configAudit = "";
        let streamingLabel = "ENABLED";
        try {
            const { getContextWindowLimit, getActiveConfigAudit, getSettings } = await import("../config.js");
            limit = getContextWindowLimit(modelName);
            configAudit = getActiveConfigAudit();
            const settings = getSettings();
            if (settings.contextWindowLimit > 0)
                limit = settings.contextWindowLimit;
            streamingLabel = settings.disableStreaming ? "DISABLED" : "ENABLED";
        }
        catch { }
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
            `│ ✦ Streaming       : ${streamingLabel}`,
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
// /image command
export const imageCommand = {
    name: "image",
    description: "Manage prompt image attachments (e.g. /image paste, /image attach <path>)",
    async execute(args, ctx) {
        const trimmed = args.trim();
        if (!trimmed) {
            ctx.addLine({
                type: "system",
                content: [
                    "Usage:",
                    "  /image paste        - Attach an image from the system clipboard",
                    "  /image attach <path> - Attach an image from the specified file path",
                ].join("\n"),
                timestamp: Date.now(),
            });
            return;
        }
        const parts = trimmed.split(/\s+/);
        const subCommand = parts[0].toLowerCase();
        const arg = parts.slice(1).join(" ").trim();
        if (subCommand === "paste") {
            if (!ctx.pasteImage) {
                ctx.addLine({ type: "error", content: "Error: pasteImage is not available in this context.", timestamp: Date.now() });
                return;
            }
            await ctx.pasteImage();
        }
        else if (subCommand === "attach") {
            if (!arg) {
                ctx.addLine({ type: "error", content: "Error: Please specify the image file path. Usage: /image attach <path>", timestamp: Date.now() });
                return;
            }
            if (!ctx.attachImage) {
                ctx.addLine({ type: "error", content: "Error: attachImage is not available in this context.", timestamp: Date.now() });
                return;
            }
            await ctx.attachImage(arg);
        }
        else {
            ctx.addLine({
                type: "error",
                content: `Unknown subcommand: ${subCommand}. Available subcommands: paste, attach`,
                timestamp: Date.now(),
            });
        }
    }
};
// Register core commands
registry.register(newCommand);
registry.register(exitCommand);
registry.register(helpCommand);
registry.register(initCommand);
registry.register(imageCommand);
//# sourceMappingURL=coreCommands.js.map