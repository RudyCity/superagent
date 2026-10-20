import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { MotionProject } from "../schema/types.js";
import { validateMotionProject } from "../schema/validation.js";
import { applyMotionEdits } from "./revisions.js";
import { resolveMotionAssets } from "../assets/motionAssets.js";
import type { MotionEdit } from "../schema/types.js";

const idPattern = /^[a-z][a-z0-9-]{1,63}$/;
const dirParts = [".superagent", "motion", "projects"];

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
    const tmp = file + "." + crypto.randomBytes(8).toString("hex") + ".tmp";
    try {
      const handle = await fs.open(tmp, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(next, null, 2) + "\n");
        await handle.sync();
      } finally { await handle.close(); }
      await fs.rename(tmp, file);
    } finally {
      await fs.rm(tmp, { force: true });
    }
    return next;
  } finally {
    await lock.close();
    await fs.rm(lockFile, { force: true });
  }
}
