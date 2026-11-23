/**
 * mcpToolPreflight.ts — Unified Tool Preflight Engine for SuperAgent MCP.
 *
 * Implements the non-executing preflight gate that validates all 10 checkpoints
 * before any action is executed:
 * 1. Tool and action
 * 2. Schema and arguments
 * 3. OAuth
 * 4. Project grants
 * 5. Host file-policy
 * 6. Native/operator approval
 * 7. Dependency
 * 8. Service availability
 * 9. Target/profile/session
 * 10. Lease and revision
 */

import path from "node:path";
import fs from "node:fs/promises";
import { MCP_TOOL_DEFINITIONS } from "./superagentMcpServer.js";
import { DISABLED_MCP_TOOLS } from "./mcpToolPolicy.js";
import {
  getBaseToolCapability,
  extractToolAction,
  evaluateActionCapability,
  type ActionCapabilityDescriptor,
  type ToolActionReadiness,
} from "./mcpCapabilityMatrix.js";
import { checkDependencies } from "./mcpDependencyManager.js";
import { fileRulesRegistered } from "../tools/registeredFileToolGate.js";
import { getProject } from "../project/projectRegistry.js";
import { hasProjectAccess, type ProjectAccessCapability } from "../project/projectAccessPolicy.js";
import { getMcpIdentityByHandle } from "./mcpIdentityPresence.js";
import { canonicalizeToolName } from "../tools/toolAliases.js";

export type PreflightReasonCode =
  | "ready"
  | "approval_required"
  | "project_grant_missing"
  | "oauth_scope_missing"
  | "host_policy_blocked"
  | "file_outside_project"
  | "target_not_claimed"
  | "device_owner_approval_required"
  | "dependency_missing"
  | "service_unavailable"
  | "unsupported_action"
  | "invalid_arguments"
  | "unknown_state";

export interface PreflightRequest {
  name: string;
  action?: string;
  arguments?: Record<string, unknown>;
  projectId?: string;
  identityHandle?: string;
  scopes?: string[];
  sessionToken?: string;
  expectedRevision?: number;
  hasProjectAccess?: (cap: ProjectAccessCapability) => boolean;
  projectPath?: string;
  hostPolicyActive?: boolean;
  serviceAvailable?: boolean | ((service: string) => boolean);
}

export interface PreflightCheckResult {
  pass: boolean;
  code?: PreflightReasonCode;
  message?: string;
  remediation?: string;
}

export interface ToolPreflightResult {
  ok: boolean;
  toolName: string;
  action: string;
  readiness: ToolActionReadiness;
  reasonCode: PreflightReasonCode;
  message: string;
  remediation?: string;
  checks: Record<string, PreflightCheckResult>;
  capability: ActionCapabilityDescriptor;
}

