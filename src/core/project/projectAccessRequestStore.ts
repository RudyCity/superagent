/**
 * projectAccessRequestStore.ts - Persistent Project Access Request Broker for SuperAgent MCP.
 *
 * Implements the Broker architecture:
 * Agent -> Access Request -> SuperAgent Access Broker -> Human Approval in Trusted Tray -> Persistent Grant Store
 *
 * SECURITY INVARIANTS:
 * - Agents CANNOT approve requests or grant permissions to themselves.
 * - Access requests are strictly pending until human approval is recorded from the trusted host UI.
 * - Requests are bound to validated, stable MCP identities (subject, mode, credentialHash).
 * - Target paths are canonicalized; directory traversal (..) and junction/symlink escapes are rejected.
 * - Grants are persisted to project-access.json via projectAccessPolicy.
 * - Corrupted request files fail closed safely.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { getRootConfigDir } from "../config/paths.js";
import {
  type ProjectAccessCapability,
  type ProjectAccessIdentity,
  PROJECT_ACCESS_CAPABILITIES,
  grantProjectAccess,
  revokeProjectAccess,
  hasProjectAccess,
  listProjectAccess,
} from "./projectAccessPolicy.js";
import { getProject, listProjects, type RegisteredProject } from "./projectRegistry.js";
import { deriveIdentityHandle } from "../mcp/mcpIdentityPresence.js";

export const MCP_CONNECTION_PROJECT_ID = "mcp-connection";
export const MCP_CONNECTION_PROJECT_PATH = "mcp://connection";
const MCP_CONNECTION_PROJECT_NAME = "MCP Connection Controls";

export const PROJECT_ACCESS_REQUEST_SCHEMA_VERSION = 1;
export const MAX_STORED_REQUESTS = 200;

export type AccessRequestStatus = "pending" | "approved" | "denied" | "revoked";

export interface ProjectAccessRequest {
  requestId: string;
  identityHandle: string;
  subject: string;
  mode: "oauth" | "static-bearer";
  credentialHash?: string;
  projectId: string;
  projectName: string;
  projectPath: string;
  capabilities: ProjectAccessCapability[];
  reason: string;
  status: AccessRequestStatus;
  createdAt: number;
  decidedAt?: number;
  decidedBy?: string;
  decisionReason?: string;
}

interface ProjectAccessRequestDocument {
  schemaVersion: number;
  requests: ProjectAccessRequest[];
}

export function getProjectAccessRequestFilePath(customPath?: string): string {
  return customPath ? path.resolve(customPath) : path.join(getRootConfigDir(), "project-access-requests.json");
}

function canonicalizePath(targetPath: string): string | null {
  if (!targetPath || typeof targetPath !== "string") return null;
  const trimmed = targetPath.trim();
  if (!trimmed || trimmed.includes("\0") || /[\r\n]/.test(trimmed)) return null;
  const resolved = path.resolve(trimmed);
  try {
    if (fs.existsSync(resolved)) {
      return fs.realpathSync(resolved);
    }
  } catch {
    return null;
  }
  return resolved;
}

function validateDocument(raw: unknown, filePath: string): ProjectAccessRequestDocument {
  if (!raw || typeof raw !== "object") {
    throw new Error(`Invalid project access requests file at ${filePath}: expected an object.`);
  }
  const doc = raw as Partial<ProjectAccessRequestDocument>;
  if (doc.schemaVersion !== PROJECT_ACCESS_REQUEST_SCHEMA_VERSION || !Array.isArray(doc.requests)) {
    throw new Error(`Invalid project access requests file at ${filePath}: unsupported schema or missing requests array.`);
  }
  const validRequests: ProjectAccessRequest[] = [];
  for (const r of doc.requests) {
    if (
      r &&
      typeof r.requestId === "string" &&
      typeof r.identityHandle === "string" &&
      typeof r.subject === "string" &&
      (r.mode === "oauth" || r.mode === "static-bearer") &&
      typeof r.projectId === "string" &&
      typeof r.projectPath === "string" &&
      Array.isArray(r.capabilities) &&
      typeof r.reason === "string" &&
      ["pending", "approved", "denied", "revoked"].includes(r.status) &&
      typeof r.createdAt === "number"
    ) {
      validRequests.push(r as ProjectAccessRequest);
    }
  }
  return { schemaVersion: PROJECT_ACCESS_REQUEST_SCHEMA_VERSION, requests: validRequests };
}

export function readAccessRequests(filePathCustom?: string): ProjectAccessRequestDocument {
  const filePath = getProjectAccessRequestFilePath(filePathCustom);
  if (!fs.existsSync(filePath)) {
    return { schemaVersion: PROJECT_ACCESS_REQUEST_SCHEMA_VERSION, requests: [] };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return validateDocument(raw, filePath);
  } catch (error) {
    // Fail-safe: corrupted file is logged and a safe fallback returned without crashing
    console.warn(`[AccessBroker] Could not read access requests at ${filePath}:`, error);
    return { schemaVersion: PROJECT_ACCESS_REQUEST_SCHEMA_VERSION, requests: [] };
  }
}

export function writeAccessRequests(doc: ProjectAccessRequestDocument, filePathCustom?: string): void {
  const filePath = getProjectAccessRequestFilePath(filePathCustom);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(doc, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try { fs.rmSync(tempPath, { force: true }); } catch {}
    throw new Error(`Could not write project access requests file at ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export interface CreateAccessRequestInput {
  projectId?: string;
  projectPath?: string;
  capabilities: ProjectAccessCapability[];
  reason: string;
}

export interface AccessRequestResult {
  requestId: string;
  projectId: string;
  projectName: string;
  projectPath: string;
  requestedCapabilities: ProjectAccessCapability[];
  status: AccessRequestStatus;
  code: "APPROVAL_PENDING" | "ALREADY_GRANTED" | "INVALID_REQUEST";
  message: string;
}

/**
 * Creates an auditable access request from an authenticated MCP identity.
 * Does NOT grant permissions. Returns diagnostic status APPROVAL_PENDING.
 */
