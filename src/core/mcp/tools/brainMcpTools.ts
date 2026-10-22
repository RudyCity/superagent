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
import { beginBrainTransfer, inspectBrainTransfer, appendBrainTransfer, finishBrainTransfer, abortBrainTransfer, cleanupBrainTransfers } from "../../brain/brainTransfers.js";
import { annotateBrainArtifact, searchBrainArtifacts, brainResumeContext, brainRMemoryCandidate } from "../../brain/brainIndex.js";
import { promoteBrainDelegation } from "../../brain/brainDelegationArtifacts.js";
import { recordBrainEvent, summarizeBrainEvents } from "../../brain/brainObservability.js";

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
          "artifact.annotate", "artifact.search", "session.resume", "memory.candidate", "delegate.promote",
          "delegate.start", "delegate.get", "delegate.tail", "delegate.cancel", "delegate.jobs",
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
        expectedArtifacts: { type: "array", maxItems: 12, items: { type: "string" } },
        timeoutMs: { type: "number", minimum: 1000, maximum: 7200000 },
        transferId: { type: "string" },
        totalBytes: { type: "integer", minimum: 1, maximum: 20971520 },
        sha256: { type: "string", description: "Expected lowercase SHA256 of the complete artifact." },
        summary: { type: "string", maxLength: 800 },
        tags: { type: "array", maxItems: 10, items: { type: "string" } },
        query: { type: "string", maxLength: 160 },
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
      case "delegate.promote": return result(await promoteBrainDelegation(principal, id, String(args.jobId || ""), typeof args.filename === "string" ? args.filename : undefined));
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
