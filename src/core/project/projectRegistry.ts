import fs from "node:fs";
import path from "node:path";
import { getRootConfigDir } from "../config/paths.js";
import { getWorkspaceChain } from "../workspace/WorkspaceChainConfig.js";

export const PROJECT_REGISTRY_SCHEMA_VERSION = 1;
export type RegisteredProjectType = "local" | "ssh" | "chain";

export interface RegisteredProject {
  id: string;
  name: string;
  type: RegisteredProjectType;
  /** Canonical absolute root for local projects. */
  root?: string;
  /** Credential-free SSH target or a `chain:<id>` reference. */
  target?: string;
  description?: string;
  tags: string[];
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface RegisterProjectInput {
  id?: string;
  name: string;
  type: RegisteredProjectType;
  root?: string;
  target?: string;
  description?: string;
  tags?: string[];
  enabled?: boolean;
}

export type UpdateProjectInput = Partial<Pick<RegisteredProject, "name" | "root" | "target" | "description" | "tags" | "enabled">>;

interface ProjectRegistryDocument {
  schemaVersion: number;
  projects: RegisteredProject[];
}

export function getProjectRegistryPath(customPath?: string): string {
  return customPath ? path.resolve(customPath) : path.join(getRootConfigDir(), "projects.json");
}

function normalizeId(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63);
}

function pathKey(value: string): string {
  const resolved = path.resolve(value).replace(/[\/]+$/, "") || path.parse(value).root;
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function normalizeProject(input: RegisterProjectInput, now: number, idOverride?: string): RegisteredProject {
  if (!input || typeof input !== "object") throw new Error("Project input must be an object.");
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name || name.length > 120) throw new Error("Project name is required and must be at most 120 characters.");
  const id = idOverride || normalizeId(input.id || name);
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62})$/.test(id)) {
    throw new Error("Project ID must contain 1-63 lowercase letters, digits, or hyphens and begin with a letter or digit.");
  }
  if (!["local", "ssh", "chain"].includes(input.type)) throw new Error("Project type must be local, ssh, or chain.");

  let root: string | undefined;
  let target: string | undefined;
  if (input.type === "local") {
    if (typeof input.root !== "string" || !input.root.trim()) throw new Error("Local projects require a root directory.");
    const resolved = path.resolve(input.root.trim());
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      throw new Error(`Local project root must be an existing directory: ${resolved}`);
    }
    root = fs.realpathSync(resolved);
  } else if (input.type === "ssh") {
    if (typeof input.target !== "string" || !input.target.trim()) throw new Error("SSH projects require a credential-free target URI.");
    const raw = input.target.trim();
    let parsed: URL;
    try { parsed = new URL(raw); } catch { throw new Error("SSH project target must be a valid ssh:// URI."); }
    if (parsed.protocol !== "ssh:" || !parsed.hostname || parsed.password || parsed.search || parsed.hash) {
      throw new Error("SSH project target must not contain passwords, credential query parameters, or fragments.");
    }
    target = parsed.toString().replace(/\/$/, "") || parsed.toString();
  } else {
    const raw = typeof input.target === "string" ? input.target.trim() : "";
    if (!/^chain:[a-z0-9][a-z0-9-]{0,62}$/i.test(raw)) throw new Error("Chain projects require a target in the form chain:<chain-id>.");
    target = `chain:${raw.slice("chain:".length).toLowerCase()}`;
  }

  const description = input.description?.trim();
  if (description && description.length > 500) throw new Error("Project description must be at most 500 characters.");
  const tags = input.tags ?? [];
  if (!Array.isArray(tags) || tags.length > 30 || tags.some((tag) => typeof tag !== "string" || !tag.trim() || tag.length > 40)) {
    throw new Error("Project tags must be up to 30 non-empty strings, each at most 40 characters.");
  }

  return {
    id,
    name,
    type: input.type,
    ...(root ? { root } : {}),
    ...(target ? { target } : {}),
    ...(description ? { description } : {}),
    tags: [...new Set(tags.map((tag) => tag.trim().toLowerCase()))],
    enabled: input.enabled ?? true,
    createdAt: now,
    updatedAt: now,
  };
}

