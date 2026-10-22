/** Immutable project origin for explicit Brain -> RMemory writes. */
import fs from "node:fs";
import path from "node:path";
import { inspectBrainSession } from "./brainWorkspace.js";
import { assertNoSymlink } from "./brainStorageManager.js";
import { getRMemoryProjectId } from "../rmemoryUtil.js";
import { getProject, listProjects } from "../project/projectRegistry.js";

interface Provenance {
  version: 1; projectId: string; canonicalRoot: string; rmemoryProjectId: string; createdAt: string;
}
function inside(root: string, cwd: string) {
  const rel = path.relative(root, cwd);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel));
}
export function bindBrainProject(owner: string, sessionId: string, workingDirectory: string): Provenance | null {
  const cwd = fs.realpathSync.native(workingDirectory);
  const projects = listProjects().filter(p => p.enabled && p.type === "local" && !!p.root)
    .filter(p => inside(fs.realpathSync.native(p.root!), cwd))
    .sort((a,b) => b.root!.length - a.root!.length);
  if (!projects.length) return null; // detached Brain is not a project memory.
  const project = projects[0];
  const session = inspectBrainSession(owner, sessionId).path;
  const file = path.join(session, "project-provenance.json");
  assertNoSymlink(session, file);
  const provenance: Provenance = {
    version: 1, projectId: project.id, canonicalRoot: fs.realpathSync.native(project.root!),
    rmemoryProjectId: getRMemoryProjectId(project.root!), createdAt: new Date().toISOString(),
  };
  if (fs.existsSync(file)) {
    const saved = JSON.parse(fs.readFileSync(file, "utf8")) as Provenance;
    if (saved.projectId !== provenance.projectId || saved.canonicalRoot !== provenance.canonicalRoot ||
      saved.rmemoryProjectId !== provenance.rmemoryProjectId) {
      throw new Error("Brain project provenance cannot be reassigned to a different project.");
    }
    return saved;
  }
  fs.writeFileSync(file, JSON.stringify(provenance, null, 2), { flag: "wx", mode: 0o600 });
  return provenance;
}
export function verifyBrainProject(owner: string, sessionId: string, currentCwd: string): Provenance {
  const session = inspectBrainSession(owner, sessionId).path;
  const file = path.join(session, "project-provenance.json");
  assertNoSymlink(session, file);
  if (!fs.existsSync(file)) throw new Error("Detached Brain has no registered project provenance; cannot save project RMemory.");
  const saved = JSON.parse(fs.readFileSync(file, "utf8")) as Provenance;
  if (saved.version !== 1 || !saved.projectId || !saved.canonicalRoot) throw new Error("Invalid Brain project provenance.");
  const project = getProject(saved.projectId);
  if (!project || !project.enabled || project.type !== "local" || !project.root) throw new Error("Brain provenance project is no longer enabled.");
  const canonical = fs.realpathSync.native(project.root);
  if (canonical !== saved.canonicalRoot || getRMemoryProjectId(project.root) !== saved.rmemoryProjectId) {
    throw new Error("Project root changed since Brain binding.");
  }
  if (!inside(canonical, fs.realpathSync.native(currentCwd))) throw new Error("Active workspace differs from Brain project origin.");
  return saved;
}
