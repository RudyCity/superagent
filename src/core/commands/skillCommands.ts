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
  description: "List all installed agent skills and templates",
  execute(args, ctx) {
    const now = Date.now();
    const isMulti = ctx.agent?.isMultiAgent || false;
    const allSkills = getInstalledSkills();
    const skills = filterSkillsByMode(allSkills, isMulti);
    if (skills.length === 0) {
      ctx.addLine({
        type: "system",
        content: "No skills installed. Use /install <owner/repo> to install skills.",
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
