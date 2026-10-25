import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { inspectStudioStorageMigration, motionWorkspaceRoot } from "./projectStore.js";

export const STUDIO_CUTOVER_MARKER = ".studio-verified-copy.json";

interface CutoverMarker {
  version: 1;
  mode: "verified-copy";
  from: "motion";
  to: "studio";
  files: number;
  sha256: string;
  completedAt: string;
}

async function safeMarker(home: string): Promise<CutoverMarker | null> {
  const file = path.join(home, STUDIO_CUTOVER_MARKER);
  const st = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!st) return null;
  if (!st.isFile() || st.isSymbolicLink() || st.size > 4096) {
    throw new Error("Invalid Studio copy cutover marker");
  }
  let obj: unknown;
  try { obj = JSON.parse(await fs.readFile(file, "utf8")); }
  catch { throw new Error("Unreadable Studio copy cutover marker"); }
  if (!obj || typeof obj !== "object") throw new Error("Invalid Studio copy cutover marker");
  const m = obj as Partial<CutoverMarker>;
  if (m.version !== 1 || m.mode !== "verified-copy" || m.from !== "motion" ||
      m.to !== "studio" || !Number.isSafeInteger(m.files) || (m.files ?? 0) < 1 ||
      !/^[0-9a-f]{64}$/.test(String(m.sha256)) ||
      typeof m.completedAt !== "string" || !Number.isFinite(Date.parse(m.completedAt))) {
    throw new Error("Invalid Studio copy cutover marker");
  }
  return m as CutoverMarker;
}

/** Marker only authorizes coexistence; absent or malformed markers fail closed. */
export async function isVerifiedStudioCopyCutover(home: string): Promise<boolean> {
  return (await safeMarker(home)) !== null;
}

interface Snapshot { files: number; bytes: number; sha256: string }
async function snapshotTree(directory: string): Promise<Snapshot> {
  const entries: Array<{ rel: string; size: number; hash: string }> = [];
  const directories: string[] = [];
  const pending: Array<{ dir: string; rel: string; depth: number }> = [
    { dir: directory, rel: "", depth: 0 }
  ];
  while (pending.length) {
    const { dir, rel, depth } = pending.pop()!;
    if (depth > 12 || entries.length + directories.length > 50_000)
      throw new Error("Studio copy inspection exceeds safe limits");
    for (const name of (await fs.readdir(dir)).sort()) {
      const relative = rel ? rel + "/" + name : name;
      const file = path.join(dir, name);
      const stat = await fs.lstat(file);
      if (stat.isSymbolicLink()) throw new Error("Studio copy cannot follow symbolic links");
      if (stat.isDirectory()) {
        directories.push(relative);
        pending.push({ dir: file, rel: relative, depth: depth + 1 });
      } else if (stat.isFile()) {
        if (stat.size > 256 * 1024 * 1024) throw new Error("Studio copy file too large");
        const bytes = await fs.readFile(file);
        if (bytes.length !== stat.size) throw new Error("Studio source mutated during copy");
        entries.push({
          rel: relative, size: bytes.length,
          hash: crypto.createHash("sha256").update(bytes).digest("hex")
        });
      } else {
        throw new Error("Studio copy refuses special-file entries");
      }
    }
  }
  const hash = crypto.createHash("sha256");
  directories.sort().forEach(d => hash.update(JSON.stringify(["d", d]) + "\n"));
  entries.sort((a, b) => a.rel.localeCompare(b.rel)).forEach(e =>
    hash.update(JSON.stringify(["f", e.rel, e.size, e.hash]) + "\n"));
  return {
    files: entries.length,
    bytes: entries.reduce((sum, entry) => sum + entry.size, 0),
    sha256: hash.digest("hex")
  };
}

function identical(a: Snapshot, b: Snapshot): boolean {
  return a.files === b.files && a.bytes === b.bytes && a.sha256 === b.sha256;
}

/**
 * Windows-safe alternative when an IDE holds directory handles and atomic rename is
 * unavailable. Copies into an unobservable temporary namespace, verifies every byte
 * against two source snapshots, then publishes the verified destination and a strict
 * marker. The old tree is deliberately retained as a rollback backup.
 * Never use this while unupgraded Studio processes can write to the legacy tree.
 */
export async function migrateStudioStorageVerifiedCopy(workspace: string): Promise<{
  migrated: boolean; method: "verified-copy"; from: string; to: string;
  retainedLegacy: true; files: number; bytes: number; sha256: string;
}> {
  const root = await motionWorkspaceRoot(workspace);
  const home = path.join(root, ".superagent");
  const lockName = path.join(home, ".studio-migration.lock");
  const lock = await fs.open(lockName, "wx", 0o600).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EEXIST") throw new Error("Studio storage migration already locked");
    throw error;
  });
  let stage: string | undefined;
  let published = false;
  try {
    const scan = await inspectStudioStorageMigration(root);
    if (scan.state !== "legacy" || scan.blockers.length)
      throw new Error("Studio copy migration blocked: " + [scan.state, ...scan.blockers].join("; "));
    if (await safeMarker(home))
      throw new Error("Studio cutover marker already exists; inspect manually");
    const before = await snapshotTree(scan.from);
    if (before.files === 0) throw new Error("Empty Studio storage cannot be migrated by copy");
    stage = path.join(home, ".studio-copy-stage-" + crypto.randomBytes(8).toString("hex"));
    await fs.cp(scan.from, stage, { recursive: true, errorOnExist: true, force: false });
    const [copied, after] = await Promise.all([snapshotTree(stage), snapshotTree(scan.from)]);
    if (!identical(before, copied) || !identical(before, after))
      throw new Error("Studio source/target hash mismatch; original data preserved");
    const finalScan = await inspectStudioStorageMigration(root);
    if (finalScan.state !== "legacy" || finalScan.blockers.length)
      throw new Error("Studio queue changed during migration; original data preserved");
    await fs.rename(stage, scan.to);
    stage = undefined;
    published = true;
    const marker: CutoverMarker = {
      version: 1, mode: "verified-copy", from: "motion", to: "studio",
      files: copied.files, sha256: copied.sha256, completedAt: new Date().toISOString()
    };
    const tmp = path.join(home, ".studio-cutover-" + crypto.randomBytes(8).toString("hex") + ".tmp");
    try {
      await fs.writeFile(tmp, JSON.stringify(marker, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      await fs.rename(tmp, path.join(home, STUDIO_CUTOVER_MARKER));
    } finally {
      await fs.rm(tmp, { force: true });
    }
    return {
      migrated: true, method: "verified-copy",
      from: scan.from, to: scan.to, retainedLegacy: true,
      files: copied.files, bytes: copied.bytes, sha256: copied.sha256
    };
  } catch (error) {
    // If published but no marker, keep both trees untouched and fail closed,
    // allowing forensic recovery without deleting verified data.
    if (published) {
      throw new Error("Verified Studio copy published without a cutover marker; both trees preserved for manual recovery", { cause: error });
    }
    throw error;
  } finally {
    if (stage) await fs.rm(stage, { recursive: true, force: true }).catch(() => {});
    await lock.close();
    await fs.rm(lockName, { force: true });
  }
}
