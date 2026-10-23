import { registry } from "./registry.js";
import { BRAIN_SUGGESTIONS } from "./commandCatalog.js";
import crypto from "node:crypto";
import type { SlashCommand } from "./types.js";
import {
  createBrainSession, inspectBrainSession, listBrainSessions, listBrainFiles,
  getBrainScratchPath,
} from "../brain/brainWorkspace.js";
import { cliBridgeTool } from "../tools/cliBridgeTool.js";
import { summarizeBrainEvents } from "../brain/brainObservability.js";
import { getRootConfigDir } from "../config/paths.js";
import { brainStorageUsage, previewBrainRetention, prepareBrainCleanup, confirmBrainCleanup } from "../brain/brainStorageManager.js";
import { annotateBrainArtifact, searchBrainArtifacts, brainResumeContext, brainRMemoryCandidate } from "../brain/brainIndex.js";
import { promoteBrainDelegation } from "../brain/brainDelegationArtifacts.js";
import { recoverBrainArtifactPromotion } from "../brain/brainArtifactTransaction.js";
import { reconcileBrainSessionJobs } from "../brain/brainTaskRecovery.js";
import { verifyBrainProject } from "../brain/brainProvenance.js";
import { createBrainTask, listBrainTasks, claimBrainTask, checkpointBrainTask, transferBrainTask, updateBrainTask, resumeBrainTask, recordBrainTaskDelegation, reserveBrainTaskLaunch, finishBrainTaskLaunch } from "../brain/brainTasks.js";

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
        case "metrics": say(summarizeBrainEvents(owner, getRootConfigDir())); break;
        case "show":
        case "inspect": say(inspectBrainSession(owner, explicitSessionId || currentSessionId)); break;
        case "files": say(listBrainFiles(owner, explicitSessionId || currentSessionId)); break;
        case "task.list": say(listBrainTasks(owner, currentSessionId)); break;
        case "task.reconcile": {
          if(!currentSessionId)throw new Error("No active Brain session.");
          say(await reconcileBrainSessionJobs(owner,currentSessionId));
          break;
        }
        case "artifact.recover": {
          if(!currentSessionId)throw new Error("No active Brain session.");
          say(recoverBrainArtifactPromotion(owner,currentSessionId));
          break;
        }
        case "task.create": {
          if (!currentSessionId) throw new Error("No current Brain session.");
          const title = tokens.slice(1).join(" ");
          say(createBrainTask(owner, currentSessionId, title, ["main", "agy", "claude"]));
          break;
        }
        case "task.claim": {
          say(claimBrainTask(owner, currentSessionId, tokens[1] || "", tokens[2] || "main"));
          break;
        }
        case "task.resume": {
          say(resumeBrainTask(owner, currentSessionId, tokens[1] || ""));
          break;
        }
        case "task.checkpoint": {
          const taskId=tokens[1] || "", agent=tokens[2] || "main", note=tokens.slice(3).join(" ");
          say(checkpointBrainTask(owner, currentSessionId, taskId, agent, note, "", []));
          break;
        }
        case "task.transfer": {
          say(transferBrainTask(owner, currentSessionId, tokens[1] || "", tokens[2] || "", tokens[3] || ""));
          break;
        }
        case "task.complete": {
          say(updateBrainTask(owner, currentSessionId, tokens[1] || "", tokens[2] || "main", "completed"));
          break;
        }
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
          // A delegated CLI begins a resumable owner-scoped Brain task automatically.
          // Its scratch is independent of the Git repository and other agents.
          const task = createBrainTask(owner, currentSessionId, prompt.slice(0, 120), ["main", cli]);
          const claimed = claimBrainTask(owner, currentSessionId, task.taskId, cli);
          const cwd = claimed.scratchPath;
          const launch = reserveBrainTaskLaunch(owner,currentSessionId,task.taskId,cli);
          const delegated = await cliBridgeTool.execute({
            action: "delegate.start", cli, prompt, skillAutoDetect: false,
            injectArtifacts: false, permissionMode: "accept-edits",
          }, cwd);
          const jobMatch=String(delegated).match(/clj_\d+_[a-f0-9]{8,32}/);
          if(!jobMatch)throw new Error("CLI Bridge acknowledgement missing; reservation retained for review.");
          recordBrainTaskDelegation(owner,currentSessionId,task.taskId,cli,cli,jobMatch[0]);
          finishBrainTaskLaunch(owner,currentSessionId,task.taskId,cli,launch,jobMatch[0]);
          say({ taskId: task.taskId, scratchPath: cwd, delegate: delegated });
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
        case "help":
        case "--help":
        case "-h":
        default:
          say([
            "Brain session commands (alias: /scratch):",
            ...BRAIN_SUGGESTIONS.map(option => "  " + option),
            "",
            "Arguments: create [sessionId]; inspect/files/storage/resume [sessionId]; search <query>;",
            "  annotate <artifacts/file> <summary>; promote <jobId> [outputFilename];",
            "  remember <artifacts/file>; retention [7|30|90]; clean <sessionId>;",
            "  clean.confirm <sessionId> <challenge>;",
            "  task.create <title>; task.claim <taskId> [agentId]; task.resume <taskId>;",
            "  task.checkpoint <taskId> <agentId> <note>; task.transfer <taskId> <from> <to>;",
            "  task.complete <taskId> [agentId]; delegate.start <agy|claude|codex> <prompt>;",
            "  get/tail/cancel <jobId>.",
            "",
            "task.reconcile checks persisted job status; artifact.recover replays the journal safely.",
            "MCP-only: task.credential.rotate/revoke/status, delegate.promote.batch, task.reconcile.all.",
            "Desktop: use the T-Line Brain Explorer to manage credentials and task artifacts.",
            "Cleanup requires an explicit confirmation. Artifacts stay in Brain until published.",
          ].join("\n"));
      }
    } catch (error: any) { say(error?.message || String(error), true); }
  },
};
registry.register(brainCommand);