export async function runToolPreflight(req: PreflightRequest): Promise<ToolPreflightResult> {
  const rawToolName = typeof req.name === "string" ? req.name.trim() : "";
  const toolName = canonicalizeToolName(rawToolName);
  const args = req.arguments && typeof req.arguments === "object" && !Array.isArray(req.arguments)
    ? req.arguments
    : {};

  const checks: Record<string, PreflightCheckResult> = {};

  // 1. Tool and Action checkpoint
  const toolDef = MCP_TOOL_DEFINITIONS.find((t) => t.name === toolName);
  if (!toolDef || DISABLED_MCP_TOOLS.has(toolName)) {
    const res: PreflightCheckResult = {
      pass: false,
      code: "unsupported_action",
      message: `Tool '${toolName}' is not available, disabled, or unrecognized in SuperAgent MCP.`,
      remediation: "Search available tools via superagent_tool_search.",
    };
    checks.tool_and_action = res;
    const baseCap = getBaseToolCapability(toolName, "default");
    return {
      ok: false,
      toolName,
      action: "default",
      readiness: "unsupported_here",
      reasonCode: "unsupported_action",
      message: res.message!,
      remediation: res.remediation,
      checks,
      capability: baseCap,
    };
  }

  const action = req.action || extractToolAction(toolName, args);
  checks.tool_and_action = { pass: true };

  // 2. Schema and Arguments checkpoint
  const schema = (toolDef.inputSchema as any) || {};
  const requiredFields: string[] = Array.isArray(schema.required) ? schema.required : [];
  const missingRequired = requiredFields.filter((key) => args[key] === undefined);

  if (missingRequired.length > 0) {
    checks.schema_and_arguments = {
      pass: false,
      code: "invalid_arguments",
      message: `Missing required schema arguments: ${missingRequired.join(", ")}`,
      remediation: `Provide all required arguments according to '${toolName}' schema.`,
    };
  } else {
    checks.schema_and_arguments = { pass: true };
  }

  const capability = getBaseToolCapability(toolName, action);

  // 3. OAuth checkpoint
  if (req.scopes && Array.isArray(req.scopes)) {
    const grantedScopes = new Set(req.scopes);
    const missingScopes = capability.oauthScopes.filter((s) => !grantedScopes.has(s));
    if (missingScopes.length > 0) {
      checks.oauth = {
        pass: false,
        code: "oauth_scope_missing",
        message: `Missing required OAuth scopes: ${missingScopes.join(", ")}`,
        remediation: `Re-authenticate client with scopes: ${missingScopes.join(", ")}.`,
      };
    } else {
      checks.oauth = { pass: true };
    }
  } else {
    checks.oauth = { pass: true };
  }

  // 4. Project Grants checkpoint
  if (capability.projectCapability) {
    if (req.hasProjectAccess) {
      if (req.hasProjectAccess(capability.projectCapability)) {
        checks.project_grants = { pass: true };
      } else {
        checks.project_grants = {
          pass: false,
          code: "project_grant_missing",
          message: `Caller lacks capability '${capability.projectCapability}'.`,
          remediation: `Grant '${capability.projectCapability}' capability in Akses Proyek panel.`,
        };
      }
    } else if (!req.projectId) {
      checks.project_grants = {
        pass: false,
        code: "project_grant_missing",
        message: `Tool '${toolName}' requires an active project selection with capability '${capability.projectCapability}'.`,
        remediation: "Select an active registered project before executing.",
      };
    } else {
      const project = getProject(req.projectId);
      if (!project || !project.enabled) {
        checks.project_grants = {
          pass: false,
          code: "project_grant_missing",
          message: `Selected project '${req.projectId}' is not registered or disabled.`,
          remediation: "Enable the project or register a valid project.",
        };
      } else {
        const identity = req.identityHandle ? getMcpIdentityByHandle(req.identityHandle) : null;
        if (identity && !hasProjectAccess(identity, project.id, capability.projectCapability)) {
          checks.project_grants = {
            pass: false,
            code: "project_grant_missing",
            message: `Identity '${req.identityHandle}' lacks capability '${capability.projectCapability}' for project '${project.name}'.`,
            remediation: `Grant '${capability.projectCapability}' capability in Akses Proyek panel.`,
          };
        } else {
          checks.project_grants = { pass: true };
        }
      }
    }
  } else {
    checks.project_grants = { pass: true };
  }

  // 5. Host File-Policy & Path Scope checkpoint
  const hostPolicyActive = req.hostPolicyActive ?? fileRulesRegistered();
  if (hostPolicyActive) {
    if (capability.hostFilePolicy === "uncertified") {
      checks.host_file_policy = {
        pass: false,
        code: "host_policy_blocked",
        message: `Action '${action}' on tool '${toolName}' is uncertified under permanent host file-policy.`,
        remediation: capability.remediation || "Use certified alternative actions that do not access unmediated files.",
      };
    } else if (capability.hostFilePolicy === "certified_upload_ingress") {
      const hasReceipt = Boolean(args.ingressReceiptId || (args.__ingressReceipt && typeof args.__ingressReceipt === "object"));
      if (!hasReceipt && action === "upload_file") {
        checks.host_file_policy = {
          pass: false,
          code: "host_policy_blocked",
          message: "CDP upload_file is blocked under permanent host file policy without certified secure ingress staging.",
          remediation: "Stage the file using the secure upload ingress pipeline before calling upload_file.",
        };
      } else {
        checks.host_file_policy = { pass: true };
      }
    } else {
      checks.host_file_policy = { pass: true };
    }
  } else {
    checks.host_file_policy = { pass: true };
  }

  // Workspace / File Path boundary check
  const candidatePath = args.filePath || args.inputPath || args.path || args.outputPath;
  if (typeof candidatePath === "string" && candidatePath.trim()) {
    const proj = req.projectId ? getProject(req.projectId) : null;
    const projRootPath = req.projectPath || proj?.root;
    if (projRootPath) {
      const resolved = path.resolve(String(candidatePath));
      const projRoot = path.resolve(projRootPath);
      const relative = path.relative(projRoot, resolved);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        checks.path_boundary = {
          pass: false,
          code: "file_outside_project",
          message: `Referenced file path '${candidatePath}' is outside the authorized project boundary '${projRootPath}'.`,
          remediation: "Keep files strictly within the selected project root or register a separate project.",
        };
      } else {
        checks.path_boundary = { pass: true };
      }
    }
  }

  // 6. Native / Operator Approval checkpoint
  if (capability.nativeApproval === "operator_approval") {
    checks.native_approval = {
      pass: true, // Advisory in preflight: indicates approval is required at execution
      code: "approval_required",
      message: "This operation requires explicit native operator approval before execution.",
    };
  } else if (capability.nativeApproval === "device_owner_approval") {
    checks.native_approval = {
      pass: true,
      code: "device_owner_approval_required",
      message: "This operation requires device owner confirmation.",
    };
  } else {
    checks.native_approval = { pass: true };
  }

  // 7. Dependencies checkpoint
  if (capability.dependencies.length > 0) {
    const depCheck = await checkDependencies(capability.dependencies);
    if (!depCheck.allSatisfied) {
      const missing = depCheck.missing.map((m) => m.name).join(", ");
      checks.dependencies = {
        pass: false,
        code: "dependency_missing",
        message: `Missing runtime dependencies: ${missing}`,
        remediation: depCheck.missing.map((m) => m.remediation).filter(Boolean).join(" "),
      };
    } else {
      checks.dependencies = { pass: true };
    }
  } else {
    checks.dependencies = { pass: true };
  }

  // 8. Service Availability checkpoint
  if (capability.runtimeService) {
    if (typeof req.serviceAvailable === "boolean") {
      checks.service_availability = req.serviceAvailable
        ? { pass: true }
        : {
            pass: false,
            code: "service_unavailable",
            message: `Runtime service '${capability.runtimeService}' is not available.`,
            remediation: `Start service '${capability.runtimeService}'.`,
          };
    } else if (typeof req.serviceAvailable === "function") {
      const ok = req.serviceAvailable(capability.runtimeService);
      checks.service_availability = ok
        ? { pass: true }
        : {
            pass: false,
            code: "service_unavailable",
            message: `Runtime service '${capability.runtimeService}' is not available.`,
            remediation: `Start service '${capability.runtimeService}'.`,
          };
    } else if (capability.runtimeService === "cdp") {
      const isCdpReachable = await fetch("http://127.0.0.1:9222/json/version", {
        signal: AbortSignal.timeout(800),
      }).then((r) => r.ok).catch(() => false);
      if (!isCdpReachable) {
        checks.service_availability = {
          pass: false,
          code: "service_unavailable",
          message: "Chrome CDP service (port 9222) is not responding.",
          remediation: "Start Chrome with remote debugging on port 9222: chrome.exe --remote-debugging-port=9222",
        };
      } else {
        checks.service_availability = { pass: true };
      }
    } else {
      checks.service_availability = { pass: true };
    }
  } else {
    checks.service_availability = { pass: true };
  }

  // 9. Target / Profile / Session checkpoint
  if (capability.targetSessionRequirement === "target_lease") {
    const token = req.sessionToken || args.sessionToken;
    if (!token || typeof token !== "string" || token.length < 16) {
      checks.target_session = {
        pass: false,
        code: "target_not_claimed",
        message: "Action requires an active browser session lease token. Claim target first.",
        remediation: "Execute 'claim_target' to obtain a valid session lease token.",
      };
    } else {
      checks.target_session = { pass: true };
    }
  } else {
    checks.target_session = { pass: true };
  }

  // 10. Lease and Revision checkpoint
  if (args.expectedRevision !== undefined) {
    const rev = Number(args.expectedRevision);
    if (!Number.isSafeInteger(rev) || rev < 0) {
      checks.lease_and_revision = {
        pass: false,
        code: "invalid_arguments",
        message: "expectedRevision must be a non-negative integer.",
        remediation: "Pass a valid expectedRevision returned by the latest DOM snapshot.",
      };
    } else {
      checks.lease_and_revision = { pass: true };
    }
  } else {
    checks.lease_and_revision = { pass: true };
  }

  // Aggregate final preflight verdict
  const failingCheck = Object.entries(checks).find(([_, c]) => !c.pass);
  if (failingCheck) {
    const [checkName, check] = failingCheck;
    const code = check.code || "unknown_state";
    let readiness: ToolActionReadiness = "unsupported_here";
    if (code === "host_policy_blocked") readiness = "policy_blocked";
    else if (code === "dependency_missing") readiness = "dependency_missing";
    else if (code === "service_unavailable") readiness = "service_unavailable";
    else if (code === "oauth_scope_missing" || code === "project_grant_missing" || code === "target_not_claimed") {
      readiness = "approval_required";
    }

    return {
      ok: false,
      toolName,
      action,
      readiness,
      reasonCode: code,
      message: check.message || `Preflight failed at ${checkName}`,
      remediation: check.remediation || capability.remediation,
      checks,
      capability,
    };
  }

  // If native approval is required, mark readiness as approval_required
  if (capability.nativeApproval === "operator_approval" || capability.nativeApproval === "device_owner_approval") {
    return {
      ok: true,
      toolName,
      action,
      readiness: "approval_required",
      reasonCode: "approval_required",
      message: "Preflight verified. Operation requires human operator confirmation before execution.",
      checks,
      capability,
    };
  }

  return {
    ok: true,
    toolName,
    action,
    readiness: "ready",
    reasonCode: "ready",
    message: "Preflight verified. All 10 checkpoints satisfied and ready for execution.",
    checks,
    capability,
  };
}
