import { Tool } from "./types.js";
import { synthesizeSkill } from "../skills/skillSynthesizer.js";

export const synthesizeSkillTool: Tool = {
  name: "synthesize_skill",
  description: "Synthesizes a new reusable skill (SKILL.md) from the current workflow, commands, and problem-solving patterns. Saves the skill to .agents/skills/<name>/SKILL.md so it can be reused in future tasks.",
  parameters: {
    type: "object",
    properties: {
      taskDescription: {
        type: "string",
        description: "Clear summary of the task, problem solved, or workflow accomplished."
      },
      skillName: {
        type: "string",
        description: "Optional kebab-case identifier for the skill (e.g. 'sqlite-migration-helper')."
      },
      category: {
        type: "string",
        description: "Optional categorization for the skill (e.g. 'database', 'testing', 'refactor')."
      }
    },
    required: ["taskDescription"]
  },
  execute: async (args: Record<string, unknown>, cwd: string): Promise<string> => {
    const taskDescription = String(args.taskDescription || "").trim();
    if (!taskDescription) {
      return "Error: taskDescription is required.";
    }

    const skillName = args.skillName ? String(args.skillName).trim() : undefined;
    const category = args.category ? String(args.category).trim() : undefined;

    try {
      const result = await synthesizeSkill({
        taskDescription,
        workspace: cwd,
        skillName,
        category
      });

      return [
        `Skill successfully synthesized: ${result.name}`,
        `- Path: ${result.filePath}`,
        `- Description: ${result.description}`,
        `- Category: ${result.category}`,
        `- Key Tools: ${result.extractedPatterns.toolsUsed.join(", ") || "standard tools"}`,
        `The new skill is now active and immediately discoverable by Superagent.`
      ].join("\n");
    } catch (err: any) {
      return `Failed to synthesize skill: ${err.message || String(err)}`;
    }
  }
};
