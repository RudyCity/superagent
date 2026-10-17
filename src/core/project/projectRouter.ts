import fs from "node:fs";
import path from "node:path";
import { getProject, listProjects, type RegisteredProject } from "./projectRegistry.js";

export type ProjectResolutionSource = "projectId" | "workspace" | "cwd" | "worktreePath" | "session";

export interface ResolveProjectTargetInput {
  projectId?: unknown;
  workspace?: unknown;
  cwd?: unknown;
  worktreePath?: unknown;
  sessionWorkspace: string;
  registryPath?: string;
}

export interface ResolvedProjectTarget {
  projectId: string | null;
  project: RegisteredProject | null;
  workspace: string;
  source: ProjectResolutionSource;
  explicit: boolean;
}

function isRemoteTarget(value: string): boolean {
  return /^(?:ssh:|chain:)/i.test(value);
}

function normalizeRemoteTarget(value: string): string {
  let normalized = value.trim().replaceAll("\\", "/");
  while (normalized.endsWith("/") && normalized.length > 1) normalized = normalized.slice(0, -1);
  return normalized.toLowerCase();
}

function pathKey(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isWithin(child: string, parent: string): boolean {
  const relative = path.relative(pathKey(parent), pathKey(child));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function canonicalDirectory(value: string): string {
  const resolved = path.resolve(value);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`Workspace target is not an existing directory: ${resolved}`);
  }
  return fs.realpathSync(resolved);
}

function findRemoteProject(target: string, projects: RegisteredProject[]): RegisteredProject | null {
  const key = normalizeRemoteTarget(target);
  return projects.find((project) => project.enabled && project.target && normalizeRemoteTarget(project.target) === key) ?? null;
}

function findLocalProject(target: string, projects: RegisteredProject[]): { project: RegisteredProject; canonicalTarget: string } {
  const canonicalTarget = canonicalDirectory(target);
  const localRoots = projects.filter((project) => project.type === "local" && project.root).flatMap((project) => {
    try {
      if (!fs.existsSync(project.root!) || !fs.statSync(project.root!).isDirectory()) return [];
      return [{ project, root: fs.realpathSync(project.root!) }];
    } catch {
      return [];
    }
  });
  const disabled = localRoots.find(({ project, root }) => !project.enabled && isWithin(canonicalTarget, root));
  if (disabled) throw new Error(`Project is disabled: ${disabled.project.id}`);
  const matches = localRoots.filter(({ project, root }) => project.enabled && isWithin(canonicalTarget, root));
  if (matches.length === 0) throw new Error(`Workspace target is not registered or authorized: ${canonicalTarget}`);
  if (matches.length > 1) throw new Error(`Workspace target is ambiguous across registered projects: ${canonicalTarget} (${matches.map(({ project }) => project.id).join(", ")})`);
  return { project: matches[0].project, canonicalTarget };
}

/**
 * Resolve a project/workspace for one MCP call. Explicit targets must map to
 * one enabled registry entry. An ambient session default remains backwards
 * compatible when it has not been registered; it does not grant extra access.
 */