export function createProjectAccessRequest(
  identity: ProjectAccessIdentity,
  input: CreateAccessRequestInput,
  options?: { requestStorePath?: string; policyPath?: string; projectsPath?: string },
): AccessRequestResult {
  if (!identity || typeof identity.subject !== "string" || !identity.subject.trim()) {
    throw new Error("An authenticated MCP identity is required to request project access.");
  }
  if (!Array.isArray(input.capabilities) || input.capabilities.length === 0) {
    throw new Error(`capabilities must contain at least one of: ${PROJECT_ACCESS_CAPABILITIES.join(", ")}.`);
  }
  const invalidCaps = input.capabilities.filter(c => !(PROJECT_ACCESS_CAPABILITIES as readonly string[]).includes(c));
  if (invalidCaps.length > 0) {
    throw new Error(`Invalid capabilities requested: ${invalidCaps.join(", ")}.`);
  }
  if (input.projectId === MCP_CONNECTION_PROJECT_ID && input.capabilities.some(cap => cap !== "execute")) {
    throw new Error("MCP Connection Controls accepts only the execute capability.");
  }
  const cleanReason = String(input.reason || "").trim();
  if (cleanReason.length < 5) {
    throw new Error("A meaningful human-readable reason (at least 5 characters) is required.");
  }

  const projects = listProjects(options?.projectsPath);
  // Virtual security resource for non-project MCP actions (desktop, LAN, service control).
  // This has no filesystem root, so it can never authorize project file access.
  if (input.projectId === MCP_CONNECTION_PROJECT_ID && input.projectPath) {
    throw new Error("MCP connection controls cannot be requested by filesystem path.");
  }
  let resolvedProject: RegisteredProject | null = input.projectId === MCP_CONNECTION_PROJECT_ID
    ? {
        id: MCP_CONNECTION_PROJECT_ID,
        name: MCP_CONNECTION_PROJECT_NAME,
        type: "chain",
        target: MCP_CONNECTION_PROJECT_PATH,
        tags: [],
        enabled: true,
        createdAt: 0,
        updatedAt: 0,
      }
    : input.projectId ? getProject(input.projectId, options?.projectsPath) : null;

  if (!resolvedProject && input.projectPath) {
    const canonicalReq = canonicalizePath(input.projectPath);
    if (canonicalReq) {
      resolvedProject = projects.find(p => p.enabled && p.type === "local" && p.root && canonicalizePath(p.root) === canonicalReq) || null;
    }
  }

  if (!resolvedProject) {
    // If not matching an existing registered project, check if projectPath is an existing directory
    if (input.projectPath) {
      const canonicalReq = canonicalizePath(input.projectPath);
      if (!canonicalReq || !fs.existsSync(canonicalReq) || !fs.statSync(canonicalReq).isDirectory()) {
        throw new Error(`Project target directory does not exist or is inaccessible: ${input.projectPath}`);
      }
      // Generate synthetic ID from directory basename
      const baseName = path.basename(canonicalReq).toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 50) || "local-project";
      resolvedProject = {
        id: `auto-${baseName}`,
        name: path.basename(canonicalReq),
        type: "local",
        root: canonicalReq,
        tags: [],
        enabled: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
    } else {
      throw new Error(`Project '${input.projectId || ""}' was not found in registered projects.`);
    }
  }

  if (!resolvedProject) {
    throw new Error(`Project '${input.projectId || ""}' was not found in registered projects.`);
  }

  const project: RegisteredProject = resolvedProject;
  if (!project.enabled) {
    throw new Error(`Project '${project.id}' is disabled in the project registry.`);
  }

  const capabilities = [...new Set(input.capabilities)].sort() as ProjectAccessCapability[];
  const projectPath = project.root || project.target || "";

  // Check if identity ALREADY has all requested capabilities
  const allGranted = capabilities.every(cap => hasProjectAccess(identity, project.id, cap, options?.policyPath));
  if (allGranted) {
    return {
      requestId: `granted_${project.id}`,
      projectId: project.id,
      projectName: project.name,
      projectPath,
      requestedCapabilities: capabilities,
      status: "approved",
      code: "ALREADY_GRANTED",
      message: `The authenticated MCP identity already has all requested capabilities on project '${project.name}'.`,
    };
  }

  const identityHandle = deriveIdentityHandle(identity);
  const doc = readAccessRequests(options?.requestStorePath);

  // Check for an existing pending request for the same identity and project
  const existingPending = doc.requests.find(
    r => r.status === "pending" && r.identityHandle === identityHandle && r.projectId === project.id
  );

  if (existingPending) {
    // Update capabilities and reason
    existingPending.capabilities = [...new Set([...existingPending.capabilities, ...capabilities])].sort() as ProjectAccessCapability[];
    existingPending.reason = cleanReason;
    existingPending.createdAt = Date.now();
    writeAccessRequests(doc, options?.requestStorePath);
    return {
      requestId: existingPending.requestId,
      projectId: project.id,
      projectName: project.name,
      projectPath,
      requestedCapabilities: existingPending.capabilities,
      status: "pending",
      code: "APPROVAL_PENDING",
      message: `Project access request updated. A human operator must approve this request in SuperAgent Tray (Security Approval Manager) before capabilities are granted.`,
    };
  }

  const newRequestId = `req_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const newRequest: ProjectAccessRequest = {
    requestId: newRequestId,
    identityHandle,
    subject: identity.subject,
    mode: identity.mode,
    credentialHash: identity.credentialHash,
    projectId: project.id,
    projectName: project.name,
    projectPath,
    capabilities,
    reason: cleanReason,
    status: "pending",
    createdAt: Date.now(),
  };

  doc.requests.unshift(newRequest);
  if (doc.requests.length > MAX_STORED_REQUESTS) {
    doc.requests = doc.requests.slice(0, MAX_STORED_REQUESTS);
  }
  writeAccessRequests(doc, options?.requestStorePath);

  return {
    requestId: newRequestId,
    projectId: project.id,
    projectName: project.name,
    projectPath,
    requestedCapabilities: capabilities,
    status: "pending",
    code: "APPROVAL_PENDING",
    message: `Project access request submitted successfully. A human operator must approve this request in SuperAgent Tray (Security Approval Manager) before capabilities are granted.`,
  };
}

/**
 * Human approval action: approves a pending request and creates the persistent grant.
 * Must originate from a trusted local human-controlled interface (Tray UI).
 */
export function approveProjectAccessRequest(
  requestId: string,
  options?: {
    approvedCapabilities?: ProjectAccessCapability[];
    decidedBy?: string;
    requestStorePath?: string;
    policyPath?: string;
    projectsPath?: string;
  },
): { success: true; request: ProjectAccessRequest; grant: { projectId: string; capabilities: ProjectAccessCapability[] } } {
  const doc = readAccessRequests(options?.requestStorePath);
  const req = doc.requests.find(r => r.requestId === requestId);
  if (!req) {
    throw new Error(`Access request not found: ${requestId}`);
  }
  if (req.status !== "pending") {
    throw new Error(`Access request ${requestId} cannot be approved: current status is '${req.status}'.`);
  }

  // Approval may narrow a request, never silently expand it.
  if (options?.approvedCapabilities && (
    options.approvedCapabilities.length === 0 ||
    options.approvedCapabilities.some(cap => !req.capabilities.includes(cap))
  )) {
    throw new Error("Approved capabilities must be a non-empty subset of requested capabilities.");
  }
  const capabilitiesToGrant = options?.approvedCapabilities ?? req.capabilities;

  // A pending request is not authority over a later changed/disabled project.
  if (req.projectId === MCP_CONNECTION_PROJECT_ID) {
    if (req.projectPath !== MCP_CONNECTION_PROJECT_PATH) {
      throw new Error("Invalid MCP connection approval target.");
    }
  } else {
    const currentProject = getProject(req.projectId, options?.projectsPath);
    if (!currentProject || !currentProject.enabled ||
        (currentProject.root || currentProject.target || "") !== req.projectPath) {
      throw new Error("Requested project no longer matches an enabled registered project.");
    }
  }

  const identity: ProjectAccessIdentity = {
    mode: req.mode,
    subject: req.subject,
    credentialHash: req.credentialHash,
  };

  const grant = grantProjectAccess(identity, req.projectId, capabilitiesToGrant, options?.policyPath);

  req.status = "approved";
  req.capabilities = grant.capabilities;
  req.decidedAt = Date.now();
  req.decidedBy = options?.decidedBy || "human-tray";
  writeAccessRequests(doc, options?.requestStorePath);

  return { success: true, request: req, grant };
}

/**
 * Human denial action: denies a pending access request.
 */
export function denyProjectAccessRequest(
  requestId: string,
  reason?: string,
  options?: { decidedBy?: string; requestStorePath?: string },
): { success: true; request: ProjectAccessRequest } {
  const doc = readAccessRequests(options?.requestStorePath);
  const req = doc.requests.find(r => r.requestId === requestId);
  if (!req) {
    throw new Error(`Access request not found: ${requestId}`);
  }
  if (req.status !== "pending") {
    throw new Error(`Access request ${requestId} cannot be denied: current status is '${req.status}'.`);
  }

  req.status = "denied";
  req.decidedAt = Date.now();
  req.decidedBy = options?.decidedBy || "human-tray";
  req.decisionReason = reason || "Denied by operator in SuperAgent Tray";
  writeAccessRequests(doc, options?.requestStorePath);

  return { success: true, request: req };
}

/**
 * Human revocation action: revokes an approved access grant and updates request status.
 */
export function revokeProjectAccessRequest(
  requestId: string,
  options?: { decidedBy?: string; requestStorePath?: string; policyPath?: string },
): { success: true; request: ProjectAccessRequest; revoked: boolean } {
  const doc = readAccessRequests(options?.requestStorePath);
  const req = doc.requests.find(r => r.requestId === requestId);
  if (!req) {
    throw new Error(`Access request not found: ${requestId}`);
  }

  const identity: ProjectAccessIdentity = {
    mode: req.mode,
    subject: req.subject,
    credentialHash: req.credentialHash,
  };

  const revoked = revokeProjectAccess(identity, req.projectId, options?.policyPath);

  req.status = "revoked";
  req.decidedAt = Date.now();
  req.decidedBy = options?.decidedBy || "human-tray";
  writeAccessRequests(doc, options?.requestStorePath);

  return { success: true, request: req, revoked };
}

/**
 * Direct human grant: allows operator to directly grant scoped project capabilities
 * to an authenticated MCP identity from the SuperAgent Tray UI.
 */
export function grantProjectAccessToIdentity(
  identity: ProjectAccessIdentity,
  projectId: string,
  capabilities: ProjectAccessCapability[],
  options?: { decidedBy?: string; requestStorePath?: string; policyPath?: string },
): ProjectAccessRequest {
  if (projectId === MCP_CONNECTION_PROJECT_ID &&
      (capabilities.length !== 1 || capabilities[0] !== "execute")) {
    throw new Error("MCP Connection Controls can only grant the execute capability.");
  }
  const project = projectId === MCP_CONNECTION_PROJECT_ID
    ? { name: MCP_CONNECTION_PROJECT_NAME, root: undefined, target: MCP_CONNECTION_PROJECT_PATH, enabled: true }
    : getProject(projectId);
  if (!project || !project.enabled) {
    throw new Error("Direct grant requires an enabled registered project or MCP connection controls.");
  }
  const grant = grantProjectAccess(identity, projectId, capabilities, options?.policyPath);
  const identityHandle = deriveIdentityHandle(identity);
  const doc = readAccessRequests(options?.requestStorePath);
  const newRequest: ProjectAccessRequest = {
    requestId: `direct_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
    identityHandle,
    subject: identity.subject,
    mode: identity.mode,
    credentialHash: identity.credentialHash,
    projectId,
    projectName: project?.name || projectId,
    projectPath: project?.root || project?.target || "",
    capabilities: grant.capabilities,
    reason: "Direct grant approved by operator in SuperAgent Tray",
    status: "approved",
    createdAt: Date.now(),
    decidedAt: Date.now(),
    decidedBy: options?.decidedBy || "human-tray",
  };
  doc.requests.unshift(newRequest);
  writeAccessRequests(doc, options?.requestStorePath);
  return newRequest;
}

