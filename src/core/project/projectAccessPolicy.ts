import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { getRootConfigDir } from "../config/paths.js";
import type { McpIdentity } from "../mcp/mcpAuth.js";

export const PROJECT_ACCESS_SCHEMA_VERSION = 1;
export const PROJECT_ACCESS_CAPABILITIES = [
  "read",
  "write",
  "execute",
  "git",
  "worktree",
  "planning",
  "chain",
] as const;
export type ProjectAccessCapability = typeof PROJECT_ACCESS_CAPABILITIES[number];
export type ProjectAccessIdentity = Pick<McpIdentity, "mode" | "subject"> & Partial<Pick<McpIdentity, "credentialHash">>;

interface ProjectAccessGrant {
  projectId: string;
  principalKey: string;
  capabilities: ProjectAccessCapability[];
  grantedAt: number;
  updatedAt: number;
}
interface ProjectAccessDocument {
  schemaVersion: number;
  grants: ProjectAccessGrant[];
}

export function getProjectAccessPolicyPath(customPath?: string): string {
  return customPath ? path.resolve(customPath) : path.join(getRootConfigDir(), "project-access.json");
}

/** Stable opaque principal: OAuth grants follow client ID; static bearer grants follow the bearer credential hash. */
export function getProjectPrincipalKey(identity: ProjectAccessIdentity): string {
  if (!identity || typeof identity.subject !== "string" || !identity.subject.trim()) {
    throw new Error("An authenticated MCP identity is required for project access.");
  }
  let principal: string;
  if (identity.mode === "static-bearer") {
    if (typeof identity.credentialHash !== "string" || !/^[a-f0-9]{64}$/i.test(identity.credentialHash)) {
      throw new Error("Static bearer project access requires the authenticated credential hash.");
    }
    principal = "static-bearer:" + identity.credentialHash.toLowerCase();
  } else {
    principal = "oauth:" + identity.subject;
  }
  return crypto.createHash("sha256").update(principal, "utf8").digest("hex");
}

function validateDocument(raw: unknown, filePath: string): ProjectAccessDocument {
  if (!raw || typeof raw !== "object") throw new Error(`Invalid MCP project access policy at ${filePath}: expected an object.`);
  const doc = raw as Partial<ProjectAccessDocument>;
  if (doc.schemaVersion !== PROJECT_ACCESS_SCHEMA_VERSION || !Array.isArray(doc.grants)) {
    throw new Error(`Invalid MCP project access policy at ${filePath}: unsupported schema or missing grants array.`);
  }
  const seen = new Set<string>();
  for (const grant of doc.grants) {
    if (!grant || typeof grant !== "object" || typeof grant.projectId !== "string"
      || !/^[a-z0-9](?:[a-z0-9-]{0,62})$/.test(grant.projectId)
      || typeof grant.principalKey !== "string" || !/^[a-f0-9]{64}$/.test(grant.principalKey)
      || !Array.isArray(grant.capabilities) || grant.capabilities.length === 0
      || grant.capabilities.some((capability) => !(PROJECT_ACCESS_CAPABILITIES as readonly string[]).includes(capability))
      || typeof grant.grantedAt !== "number" || !Number.isFinite(grant.grantedAt)
      || typeof grant.updatedAt !== "number" || !Number.isFinite(grant.updatedAt)) {
      throw new Error(`Invalid MCP project access policy at ${filePath}: malformed grant.`);
    }
    const key = `${grant.principalKey}:${grant.projectId}`;
    if (seen.has(key)) throw new Error(`Invalid MCP project access policy at ${filePath}: duplicate grant for project ${grant.projectId}.`);
    seen.add(key);
  }
  return doc as ProjectAccessDocument;
}

