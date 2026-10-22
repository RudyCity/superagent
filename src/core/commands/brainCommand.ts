import { registry } from "./registry.js";
import crypto from "node:crypto";
import type { SlashCommand } from "./types.js";
import {
  createBrainSession, inspectBrainSession, listBrainSessions, listBrainFiles,
  getBrainScratchPath,
} from "../brain/brainWorkspace.js";
import { cliBridgeTool } from "../tools/cliBridgeTool.js";
import { brainStorageUsage, previewBrainRetention, prepareBrainCleanup, confirmBrainCleanup } from "../brain/brainStorageManager.js";
import { annotateBrainArtifact, searchBrainArtifacts, brainResumeContext, brainRMemoryCandidate } from "../brain/brainIndex.js";
import { promoteBrainDelegation } from "../brain/brainDelegationArtifacts.js";
import { verifyBrainProject } from "../brain/brainProvenance.js";

export const brainCommand: SlashCommand = {
  name: "brain",
  aliases: ["scratch"],
  description: "Manage per-session scratch, artifacts and detached CLI tasks under ~/.superagent-r/brain",
  async execute(input, ctx) {
    const tokens = input.trim().split(/\s+/).filter(Boolean);
    const action = tokens[0] || "inspect";
    const owner = "local-cli";
    const ownerToken = "Bearer " + crypto.createHash("sha256").update("brain-cli:" + owner).digest("hex");
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
        case "resume": say(brainResumeContext(owner, explicitSessionId || currentSessionId)); break;
        case "search": say(searchBrainArtifacts(owner, tokens.slice(1).join(" "))); break;
        case "annotate": {
          const file = tokens[1] || "";
          const summary = tokens.slice(2).join(" ");
          if (!currentSessionId || !file || !summary) throw new Error("Usage: /brain annotate <artifacts/file> <summary> (current session)");
          say(annotateBrainArtifact(owner, currentSessionId, file, summary));
          break;
        }
        case "promote": {
          if (!currentSessionId || !tokens[1]) throw new Error("Usage: /brain promote <delegateJobId> [outputFilename]");
          say(await promoteBrainDelegation(owner, currentSessionId, tokens[1], tokens[2]));
          break;
        }
        case "remember": {
          if (!currentSessionId || !tokens[1]) throw new Error("Usage: /brain remember <artifacts/file> (current session, explicit RMemory write)");
          const candidate = brainRMemoryCandidate(owner, currentSessionId, tokens[1]);
          const project = verifyBrainProject(owner, currentSessionId, ctx.agent?.workingDirectory || process.cwd());
          const { rmemorySaveTool } = await import("../tools/rmemoryTools.js");
          const result = await rmemorySaveTool.execute({
            id: candidate.assertionKey,
            content: candidate.content,
            type: "task-summary",
            scope: "project",
            assertionKey: candidate.assertionKey,
            retentionClass: candidate.retentionClass,
          }, project.canonicalRoot);
          say(result);
          break;
        }
        case "storage": {
          const id = explicitSessionId || currentSessionId;
          say({ sessionId: id, ...brainStorageUsage(inspectBrainSession(owner, id).path) });
          break;
        }
        case "retention": {
          say(previewBrainRetention(owner, explicitSessionId ? Number(explicitSessionId) : 30));
          break;
        }
        case "clean": {
          const id = explicitSessionId || currentSessionId;
          if (!id) throw new Error("Usage: /brain clean <sessionId>");
          const preview = prepareBrainCleanup(ownerToken, id, inspectBrainSession(owner, id).path);
          say({ ...preview, instruction: "/brain clean.confirm " + id + " " + preview.challenge });
          break;
        }
        case "clean.confirm": {
          const id = explicitSessionId;
          const challenge = tokens[2] || "";
          if (!id || !challenge) throw new Error("Usage: /brain clean.confirm <sessionId> <challenge>");
          say(confirmBrainCleanup(ownerToken, id, challenge, inspectBrainSession(owner, id).path));
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
          say("Usage: /brain create [sessionId] | inspect | list | files | resume [sessionId] | search <query> | annotate <artifacts/file> <summary> | promote <jobId> [filename] | remember <artifacts/file> | storage [sessionId] | retention [7|30|90] | clean <sessionId> | clean.confirm <sessionId> <challenge>\n" +
              "/brain delegate.start <agy|claude|codex> <prompt> | jobs | get <jobId> | tail <jobId> | cancel <jobId>\n" +
              "Alias: /scratch. All delegated files remain in the current session scratch until explicitly published.");
      }
    } catch (error: any) { say(error?.message || String(error), true); }
  },
};
registry.register(brainCommand);
