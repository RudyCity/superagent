import { getInstalledSkills } from "./config.js";
import { registry } from "./commands/index.js";
import type { SlashCommandContext, ChatLine } from "./commands/index.js";
import { runEventHooks } from "./tools/dynamicHooks.js";

export type { ChatLine };
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

  // Run pre_command event hooks in background
  runEventHooks("pre_command", { command: cmd, name, args }).catch(() => {});

  let isDirectSkill = false;
  let targetSlug = "";
  let extraPrompt = "";

  if (name.toLowerCase().startsWith("skill-")) {
    isDirectSkill = true;
    targetSlug = name.toLowerCase().slice(6);
    extraPrompt = args;
  } else if (name.toLowerCase() === "skill" && args) {
    isDirectSkill = true;
    const [firstWord, ...restWords] = args.split(/\s+/);
    targetSlug = firstWord.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
    extraPrompt = restWords.join(" ").trim();
  }

  if (isDirectSkill) {
    const skills = getInstalledSkills();
    const matchedSkill = skills.find(s => {
      const sSlug = s.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
      return sSlug === targetSlug;
    });

    if (matchedSkill) {
      const displayCmd = name.toLowerCase().startsWith("skill-")
        ? `skill-${targetSlug}${extraPrompt ? ` ${extraPrompt}` : ""}`
        : `skill ${targetSlug}${extraPrompt ? ` ${extraPrompt}` : ""}`;

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

      const fullPrompt = [
        `I would like you to use the following skill: "${matchedSkill.name}".`,
        `Please read its instruction file at "${matchedSkill.path}" using a file read tool first, and then help me with my request based on its instructions.`,
        extraPrompt ? `\nUser request: ${extraPrompt}` : ""
      ].filter(Boolean).join("\n");

      const sendPromise = ctx.agent?.sendMessage(fullPrompt);
      if (sendPromise) {
        sendPromise.then(() => {
          runEventHooks("post_command", { command: cmd, name, args }).catch(() => {});
        }).catch((err: any) => {
          ctx.addLine({ type: "error", content: `Skill activation error: ${err.message}`, timestamp: Date.now() });
        });
      } else {
        runEventHooks("post_command", { command: cmd, name, args }).catch(() => {});
      }
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
        return res.then(() => {
          runEventHooks("post_command", { command: cmd, name, args }).catch(() => {});
        }).catch((err: any) => {
          ctx.addLine({
            type: "error",
            content: `Command execution failed: ${err.message}`,
            timestamp: Date.now(),
          });
        });
      } else {
        runEventHooks("post_command", { command: cmd, name, args }).catch(() => {});
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
