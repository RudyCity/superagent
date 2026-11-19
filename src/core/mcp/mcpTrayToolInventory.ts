/**
 * Local-operator-only read model for Security Approval Manager.
 *
 * The inventory is declarative. It never executes a tool, requests a grant,
 * resolves a protected file path, or describes a project grant as permission
 * to bypass OAuth, host file policy, native consent or the caller's tool scope.
 */
import { MCP_TOOL_DEFINITIONS } from "./superagentMcpServer.js";
import { MCP_TOOL_CLASSIFICATION, DISABLED_MCP_TOOLS, PRIVILEGED_MCP_TOOLS } from "./mcpToolPolicy.js";
import { WORKSPACE_SCOPED_MCP_TOOLS, PROJECT_REGISTRY_TOOL_NAMES } from "./mcpWorkspacePolicy.js";
import { MCP_GATEWAY_TOOL_NAMES } from "./mcpToolGateway.js";
import { getProject } from "../project/projectRegistry.js";
import { getProjectCapabilityForTool, hasProjectAccess, PROJECT_ACCESS_CAPABILITIES, type ProjectAccessCapability } from "../project/projectAccessPolicy.js";
import { getMcpIdentityByHandle } from "./mcpIdentityPresence.js";
import { getRequestedMcpIdentityByHandle } from "../project/projectAccessRequestStore.js";
import { getPermanentFileToolReadiness, describePermanentFileToolReadiness, fileRulesRegistered } from "../tools/registeredFileToolGate.js";

export type TrayToolGrantState =
  "not_required" | "choose_identity_project" | "identity_unavailable" |
  "project_unavailable" | "policy_unavailable" | "granted" | "missing" | "action_dependent";
export type TrayToolKind = "read_only" | "project" | "operator_admin" | "target_dependent" | "request_only";

export function buildTrayToolInventory(selection: { identityHandle?: string; projectId?: string } = {}) {
  const identity = selection.identityHandle
    ? getMcpIdentityByHandle(selection.identityHandle) ||
      getRequestedMcpIdentityByHandle(selection.identityHandle)
    : null;
  const project = selection.projectId ? getProject(selection.projectId) : null;
  const selectedProjectValid = Boolean(project?.enabled);
  const hostPolicyActive = fileRulesRegistered();
  let policyUnavailable = false;
  const granted = new Set<ProjectAccessCapability>();
  if (identity && selectedProjectValid && project) {
    try {
      for (const cap of PROJECT_ACCESS_CAPABILITIES) {
        if (hasProjectAccess(identity, project.id, cap)) granted.add(cap);
      }
    } catch {
      policyUnavailable = true; // fail closed; never return partial results as grants
      granted.clear();
    }
  }
  const active = MCP_TOOL_DEFINITIONS.filter(tool => !DISABLED_MCP_TOOLS.has(tool.name));
  const tools = active.map(tool => {
    const name = tool.name;
    const risk = MCP_TOOL_CLASSIFICATION[name];
    const privileged = PRIVILEGED_MCP_TOOLS.has(name);
    const gateway = name === MCP_GATEWAY_TOOL_NAMES.execute;
    const workspaceScoped = WORKSPACE_SCOPED_MCP_TOOLS.has(name);
    const registry = PROJECT_REGISTRY_TOOL_NAMES.has(name);
    const approvalKind: TrayToolKind = gateway ? "target_dependent"
      : privileged ? "operator_admin"
      : name === "superagent_request_project_access" ? "request_only"
      : registry ? "read_only"
      : workspaceScoped || risk === "dangerous" ? "project"
      : "read_only";
    const actionDependent = name === "superagent_git_action";
    const capability: ProjectAccessCapability | null = approvalKind === "project" && !actionDependent
      ? workspaceScoped ? getProjectCapabilityForTool(name) : "execute"
      : null;
    let grantState: TrayToolGrantState = "not_required";
    if (approvalKind === "project") {
      grantState = !selection.identityHandle || !selection.projectId ? "choose_identity_project"
        : !identity ? "identity_unavailable"
        : !selectedProjectValid ? "project_unavailable"
        : !workspaceScoped && project?.type !== "local" ? "project_unavailable"
        : policyUnavailable ? "policy_unavailable"
        : actionDependent ? "action_dependent"
        : capability && granted.has(capability) ? "granted" : "missing";
    }
    const hostReadiness = getPermanentFileToolReadiness(name);
    const hostBlocked = hostPolicyActive && hostReadiness === "uncertified";
    const scope = risk === "dangerous" ? ["mcp:tools","mcp:tools:write"] : ["mcp:tools"];
    if (privileged) scope.push("mcp:tools:admin");
    return {
      name,
      description: String(tool.description || "").split("\n")[0].slice(0, 200),
      risk,
      approvalKind,
      workspaceScoped,
      capability,
      capabilitiesByAction: actionDependent ? {
        status: "read", diff: "read", log: "read",
        add: "git", commit: "git", restore: "git", clean: "git",
      } : null,
      oauthScopesRequired: scope,
      hostReadiness,
      hostRequirement: describePermanentFileToolReadiness(name).slice(0, 400),
      hostBlocked,
      grantState,
      // Advisory only: there is no "runnable" state. The host and native
      // approval gates are evaluated again for every real call.
      operationStatus: hostBlocked ? "host_uncertified"
        : hostReadiness === "requires_explicit_files" ? "file_rules_required"
        : hostReadiness === "action_dependent" ? "check_action_arguments"
        : "recheck_at_execution",
    };
  }).sort((a,b) => a.name.localeCompare(b.name));
  return {
    success: true as const,
    scope: "local_operator_advisory_catalog" as const,
    hostPolicyActive,
    selectedIdentityRecognized: Boolean(identity),
    selectedProjectRecognized: selectedProjectValid,
    selectedProjectType: project?.type || null,
    grantedCapabilities: policyUnavailable ? [] : [...granted],
    permissionStoreAvailable: !policyUnavailable,
    registered: MCP_TOOL_DEFINITIONS.length,
    active: active.length,
    disabled: MCP_TOOL_DEFINITIONS.length-active.length,
    counts: {
      uncertified: tools.filter(t => t.hostReadiness === "uncertified").length,
      hostBlocked: tools.filter(t => t.hostBlocked).length,
      missingProjectGrant: tools.filter(t => t.grantState === "missing").length,
      projectGrantMatched: tools.filter(t => t.grantState === "granted").length,
      actionDependent: tools.filter(t => t.operationStatus === "check_action_arguments" || t.capabilitiesByAction).length,
    },
    tools,
    note: "Catalog and stored grants are advisory, not tool execution approval. OAuth scopes, action parameters, actual workspace, host permanent file policy and native consent are rechecked at runtime.",
  };
}
