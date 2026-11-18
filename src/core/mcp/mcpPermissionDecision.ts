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


/** Service inspection is explicitly metadata-only. Never query a path, owner,
 * executable, policy grant or process during this advisory preflight. */
const SERVICE_READ_ACTIONS = new Set(["status","inventory","owner_status",
  "doctor","health","dashboard","logs","profile"]);
const SERVICE_NAMES = new Set(["all","core","mcp","transport","channel_host",
  "muse","telegram","vision","guardian","daemon","tray","rest_tunnel",
  "muse_tunnel","process_supervisor"]);
export function describeBoundedServicePermission(args:unknown,filePolicyActive:boolean) {
  const x=args && typeof args==="object"&&!Array.isArray(args)
    ?args as Record<string,unknown>:null;
  const keys=x?Object.keys(x):[];
  const valid=Boolean(x&&
    keys.every(key=>["action","service","port","limit"].includes(key))&&
    (x!.action===undefined||SERVICE_READ_ACTIONS.has(String(x!.action)))&&
    (x!.service===undefined||SERVICE_NAMES.has(String(x!.service)))&&
    (x!.port===undefined||(Number.isSafeInteger(x!.port)&&
      Number(x!.port)>=1024&&Number(x!.port)<=65535))&&
    (x!.limit===undefined||(Number.isSafeInteger(x!.limit)&&
      Number(x!.limit)>=1&&Number(x!.limit)<=200)));
  return {
    decisionCode:valid?"ALLOWED_TO_ATTEMPT" as const:"SCHEMA_INVALID" as const,
    action:valid?(typeof x!.action==="string"?x!.action:"status"):"unrecognized",
    layers:({oauthScope:"granted",connectionExecute:"not_checked",
      projectCapability:"not_checked",
      hostFilePolicy:!filePolicyActive?"not_checked":valid?"granted":"blocked",
      nativeConsent:"not_checked",targetIdentity:"not_checked",hostOwner:"not_checked"}
      satisfies Record<string,McpPermissionLayerState>),
    remediation:valid
      ?"Metadata-only advisory. Runtime still validates action, owner and target."
      :"Only bounded read-only action, service, port and limit are permitted; no approval changes the schema.",
    performedExecution:false as const,
  };
}
