import { registry } from "./registry.js";
import type { SlashCommand } from "./types.js";
import { createBrainSession, inspectBrainSession, listBrainSessions, listBrainFiles, cleanBrainScratch } from "../brain/brainWorkspace.js";

export const brainCommand: SlashCommand = {
  name: "brain",
  aliases: ["scratch"],
  description: "Manage independent session scratch and artifacts under ~/.superagent-r/brain",
  execute(input, ctx) {
    const [action = "help", requested] = input.trim().split(/\s+/);
    const owner = "local-cli";
    const sessionId = requested || ctx.agent?.sessionId || "";
    const say = (content: unknown, error = false) => ctx.addLine({
      type: error ? "error" : "system", content: typeof content === "string" ? content : JSON.stringify(content, null, 2), timestamp: Date.now(),
    });
    try {
      switch (action) {
        case "new": case "create": say(createBrainSession(owner, requested || ctx.agent?.sessionId || undefined)); break;
        case "list": say(listBrainSessions(owner)); break;
        case "show": case "inspect": say(inspectBrainSession(owner, sessionId)); break;
        case "files": say(listBrainFiles(owner, sessionId)); break;
        case "clean": say(cleanBrainScratch(owner, sessionId, sessionId)); break;
        default: say("Usage: /brain create [sessionId] | list | inspect [sessionId] | files [sessionId] | clean <sessionId>\nAlias: /scratch. Scratch cleanup preserves artifacts and evidence."); break;
      }
    } catch (error: any) { say(error?.message || String(error), true); }
  },
};
registry.register(brainCommand);
