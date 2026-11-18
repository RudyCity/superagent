/**
 * Non-executing, bounded permission diagnostics. This is not an authorizer.
 * The host gate and actual MCP dispatcher are always evaluated again on call.
 * No tool arguments, file targets, token strings, or principal names enter here.
 */
export const MCP_PERMISSION_DECISION_CODES = [
  "ALLOWED_TO_ATTEMPT", "SCHEMA_INVALID", "OAUTH_SCOPE_MISSING",
  "MCP_CONNECTION_EXECUTE_REQUIRED", "PROJECT_CAPABILITY_MISSING",
  "HOST_FILE_POLICY_UNCERTIFIED", "HOST_FILE_POLICY_DENIED",
  "NATIVE_CONSENT_REQUIRED", "TARGET_IDENTITY_MISMATCH",
  "HOST_OWNER_UNVERIFIED", "TOOL_DISABLED", "TARGET_UNAVAILABLE",
  "POLICY_STORE_UNAVAILABLE",
] as const;
export type McpPermissionDecisionCode = typeof MCP_PERMISSION_DECISION_CODES[number];
export type McpPermissionLayerState =
  "not_checked" | "checked" | "granted" | "blocked" | "unknown";

export interface BoundedDesktopPermissionInput {
  oauthAllowed: boolean;
  connectionDecision: "granted" | "approval_required" | "unavailable";
  filePolicyActive: boolean;
  /** Only a verdict from the actual production registeredFileToolGate. */
  hostBlock: string | null;
}
export function describeBoundedDesktopPermission(input: BoundedDesktopPermissionInput) {
  const malformed = Boolean(input.hostBlock?.includes("unsupported arguments"));
  // Host certification takes priority over an approval prompt: approving
  // Execute cannot fix an independent denied file policy.
  const decisionCode: McpPermissionDecisionCode =
    !input.oauthAllowed ? "OAUTH_SCOPE_MISSING" :
    malformed ? "SCHEMA_INVALID" :
    input.hostBlock ? "HOST_FILE_POLICY_UNCERTIFIED" :
    input.connectionDecision === "unavailable" ? "POLICY_STORE_UNAVAILABLE" :
    input.connectionDecision !== "granted" ? "MCP_CONNECTION_EXECUTE_REQUIRED" :
    "ALLOWED_TO_ATTEMPT";
  const remediation = {
    ALLOWED_TO_ATTEMPT: "Advisory only: invocation must recheck all policy, owner, target and native-consent gates.",
    OAUTH_SCOPE_MISSING: "Reconnect with the required OAuth write scope; a connection label is not authority.",
    SCHEMA_INVALID: "Use the exact documented command fields; no approval is needed to repair invalid arguments.",
    HOST_FILE_POLICY_UNCERTIFIED: "The host file policy blocks this action; approving MCP Execute cannot override it.",
    POLICY_STORE_UNAVAILABLE: "The operator must repair the permission store; do not retry grants or assume access.",
    MCP_CONNECTION_EXECUTE_REQUIRED: "Open Security Approval > MCP Connections for a human-scoped Execute grant.",
  } as const;
  return {
    decisionCode,
    layers: {
      oauthScope: input.oauthAllowed ? "granted" : "blocked",
      connectionExecute: input.connectionDecision === "granted" ? "granted"
        : input.connectionDecision === "unavailable" ? "unknown" : "blocked",
      projectCapability: "not_checked",
      hostFilePolicy: !input.filePolicyActive ? "not_checked"
        : input.hostBlock ? "blocked" : "granted",
      nativeConsent: "not_checked",
      targetIdentity: "not_checked",
      hostOwner: "not_checked",
    } satisfies Record<string, McpPermissionLayerState>,
    remediation: remediation[decisionCode as keyof typeof remediation],
    performedExecution: false as const,
  };
}
