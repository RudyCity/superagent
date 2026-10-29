/**
 * MCP adapter for the canonical SuperAgent Brain storage operations.
 *
 * Independent of the active Git workspace; all reads/writes are scoped to
 * the authenticated MCP principal's own Brain namespace.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { McpToolResult } from "../types.js";
import {
  createBrainSession, inspectBrainSession, listBrainSessions, listBrainFiles,
  readBrainFile, writeBrainFile, getBrainScratchPath,
} from "../../brain/brainWorkspace.js";
import {
  brainStorageUsage, previewBrainRetention, prepareBrainCleanup, confirmBrainCleanup,
  importBrainBinaryArtifact, prepareBrainPublish, confirmBrainPublish,
  validateDestination, assertNoSymlink,
} from "../../brain/brainStorageManager.js";
import { getRootConfigDir } from "../../config/paths.js";
import { cliBridgeTool } from "../../tools/cliBridgeTool.js";
import { MAX_DELEGATE_TIMEOUT_MS, MIN_DELEGATE_TIMEOUT_MS } from "../../tools/cliBridgeTimeouts.js";
import { beginBrainTransfer, inspectBrainTransfer, appendBrainTransfer, finishBrainTransfer, abortBrainTransfer, cleanupBrainTransfers } from "../../brain/brainTransfers.js";
import { annotateBrainArtifact, searchBrainArtifacts, brainResumeContext, brainRMemoryCandidate } from "../../brain/brainIndex.js";
import { promoteBrainDelegation, promoteBrainDelegationBatch } from "../../brain/brainDelegationArtifacts.js";
import { recoverBrainArtifactPromotion } from "../../brain/brainArtifactTransaction.js";
import { recordBrainEvent, summarizeBrainEvents } from "../../brain/brainObservability.js";
import { createBrainTask, listBrainTasks, inspectBrainTask, claimBrainTask, transferBrainTask, updateBrainTask, checkpointBrainTask, handoffBrainArtifact, resumeBrainTask, recordBrainTaskDelegation, reserveBrainTaskLaunch, finishBrainTaskLaunch } from "../../brain/brainTasks.js";
import { authorizeBrainTaskAgent, issueBrainTaskAgentCredentials, rotateBrainTaskAgentCredential, revokeBrainTaskAgentCredential, brainTaskCapabilityStatus, issueBrainTaskRecoveryCredential, recoverBrainTaskAgentCredential, authorizeBrainTaskOwnerRecovery, brainTaskCredentialAudit } from "../../brain/brainAgentCredentials.js";
import { reconcileBrainTask } from "../../brain/brainTaskReconciler.js";
import { reconcileBrainSessionJobs } from "../../brain/brainTaskRecovery.js";
import { inspectBrainTaskLaunch, recoverBrainTaskLaunch } from "../../brain/brainLaunchRecovery.js";
import { getDelegateJob } from "../../tools/cliBridgeDelegateJobs.js";

export const BRAIN_MCP_TOOL_DEFS = [
  {
    name: "superagent_brain",
    description: "Session-scoped Brain scratch/metadata/storage, binary artifacts, retention dry runs, two-stage cleanup and CLI Bridge delegation. Isolated from Git workspace.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: [
          "create", "current", "inspect", "list", "files", "read", "write",
          "storage", "metrics", "retention.preview", "cleanup.prepare", "cleanup.confirm",
          "artifact.import", "artifact.read", "cleanup",
          "transfer.begin", "transfer.status", "transfer.append", "transfer.finish", "transfer.abort", "transfer.gc",
          "artifact.annotate", "artifact.search", "session.resume", "memory.candidate", "delegate.promote", "delegate.promote.batch", "artifact.recover",
          "delegate.start", "delegate.get", "delegate.tail", "delegate.cancel", "delegate.jobs",
          "task.create", "task.list", "task.get", "task.claim", "task.status", "task.checkpoint",
          "task.handoff", "task.transfer", "task.resume", "task.reconcile", "task.delegate.start", "task.autostart",
          "task.retry", "task.cancel.request", "task.credential.rotate", "task.credential.revoke", "task.credential.status", "task.credential.audit", "task.credential.recover", "task.launch.inspect", "task.launch.recover", "task.reconcile.all",
        ] },
        sessionId: { type: "string", description: "Optional owner-scoped Brain ID; omit to use this MCP connection's Brain." },
        filePath: { type: "string", description: "Relative file under scratch/, artifacts/ or evidence/." },
        content: { type: "string", description: "Text content for write." },
        overwrite: { type: "boolean", description: "Only ordinary text write supports overwrite." },
        filename: { type: "string", description: "Filename for artifact.import (no folders)." },
        base64: { type: "string", description: "Base64 artifact payload for artifact.import, up to 5 MiB decoded." },
        offset: { type: "integer", minimum: 0, description: "Byte offset for artifact.read; response is a 256 KiB max base64 chunk." },
        days: { type: "integer", enum: [7, 30, 90], description: "Retention dry run threshold." },
        challenge: { type: "string", description: "One-time 60-second token returned by prepare action." },
        cli: { type: "string", enum: ["agy", "claude", "codex"] },
        prompt: { type: "string", maxLength: 15000 },
        jobId: { type: "string" },
        sourceArtifactPath: { type: "string", description: "Optional verified delegate output path to select when a job produced multiple artifacts." },
        expectedArtifacts: { type: "array", maxItems: 12, items: { type: "string" } },
        timeoutMs: { type: "number", minimum: MIN_DELEGATE_TIMEOUT_MS, maximum: MAX_DELEGATE_TIMEOUT_MS },
        transferId: { type: "string" },
        totalBytes: { type: "integer", minimum: 1, maximum: 20971520 },
        sha256: { type: "string", description: "Expected lowercase SHA256 of the complete artifact." },
        summary: { type: "string", maxLength: 800 },
        tags: { type: "array", maxItems: 10, items: { type: "string" } },
        query: { type: "string", maxLength: 160 },
        title: { type: "string", maxLength: 160 },
        taskId: { type: "string" },
        agentId: { type: "string" },
        agentCredential: { type: "string", description: "One-time-issued task-scoped credential for mutating a specific agent's task; never include it in prompts, logs or checkpoints." },
        ownerRecoveryCredential: { type: "string", description: "Owner-only, single-use secret for restoring an agent credential. Never send to delegated agents." },
        confirm: { type: "boolean", description: "Explicit confirmation required for evidence-bound launch recovery; never retries a job." },
        agentIds: { type: "array", maxItems: 12, items: { type: "string" } },
        toAgent: { type: "string" },
        status: { type: "string", enum: ["running", "blocked", "completed", "cancelled"] },
        note: { type: "string", maxLength: 1000 },
        nextStep: { type: "string", maxLength: 500 },
        artifactPaths: { type: "array", maxItems: 10, items: { type: "string" } },
      },
      required: ["action"],
    },
  },
  {
    name: "superagent_brain_publish",
    description: "Two-stage publish of Brain artifacts to an explicitly authorized registered LOCAL project. Requires project write grant and OAuth write scope; create-only, up to 20 MiB.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["prepare", "confirm"] },
        projectId: { type: "string" },
        sessionId: { type: "string" },
        filePath: { type: "string", description: "Source under artifacts/." },
        destinationPath: { type: "string", description: "Project-relative destination (no overwrite)." },
        challenge: { type: "string", description: "Unexpired one-time prepare token." },
      },
      required: ["action", "projectId", "sessionId"],
    },
  },
];
export const BRAIN_MCP_TOOL_CLASSIFICATIONS: Record<string, "dangerous"> = {
  superagent_brain: "dangerous",
  superagent_brain_publish: "dangerous",
};

const delegateActions: Record<string, string> = {
  "delegate.start": "delegate.start",
  "delegate.get": "delegate.get",
  "delegate.tail": "delegate.tail",
  "delegate.cancel": "delegate.cancel",
  "delegate.jobs": "delegate.jobs",
};

function result(value: unknown, isError = false): McpToolResult {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }], ...(isError ? { isError: true } : {}) };
}

function bearerFromPrincipal(principal: string): string {
  // Bind one-time challenges to a principal, without exposing the raw identity.
  return "Bearer " + crypto.createHash("sha256").update("mcp-brain:" + principal).digest("hex");
}

function requireExistingDir(principal: string, sessionId: string): string {
  return inspectBrainSession(principal, sessionId).path;
}

function artifactChunk(principal: string, sessionId: string, relative: unknown, offset: unknown) {
  const filePath = String(relative || "");
  if (!(filePath.startsWith("artifacts/") || filePath.startsWith("evidence/"))) {
    throw new Error("Only artifacts/ and evidence/ support binary download.");
  }
  const dir = requireExistingDir(principal, sessionId);
  const full = path.join(dir, validateDestination(filePath));
  assertNoSymlink(dir, full);
  const stat = fs.lstatSync(full);
  if (!stat.isFile() || stat.nlink > 1 || stat.size > 20 * 1024 * 1024) {
    throw new Error("Artifact is not a regular file of 20 MiB or less.");
  }
  if (typeof offset !== "undefined" && (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0)) {
    throw new Error("Invalid artifact byte offset.");
  }
  const start = typeof offset === "number" ? offset : 0;
  if (start > stat.size) throw new Error("Artifact offset exceeds file size.");
  const n = Math.min(256 * 1024, stat.size - start);
  const data = Buffer.alloc(n);
  const fd = fs.openSync(full, "r");
  try { if (n) fs.readSync(fd, data, 0, n, start); }
  finally { fs.closeSync(fd); }
  return {
    sessionId, filePath, offset: start, length: n, totalBytes: stat.size,
    nextOffset: start + n, done: start + n >= stat.size,
    encoding: "base64" as const, base64: data.toString("base64"),
  };
}

function importArtifact(principal: string, id: string, filename: unknown, encoded: unknown) {
  if (typeof filename !== "string" || typeof encoded !== "string" ||
      !encoded || encoded.length > 7_000_000 || encoded.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new Error("Invalid base64 payload or filename (5 MiB decoded maximum).");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) throw new Error("Artifact base64 is not canonical.");
  return importBrainBinaryArtifact(requireExistingDir(principal, id), filename, bytes);
}

async function dispatchBrainMcpToolInternal(
  name: string, args: Record<string, unknown>, principal: string, connectionSessionId?: string,
): Promise<McpToolResult | null> {
  if (name !== "superagent_brain") return null;
  try {
    const action = String(args.action || "");
    const id = String(args.sessionId || connectionSessionId || "");
    if (!args.sessionId && connectionSessionId &&
        !["list", "retention.preview", "metrics"].includes(action)) {
      createBrainSession(principal, connectionSessionId);
    }
    if (action.startsWith("task.")) {
      if (action === "task.autostart") {
        createBrainSession(principal,id);
        const cli=String(args.cli || "");
        const prompt=args.prompt;
        if(!["agy","claude","codex"].includes(cli)||typeof prompt!=="string"||!prompt.trim()||prompt.length>15000)
          throw new Error("Auto-task delegation needs a CLI and non-empty prompt.");
        const task=createBrainTask(principal,id,prompt.trim().slice(0,120),["main",cli]);
        const credentials=issueBrainTaskAgentCredentials(principal,id,task.taskId);
        const ownerRecoveryCredential=issueBrainTaskRecoveryCredential(principal,id,task.taskId);
        const {scratchPath}=claimBrainTask(principal,id,task.taskId,cli);
        const launch=reserveBrainTaskLaunch(principal,id,task.taskId,cli);
        const output=await cliBridgeTool.execute({
          action:"delegate.start",cli,prompt,skillAutoDetect:false,injectArtifacts:false,
          permissionMode:"accept-edits",idempotencyKey:"brain:"+task.taskId+":"+launch,
          ...(Array.isArray(args.expectedArtifacts)?{expectedArtifacts:args.expectedArtifacts}:{}),
          ...(args.timeoutMs!==undefined?{timeoutMs:args.timeoutMs}:{})
        },scratchPath);
        const match=String(output).match(/clj_\d+_[a-f0-9]{8,32}/);
        if(!match)throw new Error("Delegation acknowledgement missing; launch reservation retained for operator review.");
        recordBrainTaskDelegation(principal,id,task.taskId,cli,cli,match[0]);
        finishBrainTaskLaunch(principal,id,task.taskId,cli,launch,match[0]);
        return result({taskId:task.taskId,scratchPath,delegate:output,agentCredential:credentials[cli],ownerRecoveryCredential});
      }
      const taskId = String(args.taskId || "");
      const agentId = String(args.agentId || "");
      if (action==="task.launch.inspect"||action==="task.launch.recover")
        authorizeBrainTaskOwnerRecovery(principal,id,taskId,args.ownerRecoveryCredential);
      if (!["task.create","task.list","task.get","task.resume","task.reconcile","task.reconcile.all","task.credential.status","task.credential.audit","task.credential.recover","task.launch.inspect","task.launch.recover"].includes(action)) {
        authorizeBrainTaskAgent(principal,id,taskId,agentId,args.agentCredential);
      }
      switch (action) {
        case "task.create": {
          const task=createBrainTask(principal, id, String(args.title || ""), Array.isArray(args.agentIds) ? args.agentIds as string[] : ["main"]);
          const credentials=issueBrainTaskAgentCredentials(principal,id,task.taskId);
          const ownerRecoveryCredential=issueBrainTaskRecoveryCredential(principal,id,task.taskId);
          return result({ ...task, credentials, ownerRecoveryCredential });
        }
        case "task.list": return result(listBrainTasks(principal, id));
        case "task.get": return result(inspectBrainTask(principal, id, taskId));
        case "task.launch.inspect": return result(inspectBrainTaskLaunch(principal,id,taskId));
        case "task.launch.recover": return result(recoverBrainTaskLaunch(principal,id,taskId,String(args.jobId||""),args.confirm===true));
        case "task.credential.audit": return result(brainTaskCredentialAudit(principal,id,taskId));
        case "task.credential.status": return result(brainTaskCapabilityStatus(principal,id,taskId));
        case "task.credential.recover": return result(recoverBrainTaskAgentCredential(principal,id,taskId,agentId,args.ownerRecoveryCredential));
        case "task.credential.rotate": return result(rotateBrainTaskAgentCredential(principal,id,taskId,agentId,{currentCredential:String(args.agentCredential||"")}));
        case "task.credential.revoke": return result(revokeBrainTaskAgentCredential(principal,id,taskId,agentId,{currentCredential:String(args.agentCredential||"")}));
        case "task.reconcile.all": return result(await reconcileBrainSessionJobs(principal,id));
        case "task.reconcile": return result(await reconcileBrainTask(principal,id,taskId));
        case "task.resume": {
          const reconciliation=await reconcileBrainTask(principal,id,taskId);
          return result({...resumeBrainTask(principal,id,taskId),reconciliation});
        }
        case "task.claim": return result(claimBrainTask(principal, id, taskId, agentId));
        case "task.status": {
          const next=String(args.status||"");
          if(["completed","cancelled"].includes(next)) {
            const latest=inspectBrainTask(principal,id,taskId).delegationJobs?.at(-1);
            if(latest) {
              const active=await getDelegateJob(latest.jobId);
              if(!active) throw new Error("Delegation status unavailable; reconcile before finalizing.");
              if(["starting","running","cancelling"].includes(active.status)) {
                throw new Error("Cannot finish a task while its CLI Bridge delegation is active; cancel or reconcile first.");
              }
            }
          }
          return result(updateBrainTask(principal,id,taskId,agentId,next as "running"|"blocked"|"completed"|"cancelled"));
        }
        case "task.checkpoint": return result(checkpointBrainTask(principal, id, taskId, agentId,
          String(args.note || ""), String(args.nextStep || ""), Array.isArray(args.artifactPaths) ? args.artifactPaths as string[] : []));
        case "task.handoff": return result(handoffBrainArtifact(principal, id, taskId, agentId, String(args.toAgent || ""), String(args.filePath || "")));
        case "task.transfer": return result(transferBrainTask(principal, id, taskId, agentId, String(args.toAgent || "")));
        case "task.cancel.request": {
          const task=inspectBrainTask(principal,id,taskId);
          const last=task.delegationJobs?.at(-1);
          if(task.assignedTo!==agentId || !last || last.agentId!==agentId) throw new Error("No authorized active task delegation.");
          const job=await getDelegateJob(last.jobId);
          if(!job || !["starting","running","cancelling"].includes(job.status)) throw new Error("Delegation is not active.");
          const expected=path.join(getBrainScratchPath(principal,id),"agents",agentId,taskId);
          if(fs.realpathSync.native(job.cwd)!==fs.realpathSync.native(expected)) throw new Error("Delegation cwd does not match the claimed task.");
          return result(await cliBridgeTool.execute({action:"delegate.cancel",jobId:last.jobId},expected));
        }
        case "task.retry": {
          const task=inspectBrainTask(principal,id,taskId);
          const last=task.delegationJobs?.at(-1);
          const cli=String(args.cli||"");
          const prompt=args.prompt;
          if(task.assignedTo!==agentId || task.status!=="blocked" || !last || last.agentId!==agentId) throw new Error("Only a blocked task's owner may retry.");
          if(!["agy","claude","codex"].includes(cli) || typeof prompt!=="string" || !prompt.trim() || prompt.length>15000) throw new Error("Retry needs a valid CLI and a new prompt.");
          const previous=await getDelegateJob(last.jobId);
          if(!previous) throw new Error("Previous job status unavailable; operator recovery is required before retry.");
          if(["starting","running","cancelling"].includes(previous.status)) throw new Error("Previous delegation is still active.");
          const scratch=path.join(getBrainScratchPath(principal,id),"agents",agentId,taskId);
          const launch=reserveBrainTaskLaunch(principal,id,taskId,agentId,true);
          const jobResponse=await cliBridgeTool.execute({action:"delegate.start",cli,prompt,skillAutoDetect:false,injectArtifacts:false,permissionMode:"accept-edits",
            idempotencyKey:"brain:"+taskId+":"+launch,
            ...(Array.isArray(args.expectedArtifacts)?{expectedArtifacts:args.expectedArtifacts}:{}),
            ...(args.timeoutMs!==undefined?{timeoutMs:args.timeoutMs}:{})},scratch);
          const match=String(jobResponse).match(/clj_\d+_[a-f0-9]{8,32}/);
          if(!match) throw new Error("Retry delegation did not return an accepted job ID.");
          updateBrainTask(principal,id,taskId,agentId,"running");
          recordBrainTaskDelegation(principal,id,taskId,agentId,cli,match[0]);
          finishBrainTaskLaunch(principal,id,taskId,agentId,launch,match[0]);
          return result({taskId,jobId:match[0],retry:true});
        }
        case "task.delegate.start": {
          const task = inspectBrainTask(principal, id, taskId);
          if (task.assignedTo !== agentId || task.status !== "running") throw new Error("Delegate requires an actively claimed agent task.");
          const cli = String(args.cli || "");
          const prompt = args.prompt;
          if (!["agy","claude","codex"].includes(cli) || typeof prompt !== "string" || !prompt.trim() || prompt.length > 15000) throw new Error("Invalid agent CLI or task prompt.");
          const scratch = path.join(getBrainScratchPath(principal,id), "agents", agentId, taskId);
          const canonical = fs.realpathSync(scratch);
          assertNoSymlink(requireExistingDir(principal,id), canonical);
          const launch=reserveBrainTaskLaunch(principal,id,taskId,agentId);
          const delegate=await cliBridgeTool.execute({
            action: "delegate.start", cli, prompt, permissionMode: "accept-edits",
            skillAutoDetect: false, injectArtifacts: false,
            idempotencyKey:"brain:"+taskId+":"+launch,
            ...(Array.isArray(args.expectedArtifacts) ? { expectedArtifacts: args.expectedArtifacts } : {}),
            ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
          }, canonical);
          const matched=String(delegate).match(/clj_\d+_[a-f0-9]{8,32}/);
          if(!matched)throw new Error("Delegation acknowledgement missing; launch reservation retained.");
          recordBrainTaskDelegation(principal,id,taskId,agentId,cli,matched[0]);
          finishBrainTaskLaunch(principal,id,taskId,agentId,launch,matched[0]);
          return result({taskId,agentId,scratchPath:canonical,delegate});
        }
      }
      throw new Error("Unsupported Brain task action.");
    }
    if (action in delegateActions) {
      if (!id) throw new Error("Brain sessionId required for delegation.");
      const scratch = getBrainScratchPath(principal, id);
      if (action === "delegate.start") {
        const cli = args.cli;
        const prompt = args.prompt;
        if (!["agy", "claude", "codex"].includes(String(cli))) throw new Error("CLI must be agy, claude, or codex.");
        if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 15000) throw new Error("Delegate prompt required (max 15000 characters).");
        const safeArgs: Record<string, unknown> = {
          action: "delegate.start", cli, prompt,
          skillAutoDetect: false, injectArtifacts: false, permissionMode: "accept-edits",
        };
        if (Array.isArray(args.expectedArtifacts)) safeArgs.expectedArtifacts = args.expectedArtifacts;
        if (args.timeoutMs !== undefined) safeArgs.timeoutMs = args.timeoutMs;
        return result(await cliBridgeTool.execute(safeArgs, scratch));
      }
      if (action !== "delegate.jobs" && (!args.jobId || typeof args.jobId !== "string")) throw new Error("jobId required.");
      return result(await cliBridgeTool.execute({
        action: delegateActions[action], ...(action !== "delegate.jobs" ? { jobId: args.jobId } : {}),
      }, scratch));
    }
    const configRoot = getRootConfigDir();
    const owner = bearerFromPrincipal(principal);
    switch (action) {
      case "create":
      case "current": return result(createBrainSession(principal, id || undefined));
      case "list": return result(listBrainSessions(principal));
      case "inspect": return result(inspectBrainSession(principal, id));
      case "files": return result(listBrainFiles(principal, id));
      case "read": return result({ sessionId: id, filePath: args.filePath, content: readBrainFile(principal, id, String(args.filePath || "")) });
      case "write": return result(writeBrainFile(principal, id, String(args.filePath || ""), args.content as string, args.overwrite === true));
      case "storage": return result({ sessionId: id, ...brainStorageUsage(requireExistingDir(principal, id)) });
      case "metrics": return result(summarizeBrainEvents(principal, configRoot));
      case "retention.preview": return result(previewBrainRetention(principal, args.days === undefined ? 30 : Number(args.days)));
      case "cleanup": throw new Error("Direct cleanup retired for MCP; use cleanup.prepare then cleanup.confirm.");
      case "cleanup.prepare": return result(prepareBrainCleanup(owner, id, requireExistingDir(principal, id), configRoot));
      case "cleanup.confirm": return result(confirmBrainCleanup(owner, id, String(args.challenge || ""), requireExistingDir(principal, id), configRoot));
      case "artifact.import": return result(importArtifact(principal, id, args.filename, args.base64));
      case "artifact.read": return result(artifactChunk(principal, id, args.filePath, args.offset));
      case "transfer.begin": return result(beginBrainTransfer(principal, id, String(args.filename || ""), Number(args.totalBytes), String(args.sha256 || "")));
      case "transfer.status": return result(inspectBrainTransfer(principal, id, String(args.transferId || "")));
      case "transfer.append": return result(appendBrainTransfer(principal, id, String(args.transferId || ""), Number(args.offset), args.base64));
      case "transfer.finish": return result(finishBrainTransfer(principal, id, String(args.transferId || "")));
      case "transfer.abort": return result(abortBrainTransfer(principal, id, String(args.transferId || "")));
      case "transfer.gc": return result(cleanupBrainTransfers(principal, id));
      case "artifact.annotate": return result(annotateBrainArtifact(principal, id, String(args.filePath || ""), String(args.summary || ""), args.tags as string[] | undefined));
      case "artifact.search": return result(searchBrainArtifacts(principal, String(args.query || "")));
      case "session.resume": return result(brainResumeContext(principal, id));
      case "memory.candidate": return result(brainRMemoryCandidate(principal, id, String(args.filePath || "")));
      case "delegate.promote": return result(await promoteBrainDelegation(principal, id, String(args.jobId || ""), typeof args.filename === "string" ? args.filename : undefined, typeof args.sourceArtifactPath==="string"?args.sourceArtifactPath:undefined));
      case "delegate.promote.batch": return result(await promoteBrainDelegationBatch(principal,id,String(args.jobId||"")));
      case "artifact.recover": return result(recoverBrainArtifactPromotion(principal,id));
      default: throw new Error("Unsupported brain action.");
    }
  } catch (error: any) {
    return result(error?.message || String(error), true);
  }
}

export async function dispatchBrainMcpTool(
  name: string, args: Record<string, unknown>, principal: string, connectionSessionId?: string,
): Promise<McpToolResult | null> {
  const action = String(args.action || "");
  const started = Date.now();
  let response: McpToolResult | null = null;
  try {
    response = await dispatchBrainMcpToolInternal(name, args, principal, connectionSessionId);
    return response;
  } finally {
    if (name === "superagent_brain") {
      recordBrainEvent(principal, action, response?.isError ? "error" : "ok", Date.now() - started, getRootConfigDir());
    }
  }
}

function dispatchBrainPublishMcpToolInternal(
  name: string, args: Record<string, unknown>, principal: string, projectRoot?: string,
): McpToolResult | null {
  if (name !== "superagent_brain_publish") return null;
  try {
    if (!projectRoot) throw new Error("An authorized registered local project is required.");
    const action = String(args.action || "");
    const sessionId = String(args.sessionId || "");
    const dir = requireExistingDir(principal, sessionId);
    const owner = bearerFromPrincipal(principal);
    if (action === "prepare") {
      return result(prepareBrainPublish(owner, sessionId, dir, String(args.filePath || ""),
        projectRoot, String(args.destinationPath || "")));
    }
    if (action === "confirm") {
      return result(confirmBrainPublish(owner, sessionId, String(args.challenge || ""), dir, projectRoot, true));
    }
    throw new Error("Brain publication requires action=prepare then action=confirm.");
  } catch (error: any) {
    return result(error?.message || String(error), true);
  }
}

export function dispatchBrainPublishMcpTool(
  name: string, args: Record<string, unknown>, principal: string, projectRoot?: string,
): McpToolResult | null {
  const started = Date.now();
  const response = dispatchBrainPublishMcpToolInternal(name, args, principal, projectRoot);
  if (name === "superagent_brain_publish") {
    recordBrainEvent(principal, "publish." + String(args.action || ""),
      response?.isError ? "error" : "ok", Date.now() - started, getRootConfigDir());
  }
  return response;
}