export function resolveProjectTarget(input: ResolveProjectTargetInput): ResolvedProjectTarget {
  const projects = listProjects(input.registryPath);
  const explicitId = typeof input.projectId === "string" ? input.projectId.trim() : "";
  if (explicitId) {
    const project = getProject(explicitId, input.registryPath);
    if (!project) throw new Error(`Unknown project ID: ${explicitId}`);
    if (!project.enabled) throw new Error(`Project is disabled: ${project.id}`);
    if (project.type === "local") {
      const root = canonicalDirectory(project.root!);
      const requestedSubtarget = [input.workspace, input.cwd, input.worktreePath]
        .find((value) => typeof value === "string" && value.trim()) as string | undefined;
      if (!requestedSubtarget) return { projectId: project.id, project, workspace: root, source: "projectId", explicit: true };
      if (isRemoteTarget(requestedSubtarget)) throw new Error(`Project ${project.id} is local but the requested workspace is remote.`);
      const rawSubtarget = requestedSubtarget.trim();
      const candidate = path.isAbsolute(rawSubtarget) ? rawSubtarget : path.resolve(root, rawSubtarget);
      const canonicalTarget = canonicalDirectory(candidate);
      if (!isWithin(canonicalTarget, root)) throw new Error(`Workspace target escapes registered project ${project.id}: ${canonicalTarget}`);
      return { projectId: project.id, project, workspace: canonicalTarget, source: "projectId", explicit: true };
    }
    const requestedRemoteTarget = [input.workspace, input.cwd, input.worktreePath]
      .find((value) => typeof value === "string" && value.trim()) as string | undefined;
    if (requestedRemoteTarget && normalizeRemoteTarget(requestedRemoteTarget) !== normalizeRemoteTarget(project.target!)) {
      throw new Error(`Workspace target does not match registered project ${project.id}.`);
    }
    return { projectId: project.id, project, workspace: project.target!, source: "projectId", explicit: true };
  }

  const explicitWorkspace = [
    ["workspace", input.workspace],
    ["cwd", input.cwd],
    ["worktreePath", input.worktreePath],
  ] as const;
  for (const [source, value] of explicitWorkspace) {
    if (typeof value !== "string" || !value.trim()) continue;
    const rawTarget = value.trim();
    const target = isRemoteTarget(rawTarget)
      ? rawTarget
      : path.isAbsolute(rawTarget) ? rawTarget : path.resolve(input.sessionWorkspace, rawTarget);
    if (isRemoteTarget(target)) {
      const project = findRemoteProject(target, projects);
      if (!project) throw new Error(`Workspace target is not registered: ${target}`);
      if (!project.enabled) throw new Error(`Project is disabled: ${project.id}`);
      return { projectId: project.id, project, workspace: project.target!, source, explicit: true };
    }
    const { project, canonicalTarget } = findLocalProject(target, projects);
    return { projectId: project.id, project, workspace: canonicalTarget, source, explicit: true };
  }

  const sessionWorkspace = input.sessionWorkspace.trim() || process.cwd();
  if (isRemoteTarget(sessionWorkspace)) {
    const project = findRemoteProject(sessionWorkspace, projects);
    return {
      projectId: project?.enabled ? project.id : null,
      project: project?.enabled ? project : null,
      workspace: sessionWorkspace,
      source: "session",
      explicit: false,
    };
  }
  let canonicalSession = path.resolve(sessionWorkspace);
  try { canonicalSession = canonicalDirectory(sessionWorkspace); } catch { /* Keep the configured default for a later actionable tool error. */ }
  const ambientMatches = projects.filter((project) => {
    if (!project.enabled || project.type !== "local" || !project.root) return false;
    try { return fs.existsSync(project.root) && isWithin(canonicalSession, fs.realpathSync(project.root)); } catch { return false; }
  });
  const selected = ambientMatches.length === 1 ? ambientMatches[0] : null;
  return {
    projectId: selected?.id ?? null,
    project: selected,
    workspace: canonicalSession,
    source: "session",
    explicit: false,
  };
}

/** Resolve a local file path and ensure it stays within its registered root. */
export function assertPathWithinProject(filePath: string, projectRoot: string): string {
  const resolved = path.resolve(projectRoot, filePath);
  const root = fs.realpathSync(projectRoot);
  let checked = resolved;
  if (fs.existsSync(resolved)) {
    checked = fs.realpathSync(resolved);
  } else {
    let parent = path.dirname(resolved);
    while (parent !== path.dirname(parent) && !fs.existsSync(parent)) parent = path.dirname(parent);
    if (fs.existsSync(parent)) {
      const canonicalParent = fs.realpathSync(parent);
      if (!isWithin(canonicalParent, root)) throw new Error(`Path escapes registered project root: ${filePath}`);
    }
  }
  if (!isWithin(checked, root)) throw new Error(`Path escapes registered project root: ${filePath}`);
  return resolved;
}
