import { registry } from "./registry.js";
import type { SlashCommand } from "./types.js";
import {
  createBrainSession, inspectBrainSession, listBrainSessions, listBrainFiles,
  cleanBrainScratch, getBrainScratchPath,
} from "../brain/brainWorkspace.js";
import { cliBridgeTool } from "../tools/cliBridgeTool.js";

export const brainCommand: SlashCommand = {
  name: "brain",
  aliases: ["scratch"],
  description: "Manage per-session scratch, artifacts and detached CLI tasks under ~/.superagent-r/brain",
  async execute(input, ctx) {
    const tokens = input.trim().split(/\s+/).filter(Boolean);
    const action = tokens[0] || "inspect";
    const owner = "local-cli";
    const currentSessionId = ctx.agent?.getSessionId() || "";
    const explicitSessionId = tokens[1] || "";
    const say = (content: unknown, error = false) => ctx.addLine({
      type: error ? "error" : "system",
      content: typeof content === "string" ? content : JSON.stringify(content, null, 2),
      timestamp: Date.now(),
    });
    try {
      switch (action) {
        case "create":
        case "new": {
          say(createBrainSession(owner, explicitSessionId || currentSessionId || undefined));
          break;
        }
        case "list": say(listBrainSessions(owner)); break;
        case "show":
        case "inspect": say(inspectBrainSession(owner, explicitSessionId || currentSessionId)); break;
        case "files": say(listBrainFiles(owner, explicitSessionId || currentSessionId)); break;
        case "clean": {
          if (!explicitSessionId) throw new Error("Usage: /brain clean <sessionId> (explicit confirmation required)");
          say(cleanBrainScratch(owner, explicitSessionId, explicitSessionId));
          break;
        }
        case "delegate":
        case "delegate.start": {
          if (!currentSessionId) throw new Error("Current chat session is unavailable.");
          const cli = tokens[1] || "";
          const prompt = tokens.slice(2).join(" ").trim();
          if (!["agy", "claude", "codex"].includes(cli) || !prompt) {
            throw new Error("Usage: /brain delegate.start <agy|claude|codex> <prompt>");
          }
          if (prompt.length > 15000) throw new Error("Prompt is too long (15000 character maximum).");
          createBrainSession(owner, currentSessionId);
          const cwd = getBrainScratchPath(owner, currentSessionId);
          say(await cliBridgeTool.execute({
            action: "delegate.start", cli, prompt, skillAutoDetect: false,
            injectArtifacts: false, permissionMode: "accept-edits",
          }, cwd));
          break;
        }
        case "jobs":
        case "get":
        case "tail":
        case "cancel": {
          if (!currentSessionId) throw new Error("Current chat session is unavailable.");
          const cwd = getBrainScratchPath(owner, currentSessionId);
          const aliases: Record<string, string> = {
            jobs: "delegate.jobs", get: "delegate.get",
            tail: "delegate.tail", cancel: "delegate.cancel",
          };
          if (action !== "jobs" && !explicitSessionId) throw new Error("Usage: /brain " + action + " <jobId>");
          say(await cliBridgeTool.execute({
            action: aliases[action],
            ...(action !== "jobs" ? { jobId: explicitSessionId } : {}),
          }, cwd));
          break;
        }
        default:
          say("Usage: /brain create [sessionId] | inspect | list | files | clean <sessionId>\n" +
              "/brain delegate.start <agy|claude|codex> <prompt> | jobs | get <jobId> | tail <jobId> | cancel <jobId>\n" +
              "Alias: /scratch. All delegated files remain in the current session scratch until explicitly published.");
      }
    } catch (error: any) { say(error?.message || String(error), true); }
  },
};
registry.register(brainCommand);