/**
 * Cross-process discovery for identities that have authenticated and filed a
 * recent access request. Reuses the existing protected request store rather
 * than persisting all MCP connection tokens or bearer-derived identities.
 */
export function listRequestedMcpIdentityCandidates(now = Date.now()): Array<{
  identityHandle: string; subject: string; mode: "oauth" | "static-bearer";
  scopes: string[]; lastSeenAt: number;
}> {
  const latest = new Map<string, { identityHandle: string; subject: string;
    mode: "oauth" | "static-bearer"; scopes: string[]; lastSeenAt: number }>();
  for (const req of readAccessRequests().requests) {
    if (!Number.isFinite(req.createdAt) || req.createdAt > now ||
        now - req.createdAt > 4 * 60 * 60 * 1000) continue;
    const identity: ProjectAccessIdentity = { mode: req.mode, subject: req.subject, credentialHash: req.credentialHash };
    if (deriveIdentityHandle(identity) !== req.identityHandle) continue;
    if (!latest.has(req.identityHandle)) {
      latest.set(req.identityHandle, {
        identityHandle: req.identityHandle, subject: req.subject,
        mode: req.mode, scopes: [], lastSeenAt: req.createdAt,
      });
    }
  }
  return [...latest.values()];
}

export function getRequestedMcpIdentityByHandle(handle: string, now = Date.now()): ProjectAccessIdentity | null {
  if (!/^idh_[a-f0-9]{16}$/.test(handle)) return null;
  for (const req of readAccessRequests().requests) {
    if (req.identityHandle !== handle || !Number.isFinite(req.createdAt) ||
        req.createdAt > now || now - req.createdAt > 4 * 60 * 60 * 1000) continue;
    const identity: ProjectAccessIdentity = { mode: req.mode, subject: req.subject, credentialHash: req.credentialHash };
    if (deriveIdentityHandle(identity) === handle) return identity;
  }
  return null;
}

/**
 * Lists stored project access requests with optional status / identity filtering.
 */
export function listProjectAccessRequests(
  filter?: { status?: AccessRequestStatus; identityHandle?: string; projectId?: string },
  filePathCustom?: string,
): ProjectAccessRequest[] {
  const doc = readAccessRequests(filePathCustom);
  return doc.requests.filter(r => {
    if (filter?.status && r.status !== filter.status) return false;
    if (filter?.identityHandle && r.identityHandle !== filter.identityHandle) return false;
    if (filter?.projectId && r.projectId !== filter.projectId) return false;
    return true;
  });
}
