import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { MotionProject } from "../schema/types.js";
import { validateMotionProject } from "../schema/validation.js";
import { applyMotionEdits } from "./revisions.js";
import { resolveMotionAssets } from "../assets/motionAssets.js";
import { resolveMotionAudioTracks } from "../assets/motionAudio.js";
import type { MotionEdit } from "../schema/types.js";

const idPattern = /^[a-z][a-z0-9-]{1,63}$/;
const dirParts = [".superagent", "motion", "projects"];
const HISTORY_LIMIT = 20;

/** Local workspaces only in this first implementation. Never follow symlinked storage roots. */
export async function motionWorkspaceRoot(workspace: string): Promise<string> {
  if (!workspace || workspace.startsWith("ssh:") || workspace.startsWith("chain:")) {
    throw new Error("Motion Studio currently supports local workspaces only");
  }
  const resolved = await fs.realpath(path.resolve(workspace));
  const stat = await fs.stat(resolved);
  if (!stat.isDirectory()) throw new Error("Motion workspace is not a directory");
  return resolved;
}
export async function motionStorageDir(workspace: string, create = false): Promise<string> {
  let current = await motionWorkspaceRoot(workspace);
  for (const part of dirParts) {
    current = path.join(current, part);
    if (create) {
      try { await fs.mkdir(current, { mode: 0o700 }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    const stat = await fs.lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (!create && error.code === "ENOENT") return null;
      throw error;
    });
    if (stat === null) return current;
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("Motion Studio storage path must be a real directory");
    }
  }
  return current;
}
function assertId(projectId: string): void {
  if (!idPattern.test(projectId)) throw new Error("Invalid Motion Studio project id");
}
async function projectFile(workspace: string, projectId: string): Promise<string> {
  assertId(projectId);
  const dir = await motionStorageDir(workspace);
  return path.join(dir, projectId + ".json");
}
async function readOwnedProject(workspace: string, file: string): Promise<MotionProject> {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4_000_000) throw new Error("Invalid motion project file");
  const project: unknown = JSON.parse(await fs.readFile(file, "utf8"));
  validateMotionProject(project);
  const root = await motionWorkspaceRoot(workspace);
  if (project.workspaceRoot !== root) throw new Error("Motion project is owned by another workspace");
  return project;
}
export async function getMotionProject(workspace: string, id: string): Promise<MotionProject> {
  const project = await readOwnedProject(workspace, await projectFile(workspace, id));
  if (project.id !== id) throw new Error("Motion project id mismatch");
  return project;
}
export async function listMotionProjects(workspace: string): Promise<{ id: string; name: string; revision: number }[]> {
  const dir = await motionStorageDir(workspace);
  const names = await fs.readdir(dir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const projects: { id: string; name: string; revision: number }[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".json") || !idPattern.test(name.slice(0, -5))) continue;
    try {
      const project = await readOwnedProject(workspace, path.join(dir, name));
      if (project.id === name.slice(0, -5)) {
        projects.push({ id: project.id, name: project.name, revision: project.revision });
      }
    } catch {
      // Invalid, symlinked, or cross-workspace project data is never exposed.
    }
  }
  return projects;
}
export async function createMotionProject(workspace: string, name: string): Promise<MotionProject> {
  if (typeof name !== "string" || !name.trim() || name.length > 160) throw new Error("Motion project name must be 1-160 characters");
  const root = await motionWorkspaceRoot(workspace);
  const id = "motion-" + crypto.randomBytes(10).toString("hex");
  const now = new Date().toISOString();
  const project: MotionProject = {
    schemaVersion: 1, id, workspaceRoot: root, name: name.trim(), revision: 1,
    createdAt: now, updatedAt: now,
    composition: {
      width: 1920, height: 1080, fps: { numerator: 30, denominator: 1 },
      durationFrames: 300, background: "#171B28",
      layers: [{
        id: "title", kind: "text", text: name.trim(), x: 144, y: 425,
        width: 1632, height: 180, rotation: 0, opacity: 1,
        fill: "#F7F8FF", fontSize: 96, fontFamily: "Arial",
        tracks: [{ property: "opacity", keyframes: [
          { frame: 0, value: 0, easing: "easeInOut" },
          { frame: 24, value: 1 },
        ] }],
      }],
    },
  };
  validateMotionProject(project);
  const dir = await motionStorageDir(root, true);
  await fs.writeFile(path.join(dir, id + ".json"), JSON.stringify(project, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  return project;
}

/** Every successful edit durably snapshots its preceding revision, under
 * the same project lock. No periodic timer, loose localStorage or sidecar
 * daemon is required: committed edits are already autosaved immediately.
 */
async function motionHistoryDir(workspace: string, id: string, create = false): Promise<string> {
  assertId(id);
  const dir = path.join(await motionStorageDir(workspace, create), id + ".history");
  if (create) {
    try { await fs.mkdir(dir, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  const st = await fs.lstat(dir).catch((error: NodeJS.ErrnoException) => {
    if (!create && error.code === "ENOENT") return null;
    throw error;
  });
  if (st && (!st.isDirectory() || st.isSymbolicLink())) {
    throw new Error("Invalid Motion history directory");
  }
  return dir;
}
const historyName = (revision: number) => "r" + String(revision).padStart(10, "0") + ".json";
const historyPattern = /^r\d{10}\.json$/;

async function archiveMotionRevision(workspace: string, project: MotionProject): Promise<void> {
  const dir = await motionHistoryDir(workspace, project.id, true);
  const file = path.join(dir, historyName(project.revision));
  const encoded = JSON.stringify(project, null, 2) + "\n";
  let created = false;
  try {
    const h = await fs.open(file, "wx", 0o600);
    created = true;
    try { await h.writeFile(encoded); await h.sync(); }
    finally { await h.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      if (created) await fs.rm(file, { force: true });
      throw error;
    }
    // A stale snapshot from an interrupted update is safe only when identical.
    const existing = await readOwnedProject(workspace, file);
    if (existing.id !== project.id || JSON.stringify(existing) !== JSON.stringify(project)) {
      throw new Error("Motion recovery snapshot conflicts with committed revision");
    }
  }
}
/** Enumerate immutable, workspace-owned revisions. Corrupt history never
 * replaces valid current project data, and symlinked entries are rejected.
 */
export async function listMotionProjectHistory(workspace: string, id: string):
  Promise<Array<{ revision: number; updatedAt: string; name: string }>> {
  const current = await getMotionProject(workspace, id);
  const dir = await motionHistoryDir(workspace, id);
  const names = await fs.readdir(dir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const result: Array<{ revision: number; updatedAt: string; name: string }> = [];
  for (const name of names.filter(item => historyPattern.test(item)).sort().reverse().slice(0, HISTORY_LIMIT)) {
    try {
      const project = await readOwnedProject(workspace, path.join(dir, name));
      if (project.id === id && project.revision < current.revision &&
        historyName(project.revision) === name) {
        result.push({ revision: project.revision, updatedAt: project.updatedAt, name: project.name });
      }
    } catch { /* invalid or symlinked snapshots are not exposed */ }
  }
  return result;
}
export async function restoreMotionProjectHistory(
  workspace: string, id: string, baseRevision: number, revision: number,
): Promise<MotionProject> {
  if (!Number.isSafeInteger(revision) || revision < 1 || revision > 2_000_000_000) {
    throw new Error("Invalid Motion history revision");
  }
  const current = await getMotionProject(workspace, id);
  if (revision >= current.revision) throw new Error("Invalid historical revision");
  const saved = await readOwnedProject(workspace,
    path.join(await motionHistoryDir(workspace, id), historyName(revision)));
  if (saved.id !== id || saved.revision !== revision) throw new Error("Motion history revision mismatch");
  // updateMotionProject rechecks baseRevision under the project lock, archives
  // the current composition, and checks referenced media before restoration.
  return updateMotionProject(workspace, id, baseRevision, [
    { type: "replace-composition", composition: saved.composition },
  ]);
}
async function pruneMotionHistory(workspace: string, id: string): Promise<void> {
  const dir = await motionHistoryDir(workspace, id);
  const names = (await fs.readdir(dir)).filter(name => historyPattern.test(name)).sort().reverse();
  for (const name of names.slice(HISTORY_LIMIT)) {
    const file = path.join(dir, name);
    const stat = await fs.lstat(file);
    if (stat.isFile() && !stat.isSymbolicLink()) await fs.rm(file);
  }
}

/** Lock and compare-and-swap avoid lost updates across independent CLI processes. */
export async function updateMotionProject(
  workspace: string, id: string, baseRevision: number, operations: MotionEdit[],
): Promise<MotionProject> {
  const file = await projectFile(workspace, id);
  const lockFile = file + ".lock";
  const lock = await fs.open(lockFile, "wx", 0o600).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EEXIST") throw new Error("Motion project is locked by another editor");
    throw error;
  });
  try {
    const before = await readOwnedProject(workspace, file);
    const next = applyMotionEdits(before, baseRevision, operations);
    // A committed scene must not reference missing or corrupted local assets.
    await resolveMotionAssets(workspace, next);
    await resolveMotionAudioTracks(workspace, next);
    await archiveMotionRevision(workspace, before);
    const tmp = file + "." + crypto.randomBytes(8).toString("hex") + ".tmp";
    try {
      const handle = await fs.open(tmp, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(next, null, 2) + "\n");
        await handle.sync();
      } finally { await handle.close(); }
      await fs.rename(tmp, file);
      // Noncritical pruning never rolls back an already committed edit.
      await pruneMotionHistory(workspace, id).catch(() => {});
    } finally {
      await fs.rm(tmp, { force: true });
    }
    return next;
  } finally {
    await lock.close();
    await fs.rm(lockFile, { force: true });
  }
}
