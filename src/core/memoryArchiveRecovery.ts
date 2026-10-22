import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { redactMemorySecrets } from "./memoryLifecycle.js";

export interface ArchivedMemory {
  id: string;
  content: string;
  metadata: Record<string, any>;
}
export interface ArchiveScan {
  archive: string;
  modelName: string;
  dimensions: number;
  total: number;
  eligible: number;
  ambiguous: number;
  fingerprint: string;
  candidates: ArchivedMemory[];
}
function openReadOnlySqlite(filename: string): { prepare(sql: string): { all(...args: any[]): any[] }; close(): void } {
  if (process.versions.bun) {
    const { Database } = require("bun:sqlite");
    return new Database(filename, { readonly: true, create: false });
  }
  const { DatabaseSync } = require("node:sqlite");
  return new DatabaseSync(filename, { readOnly: true });
}
function getBackupDirectory(dataDir: string, name: string): string {
  if (!/^backup-[a-zA-Z0-9_-]{1,95}$/.test(name)) throw new Error("Invalid RMemory backup identifier.");
  const root = fs.realpathSync(path.join(dataDir, ".index-backups"));
  const target = fs.realpathSync(path.join(root, name));
  if (path.dirname(target) !== root) throw new Error("Backup path escapes allowed archive directory.");
  return target;
}
export function listMemoryArchiveBackups(dataDir: string): Array<{ name: string; modelName: string; dimensions: number }> {
  const base = path.join(dataDir, ".index-backups");
  if (!fs.existsSync(base)) return [];
  return fs.readdirSync(base, { withFileTypes: true })
    .filter(item => item.isDirectory() && /^backup-[a-zA-Z0-9_-]{1,95}$/.test(item.name))
    .flatMap(item => {
      try {
        const dirname = getBackupDirectory(dataDir, item.name);
        const data = JSON.parse(fs.readFileSync(path.join(dirname, "metadata.json"), "utf8"));
        if (!fs.existsSync(path.join(dirname, "vectors.db"))) return [];
        return [{ name: item.name, modelName: String(data.modelName), dimensions: Number(data.dimensions) }];
      } catch { return []; }
    });
}
/**
 * Read an old embedding index without modifying it. All records are separately
 * assessed for explicit project/global ownership. Caller supplies canonical
 * project scope and controls the final reviewed write.
 */
export function scanMemoryArchive(dataDir: string, name: string, projectId: string, maxRecords = 250): ArchiveScan {
  if (!/^p_[a-f0-9]{16}$/.test(projectId) && !/^p_[a-zA-Z0-9_-]{1,80}$/.test(projectId))
    throw new Error("Archive recovery requires a canonical project identifier.");
  const dirname = getBackupDirectory(dataDir, name);
  const { modelName, dimensions } = JSON.parse(fs.readFileSync(path.join(dirname, "metadata.json"), "utf8"));
  const db = openReadOnlySqlite(path.join(dirname, "vectors.db"));
  let rows: { id: string; content: string; metadata: string }[];
  try {
    rows = db.prepare("SELECT id, content, metadata FROM memories_memories ORDER BY rowid ASC LIMIT 20000").all();
  } finally { db.close(); }
  const candidates: ArchivedMemory[] = [];
  let ambiguous = 0;
  let eligible = 0;
  for (const row of rows) {
    let meta: Record<string, any>;
    try { meta = JSON.parse(row.metadata); } catch { ambiguous++; continue; }
    if (!meta || typeof meta !== "object" || meta.internalProbe ||
        meta.type !== "memory" || meta.lifecycleState === "superseded") continue;
    let matches = meta.scope === "global" || (meta.scope === "project" && meta.projectId === projectId);
    if (!meta.scope) matches = row.content.startsWith("[global]") || row.content.startsWith(`[project:${projectId}]`);
    if (!matches || (meta.scope && meta.scope !== "global" && meta.scope !== "project")) {
      ambiguous++; continue;
    }
    eligible++;
    if (candidates.length < Math.min(Math.max(1, maxRecords), 250)) {
      const scope = meta.scope || (row.content.startsWith("[global]") ? "global" : "project");
      candidates.push({
        id: row.id,
        content: redactMemorySecrets(row.content),
        metadata: { ...meta, scope, ...(scope === "project" ? { projectId } : {}) },
      });
    }
  }
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ name, modelName, dimensions, eligible, ambiguous,
      keys: candidates.map(c => [c.id, c.content]) })).digest("hex");
  return { archive: name, modelName: String(modelName), dimensions: Number(dimensions),
    total: rows.length, eligible, ambiguous, fingerprint, candidates };
}