function readRegistry(registryPath?: string): ProjectRegistryDocument {
  const filePath = getProjectRegistryPath(registryPath);
  if (!fs.existsSync(filePath)) return { schemaVersion: PROJECT_REGISTRY_SCHEMA_VERSION, projects: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Invalid MCP project registry JSON at ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!raw || typeof raw !== "object") throw new Error(`Invalid MCP project registry at ${filePath}: expected an object.`);
  const document = raw as Partial<ProjectRegistryDocument>;
  if (document.schemaVersion !== PROJECT_REGISTRY_SCHEMA_VERSION || !Array.isArray(document.projects)) {
    throw new Error(`Invalid MCP project registry at ${filePath}: unsupported schema or missing projects array.`);
  }
  const ids = new Set<string>();
  for (const project of document.projects) {
    if (!project || typeof project !== "object" || typeof project.id !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,62})$/.test(project.id)) {
      throw new Error(`Invalid MCP project registry at ${filePath}: malformed project record.`);
    }
    if (ids.has(project.id)) throw new Error(`Invalid MCP project registry at ${filePath}: duplicate project ID ${project.id}.`);
    ids.add(project.id);
    const allowedKeys = new Set(["id", "name", "type", "root", "target", "description", "tags", "enabled", "createdAt", "updatedAt"]);
    const unexpectedKeys = Object.keys(project).filter((key) => !allowedKeys.has(key));
    if (unexpectedKeys.length > 0) {
      throw new Error(`Invalid MCP project registry at ${filePath}: project ${project.id} contains unsupported fields (${unexpectedKeys.join(", ")}).`);
    }
    if (typeof project.name !== "string" || !project.name.trim() || project.name.length > 120
      || !["local", "ssh", "chain"].includes(project.type) || typeof project.enabled !== "boolean"
      || !Array.isArray(project.tags) || project.tags.length > 30
      || project.tags.some((tag) => typeof tag !== "string" || !tag.trim() || tag.length > 40)
      || (project.description !== undefined && (typeof project.description !== "string" || project.description.length > 500))
      || typeof project.createdAt !== "number" || !Number.isFinite(project.createdAt)
      || typeof project.updatedAt !== "number" || !Number.isFinite(project.updatedAt)) {
      throw new Error(`Invalid MCP project registry at ${filePath}: invalid fields for project ${project.id}.`);
    }
    if (project.type === "local" && (typeof project.root !== "string" || !path.isAbsolute(project.root) || project.target !== undefined)) {
      throw new Error(`Invalid MCP project registry at ${filePath}: local project ${project.id} must have only an absolute root.`);
    }
    if (project.type === "ssh") {
      if (typeof project.target !== "string") throw new Error(`Invalid MCP project registry at ${filePath}: SSH project ${project.id} must have a target.`);
      let parsed: URL;
      try { parsed = new URL(project.target); } catch { throw new Error(`Invalid MCP project registry at ${filePath}: SSH project ${project.id} has an invalid target URI.`); }
      if (parsed.protocol !== "ssh:" || !parsed.hostname || parsed.password || parsed.search || parsed.hash || project.root !== undefined) {
        throw new Error(`Invalid MCP project registry at ${filePath}: SSH project ${project.id} has an unsafe target URI.`);
      }
    }
    if (project.type === "chain" && (typeof project.target !== "string" || !/^chain:[a-z0-9][a-z0-9-]{0,62}$/i.test(project.target) || project.root !== undefined)) {
      throw new Error(`Invalid MCP project registry at ${filePath}: chain project ${project.id} has an invalid target.`);
    }
  }
  return document as ProjectRegistryDocument;
}

function writeRegistry(document: ProjectRegistryDocument, registryPath?: string): void {
  const filePath = getProjectRegistryPath(registryPath);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try { fs.rmSync(tempPath, { force: true }); } catch {}
    throw new Error(`Could not write MCP project registry at ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function listProjects(registryPath?: string): RegisteredProject[] {
  return readRegistry(registryPath).projects.map((project) => ({ ...project, tags: [...project.tags] }));
}

export function getProject(id: string, registryPath?: string): RegisteredProject | null {
  const normalized = typeof id === "string" ? id.trim().toLowerCase() : "";
  return listProjects(registryPath).find((project) => project.id === normalized) ?? null;
}

export function registerProject(input: RegisterProjectInput, registryPath?: string): RegisteredProject {
  const document = readRegistry(registryPath);
  const candidateId = normalizeId(input.id || input.name || "");
  if (document.projects.some((existing) => existing.id === candidateId)) {
    throw new Error(`Project ID already exists: ${candidateId}`);
  }
  const now = Date.now();
  const project = normalizeProject(input, now);
  if (project.type === "chain") {
    const chainId = project.target!.slice("chain:".length);
    if (!getWorkspaceChain(chainId, undefined, false)) {
      throw new Error(`Workspace Chain does not exist and cannot be registered: ${chainId}`);
    }
  }
  if (project.type === "local" && document.projects.some((existing) => existing.type === "local" && existing.root && project.root && pathKey(existing.root) === pathKey(project.root))) {
    throw new Error(`Project root already registered: ${project.root}`);
  }
  document.projects.push(project);
  writeRegistry(document, registryPath);
  return project;
}

export function updateProject(id: string, updates: UpdateProjectInput, registryPath?: string): RegisteredProject {
  const document = readRegistry(registryPath);
  const index = document.projects.findIndex((project) => project.id === id.trim().toLowerCase());
  if (index < 0) throw new Error(`Project not found: ${id}`);
  const existing = document.projects[index];
  if (existing.type === "chain" && typeof updates.target === "string") {
    const target = updates.target.trim();
    const chainId = target.startsWith("chain:") ? target.slice("chain:".length) : "";
    if (!chainId || !getWorkspaceChain(chainId, undefined, false)) {
      throw new Error(`Workspace Chain does not exist and cannot be assigned: ${target}`);
    }
  }
  const normalized = normalizeProject({
    id: existing.id,
    name: updates.name ?? existing.name,
    type: existing.type,
    root: updates.root ?? existing.root,
    target: updates.target ?? existing.target,
    description: updates.description ?? existing.description,
    tags: updates.tags ?? existing.tags,
    enabled: updates.enabled ?? existing.enabled,
  }, Date.now(), existing.id);
  if (normalized.type === "local" && document.projects.some((other) => other.id !== existing.id && other.type === "local" && other.root && normalized.root && pathKey(other.root) === pathKey(normalized.root))) {
    throw new Error(`Project root already registered: ${normalized.root}`);
  }
  normalized.createdAt = existing.createdAt;
  document.projects[index] = normalized;
  writeRegistry(document, registryPath);
  return normalized;
}

export function removeProject(id: string, registryPath?: string): boolean {
  const document = readRegistry(registryPath);
  const index = document.projects.findIndex((project) => project.id === id.trim().toLowerCase());
  if (index < 0) return false;
  document.projects.splice(index, 1);
  writeRegistry(document, registryPath);
  return true;
}
