import { execa } from "execa";
import { registry } from "./registry.js";
import { SlashCommand } from "./types.js";
import { getInstalledSkills, filterSkillsByMode } from "../config.js";

// /install command
export const installCommand: SlashCommand = {
  name: "install",
  description: "Install a skill from skills.sh (e.g. /install vercel-labs/skills/find-skills)",
  async execute(args, ctx) {
    const now = Date.now();
    if (!args) {
      ctx.addLine({
        type: "error",
        content: "Usage: /install <owner/repo> (e.g. /install vercel-labs/skills/find-skills)",
        timestamp: now,
      });
      return;
    }
    if (ctx.agent) {
      ctx.addLine({
        type: "user",
        content: `❯ /install ${args}`,
        timestamp: now,
      });
      ctx.addLine({
        type: "system",
        content: `Delegating skill installation for "${args}" to the AI agent...`,
        timestamp: now,
      });
      ctx.setIsProcessing?.(true);
      try {
        await ctx.agent.sendMessage(
          `I would like you to install the skill: "${args}". Please execute the command "npx skills add ${args}" using your terminal execution tools. If there are any interactive prompts or registration required, handle them automatically. Once complete, verify the installation and let me know.`
        );
      } catch (err: any) {
        ctx.addLine({
          type: "error",
          content: `Failed to delegate install command: ${err.message}`,
          timestamp: Date.now(),
        });
        ctx.setIsProcessing?.(false);
      }
    } else {
      ctx.addLine({
        type: "system",
        content: `Installing skill "${args}" via skills.sh...`,
        timestamp: now,
      });

      try {
        const isWin = process.platform === "win32";
        const shell = isWin ? "powershell.exe" : true;
        const parsedArgs = args.split(/\s+/).filter(Boolean);
        if (!parsedArgs.includes("-y") && !parsedArgs.includes("--yes")) {
          parsedArgs.push("-y");
        }
        const result = await execa("bunx", ["skills", "add", ...parsedArgs], {
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
    }
  }
};

// /skills command
export const skillsCommand: SlashCommand = {
  name: "skills",
  aliases: ["skill"],
  description: "List all installed agent skills, track stats, or synthesize new skills",
  async execute(args, ctx) {
    const now = Date.now();
    const parts = args.trim().split(/\s+/).filter(Boolean);
    const sub = parts[0]?.toLowerCase();

    if (sub === "stats" || sub === "metrics") {
      const { getSkillStats } = await import("../skills/skillTracker.js");
      const workspace = ctx.agent?.workingDirectory || process.cwd();
      const stats = getSkillStats(workspace);

      const installedCount = stats.filter(s => s.type === "installed").length;
      const synthCount = stats.filter(s => s.type === "synthesized").length;
      const totalExecutions = stats.reduce((acc, s) => acc + s.executionCount, 0);

      const lines = [
        "Agent Skill Statistics & Tracking:",
        `- Installed Skills    : ${installedCount}`,
        `- Synthesized Skills  : ${synthCount}`,
        `- Total Skill Usages  : ${totalExecutions}`,
        "",
        "Top Active / Synthesized Skills:",
      ];

      const topSkills = stats.slice(0, 25);
      for (const s of topSkills) {
        const typeTag = s.type === "synthesized" ? "[SYNTH]" : "[BUILTIN]";
        const lastUsedStr = s.lastUsed ? new Date(s.lastUsed).toLocaleDateString() : "Never";
        lines.push(
          `- ${typeTag} ${s.name.padEnd(30)} (used: ${s.executionCount}x | last: ${lastUsedStr})`
        );
      }

      ctx.addLine({ type: "system", content: lines.join("\n"), timestamp: now });
      return;
    }

    if (sub === "synth" || sub === "synthesize") {
      const { synthesizeSkill } = await import("../skills/skillSynthesizer.js");
      const workspace = ctx.agent?.workingDirectory || process.cwd();

      let taskDescription = parts.slice(1).join(" ").trim();
      let trajectory: any[] = [];

      if (taskDescription === "current" || !taskDescription) {
        // Extract trajectory from active conversation
        const messages = ctx.agent?.getHistory?.()?.getMessages?.() || [];
        trajectory = messages.map((m: any) => ({
          role: m.role,
          content: typeof m.content === "string" ? m.content : "",
          toolName: m.toolName,
          toolArgs: m.toolArgs,
          toolResult: m.toolResult,
          error: m.error,
        }));
        const firstUserMsg = messages.find((m: any) => m.role === "user");
        const userPrompt = typeof firstUserMsg?.content === "string" ? firstUserMsg.content : "Current conversation workflow";
        taskDescription = taskDescription === "current" ? userPrompt : taskDescription;
      }

      if (!taskDescription) {
        ctx.addLine({
          type: "error",
          content: "Usage: /skills synth <task_description>\nOr: /skills synth current (to synthesize from active session)",
          timestamp: now,
        });
        return;
      }

      ctx.addLine({
        type: "system",
        content: `Synthesizing new reusable skill for: "${taskDescription.slice(0, 80)}"...`,
        timestamp: now,
      });

      try {
        const skill = await synthesizeSkill({
          taskDescription,
          workspace,
          conversationTrajectory: trajectory.length > 0 ? trajectory : undefined,
        });

        ctx.addLine({
          type: "system",
          content: [
            `Skill synthesized successfully: ${skill.name}`,
            `- File Path   : ${skill.filePath}`,
            `- Description : ${skill.description}`,
            `- Category    : ${skill.category}`,
            "The skill is saved in .agents/skills/ and immediately available to Superagent.",
          ].join("\n"),
          timestamp: Date.now(),
        });
      } catch (err: any) {
        ctx.addLine({
          type: "error",
          content: `Failed to synthesize skill: ${err.message}`,
          timestamp: Date.now(),
        });
      }
      return;
    }

    const isMulti = ctx.agent?.isMultiAgent || false;
    const allSkills = getInstalledSkills();
    const skills = filterSkillsByMode(allSkills, isMulti);
    if (skills.length === 0) {
      ctx.addLine({
        type: "system",
        content: "No skills installed. Use /install <owner/repo> or /skills synth <description> to create skills.",
        timestamp: now,
      });
      return;
    }
    const options = skills.map(s => {
      const provider = s.author || "local";
      const groupTag = isMulti && s.mode === "multi" ? "[Multi-Agent] " : "";
      return `• ${groupTag}${provider}/${s.name} - ${s.description.slice(0, 50)}${s.description.length > 50 ? "..." : ""}`;
    });
    ctx.setActiveWizard?.({
      type: "skills",
      step: 1,
      data: {},
    });
    ctx.setWizardOptions?.(options);
    ctx.setWizardSelectedIndex?.(0);
  }
};

// Register skill commands
registry.register(installCommand);
registry.register(skillsCommand);
