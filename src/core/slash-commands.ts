import { getInstalledSkills } from "./config.js";
import { registry, SlashCommandContext, ChatLine } from "./commands/index.js";

export { ChatLine };
export { 
  formatPresetValue, 
  getPresetLabel, 
  findPreset, 
  getProviderLabel, 
  getDefaultModel 
} from "./commands/types.js";

export function handleSlashCommand(
  cmd: string,
  ctx: SlashCommandContext
) {
  const [name, ...argsArray] = cmd.slice(1).split(" ");
  const args = argsArray.join(" ").trim();
  const now = Date.now();

  let isDirectSkill = false;
  let targetSlug = "";
  if (name.toLowerCase().startsWith("skill-")) {
    isDirectSkill = true;
    targetSlug = name.toLowerCase().slice(6);
  } else if (name.toLowerCase() === "skill" && args) {
    isDirectSkill = true;
    targetSlug = args.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  }

  if (isDirectSkill) {
    const skills = getInstalledSkills();
    const matchedSkill = skills.find(s => {
      const sSlug = s.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
      return sSlug === targetSlug;
    });

    if (matchedSkill) {
      const displayCmd = name.toLowerCase().startsWith("skill-") ? `skill-${targetSlug}` : `skill ${args}`;
      ctx.addLine({
        type: "user",
        content: `❯ /${displayCmd}`,
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
        content: `Skill "${targetSlug}" not found.`,
        timestamp: now,
      });
    }
    return;
  }

  const command = registry.get(name);
  if (command) {
    try {
      const res = command.execute(args, ctx);
      if (res instanceof Promise) {
        return res.catch((err: any) => {
          ctx.addLine({
            type: "error",
            content: `Command execution failed: ${err.message}`,
            timestamp: Date.now(),
          });
        });
      }
    } catch (err: any) {
      ctx.addLine({
        type: "error",
        content: `Command execution failed: ${err.message}`,
        timestamp: Date.now(),
      });
    }
  } else {
    ctx.addLine({
      type: "error",
      content: `Unknown command: /${name}`,
      timestamp: now,
    });
  }
}
