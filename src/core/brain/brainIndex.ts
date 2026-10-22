/**
 * Owner-scoped Brain artifact metadata: no duplicated chat history or RMemory store.
 * Explicit human/agent-authored summaries become RMemory candidates, not implicit
 * global memories or automatic cross-tenant writes.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { getRootConfigDir } from "../config/paths.js";
import { inspectBrainSession, listBrainSessions, listBrainFiles } from "./brainWorkspace.js";
import { assertNoSymlink, validateDestination } from "./brainStorageManager.js";

export interface BrainRecord {
  path: string;
  summary: string;
  tags: string[];
  updatedAt: string;
  sha256: string;
  bytes: number;
}
type Index = { schemaVersion: 1; records: BrainRecord[] };
function paths(owner: string, id: string, root = getRootConfigDir()) {
  const dir = inspectBrainSession(owner, id, root).path;
  const index = path.join(dir, "artifact-index.json");
  assertNoSymlink(dir, index);
  return { dir, index };
}
function readIndex(index: string): Index {
  if (!fs.existsSync(index)) return { schemaVersion: 1, records: [] };
  if (fs.lstatSync(index).size > 256 * 1024) throw new Error("Artifact index exceeds safe read limit.");
  const data = JSON.parse(fs.readFileSync(index, "utf8")) as Index;
  if (data.schemaVersion !== 1 || !Array.isArray(data.records) || data.records.length > 300) throw new Error("Invalid Brain artifact index.");
  return data;
}
export function annotateBrainArtifact(
  owner: string, sessionId: string, filePath: string, summary: string, tags: string[] = [],
  root = getRootConfigDir(),
) {
  if (typeof summary !== "string" || !summary.trim() || summary.length > 800 ||
    !Array.isArray(tags) || tags.length > 10 || tags.some(v => typeof v !== "string" || v.length > 40 || !/^[\w\- ]+$/.test(v))) {
    throw new Error("Brain annotation requires a concise summary and valid tags.");
  }
  if (!filePath.startsWith("artifacts/") && !filePath.startsWith("evidence/")) {
    throw new Error("Only artifacts and evidence can be indexed.");
  }
  const { dir, index } = paths(owner, sessionId, root);
  const file = path.join(dir, validateDestination(filePath));
  assertNoSymlink(dir, file);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 20 * 1024 * 1024) throw new Error("Unsupported Brain artifact.");
  const digest = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const doc = readIndex(index);
  const now = new Date().toISOString();
  const record: BrainRecord = {
    path: filePath, summary: summary.trim(), tags: [...new Set(tags.map(x => x.trim().toLowerCase()))],
    updatedAt: now, sha256: digest, bytes: stat.size,
  };
  doc.records = [...doc.records.filter(v => v.path !== filePath), record];
  if (doc.records.length > 300) throw new Error("Brain metadata index is full.");
  const temp = index + "." + crypto.randomUUID() + ".tmp";
  try {
    fs.writeFileSync(temp, JSON.stringify(doc, null, 2), { flag: "wx", mode: 0o600 });
    fs.renameSync(temp, index);
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  return { sessionId, record };
}
export function searchBrainArtifacts(owner: string, query: string, root = getRootConfigDir()) {
  if (typeof query !== "string" || query.length > 160) throw new Error("Invalid search query.");
  const term = query.trim().toLowerCase();
  if (!term) return [];
  const found: Array<BrainRecord & { sessionId: string; verified: boolean }> = [];
  for (const session of listBrainSessions(owner, root)) {
    try {
      const { dir, index } = paths(owner, session.sessionId, root);
      const records = readIndex(index).records;
      for (const record of records) {
        if (![record.path, record.summary, ...record.tags].some(v => typeof v === "string" && v.toLowerCase().includes(term))) continue;
        const file = path.join(dir, validateDestination(record.path));
        assertNoSymlink(dir, file);
        if (!fs.existsSync(file)) continue;
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size !== record.bytes) continue;
        const currentSha = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
        if (currentSha !== record.sha256) continue;
        found.push({ ...record, sessionId: session.sessionId, verified: true });
        if (found.length >= 50) return found;
      }
    } catch { /* Do not disclose corrupt or foreign sessions. */ }
  }
  return found.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
}
export function brainResumeContext(owner: string, sessionId: string, root = getRootConfigDir()) {
  const { index } = paths(owner, sessionId, root);
  const records = readIndex(index).records;
  const files = listBrainFiles(owner, sessionId, root);
  return {
    sessionId,
    artifacts: files.filter(v => v.path.startsWith("artifacts/")),
    evidence: files.filter(v => v.path.startsWith("evidence/")),
    records,
    pendingScratch: files.filter(v => v.path.startsWith("scratch/")).slice(0, 80),
    historyNote: "Chat history is stored in SuperAgent History SQLite; RMemory is a separate memory service.",
  };
}
export function brainRMemoryCandidate(owner: string, sessionId: string, filePath: string, root = getRootConfigDir()) {
  const { index } = paths(owner, sessionId, root);
  const record = readIndex(index).records.find(v => v.path === filePath);
  if (!record) throw new Error("Annotate artifact before exporting an RMemory candidate.");
  const { dir } = paths(owner, sessionId, root);
  const source = path.join(dir, validateDestination(filePath));
  assertNoSymlink(dir, source);
  const stat = fs.lstatSync(source);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size !== record.bytes ||
    crypto.createHash("sha256").update(fs.readFileSync(source)).digest("hex") !== record.sha256) {
    throw new Error("Brain artifact changed since annotation; re-annotate before RMemory promotion.");
  }
  if (record.summary.length > 800) throw new Error("Invalid memory candidate.");
  return {
    type: "task-summary",
    scope: "project",
    assertionKey: `brain:${sessionId}:${record.sha256.slice(0, 16)}`,
    retentionClass: "task-summary",
    content: `Brain artifact ${record.path} (session ${sessionId}): ${record.summary}. Tags: ${record.tags.join(", ")}.`,
    source: "brain-artifact-metadata",
    requiresExplicitRMemorySave: true,
  };
}