function readDocument(policyPath?: string): ProjectAccessDocument {
  const filePath = getProjectAccessPolicyPath(policyPath);
  if (!fs.existsSync(filePath)) return { schemaVersion: PROJECT_ACCESS_SCHEMA_VERSION, grants: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Invalid MCP project access policy JSON at ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return validateDocument(raw, filePath);
}

function writeDocument(doc: ProjectAccessDocument, policyPath?: string): void {
  const filePath = getProjectAccessPolicyPath(policyPath);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(doc, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try { fs.rmSync(tempPath, { force: true }); } catch {}
    throw new Error(`Could not write MCP project access policy at ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function listProjectAccess(identity: ProjectAccessIdentity, policyPath?: string) {
  const principalKey = getProjectPrincipalKey(identity);
  return readDocument(policyPath).grants
    .filter((grant) => grant.principalKey === principalKey)
    .map((grant) => ({ projectId: grant.projectId, capabilities: [...grant.capabilities], grantedAt: grant.grantedAt, updatedAt: grant.updatedAt }));
}

export function hasProjectAccess(
  identity: ProjectAccessIdentity | null | undefined,
  projectId: string,
  capability: ProjectAccessCapability,
  policyPath?: string,
): boolean {
  if (!identity) return false;
  const principalKey = getProjectPrincipalKey(identity);
  const grant = readDocument(policyPath).grants.find((item) => item.principalKey === principalKey && item.projectId === projectId);
  return Boolean(grant?.capabilities.includes(capability));
}

export function grantProjectAccess(
  identity: ProjectAccessIdentity,
  projectId: string,
  capabilities: ProjectAccessCapability[],
  policyPath?: string,
) {
  if (!identity || typeof identity.subject !== "string" || !identity.subject.trim()) throw new Error("An authenticated MCP identity is required to grant project access.");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62})$/.test(projectId)) throw new Error("A valid stable projectId is required.");
  if (!Array.isArray(capabilities) || capabilities.length === 0
    || capabilities.some((capability) => !(PROJECT_ACCESS_CAPABILITIES as readonly string[]).includes(capability))) {
    throw new Error(`capabilities must contain one or more of: ${PROJECT_ACCESS_CAPABILITIES.join(", ")}.`);
  }
  const doc = readDocument(policyPath);
  const principalKey = getProjectPrincipalKey(identity);
  const uniqueCapabilities = [...new Set(capabilities)].sort() as ProjectAccessCapability[];
  const existing = doc.grants.find((item) => item.principalKey === principalKey && item.projectId === projectId);
  const now = Date.now();
  if (existing) {
    existing.capabilities = uniqueCapabilities;
    existing.updatedAt = now;
  } else {
    doc.grants.push({ projectId, principalKey, capabilities: uniqueCapabilities, grantedAt: now, updatedAt: now });
  }
  writeDocument(doc, policyPath);
  return { projectId, capabilities: uniqueCapabilities, updated: Boolean(existing) };
}

export function revokeAllProjectAccess(projectId: string, policyPath?: string): number {
  const doc = readDocument(policyPath);
  const before = doc.grants.length;
  doc.grants = doc.grants.filter((item) => item.projectId !== projectId);
  const removed = before - doc.grants.length;
  if (removed > 0) writeDocument(doc, policyPath);
  return removed;
}

export function revokeProjectAccess(
  identity: ProjectAccessIdentity,
  projectId: string,
  policyPath?: string,
): boolean {
  if (!identity) throw new Error("An authenticated MCP identity is required to revoke project access.");
  const doc = readDocument(policyPath);
  const principalKey = getProjectPrincipalKey(identity);
  const index = doc.grants.findIndex((item) => item.principalKey === principalKey && item.projectId === projectId);
  if (index < 0) return false;
  doc.grants.splice(index, 1);
  writeDocument(doc, policyPath);
  return true;
}

export function getProjectCapabilityForTool(toolName: string, args: Record<string, unknown> = {}): ProjectAccessCapability {
  if (toolName === "superagent_exec_command" || toolName === "superagent_office_cli" || toolName === "superagent_cli_bridge") return "execute";
  if (toolName === "superagent_motion_render" || toolName === "superagent_motion_cancel") return "execute";
  if (toolName === "superagent_motion_create" || toolName === "superagent_motion_edit" ||
      toolName === "superagent_motion_import_image" || toolName === "superagent_motion_import_audio") return "write";
  if (toolName === "superagent_git_action") {
    const action = typeof args.action === "string" ? args.action : "";
    return ["status", "diff", "log"].includes(action) ? "read" : "git";
  }
  if (toolName === "superagent_manage_worktrees") return "worktree";
  if ([
    "superagent_write_file", "superagent_write_files", "superagent_replace_file_content", "superagent_multi_replace_file_content",
    "superagent_apply_patch", "superagent_unlock_file", "superagent_update_tasks", "superagent_manage_plan",
    "superagent_manage_tasks", "superagent_manage_workspace_chain", "superagent_cross_workspace_exec",
  ].includes(toolName)) {
    return toolName.includes("workspace_chain") || toolName === "superagent_cross_workspace_exec" ? "chain"
      : ["superagent_update_tasks", "superagent_manage_plan", "superagent_manage_tasks"].includes(toolName) ? "planning" : "write";
  }
  if (toolName === "superagent_switch_workspace" || toolName === "superagent_check_project_health") return "read";
  if (toolName === "superagent_get_current_task" || toolName === "superagent_get_instance_task"
    || toolName === "superagent_get_plan_and_tasks") return "planning";
  // Tools with no project argument are evaluated against their default workspace and retain their existing rules.
  void args;
  return "read";
}
