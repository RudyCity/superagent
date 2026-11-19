/**
 * Non-executing, bounded permission diagnostics. This is not an authorizer.
 * The host gate and actual MCP dispatcher are always evaluated again on call.
 * No tool arguments, file targets, token strings, or principal names enter here.
 */
import { MANAGED_SERVICE_NAMES } from "../runtime/serviceManagerTypes.js";
import { certifiedBrowserObservation } from "../tools/browserFilePolicyCertification.js";
import {
  certifiedServiceInspection,
  READ_ONLY_SERVICE_ACTIONS,
} from "../tools/registeredFileToolGate.js";
import { parseReadOnlyServiceArgs } from "../runtime/serviceReadPolicy.js";
import { MCP_CONNECTION_PROJECT_ID } from "../project/projectSecurityResources.js";

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

export type McpPermissionRemediationAction =
  | { kind: "none"; advisoryOnly: true }
  | { kind: "reauthorize_oauth"; requiredScope: string; retryableWithMcpGrant: false }
  | { kind: "fix_arguments"; supportedFields?: readonly string[]; supportedActions?: readonly string[]; retryableWithMcpGrant: false }
  | { kind: "host_policy_blocked"; retryableWithMcpGrant: false }
  | { kind: "repair_policy_store"; retryableWithMcpGrant: false }
  | { kind: "open_tray_section"; trayPage: "security"; trayTab: "connections" | "mcp"; projectId: string; requiredCapability: string; retryableAfterGrant: true };

export type McpPermissionSchemaContext = Readonly<{
  tool: "superagent_desktop_ui" | "superagent_services_status";
  /** Field names from the authorized production inputSchema, never argument values. */
  fields: readonly string[];
}>;

export type McpPermissionRemediationActionItem =
  | { kind:"open_tab";page:"security";tab:"connections"|"mcp"|"rules"|"register";
      route:"security:connections"|"security:mcp"|"security:rules"|"security:register";
      requiresUserAction:true;
      request?:{tool:"superagent_request_project_access";
        arguments:{projectId:typeof MCP_CONNECTION_PROJECT_ID;capabilities:["execute"]};requiresUserSubmission:true} }
  | { kind:"reconnect";requiredScopes:["mcp:tools:write"];requiresUserAction:true }
  | { kind:"operator_repair";reasonCode:McpPermissionDecisionCode;requiresUserAction:true }
  | { kind:"inspect_schema";tool:McpPermissionSchemaContext["tool"];fields:string[];requiresUserAction:true }
  | { kind:"none";reasonCode:"RUNTIME_RECHECK_REQUIRED"|"TARGET_UNAVAILABLE" };

/** Navigation/request descriptions only; consuming these values must not grant or submit anything. */
export function getMcpPermissionRemediationActions(
  code:McpPermissionDecisionCode,schema?:McpPermissionSchemaContext,
):McpPermissionRemediationActionItem[] {
  if(code==="MCP_CONNECTION_EXECUTE_REQUIRED")return [{kind:"open_tab",page:"security",
    tab:"connections",route:"security:connections",requiresUserAction:true,
    request:{tool:"superagent_request_project_access",arguments:{projectId:MCP_CONNECTION_PROJECT_ID,
      capabilities:["execute"]},requiresUserSubmission:true}}];
  if(code==="PROJECT_CAPABILITY_MISSING")return [{kind:"open_tab",page:"security",
    tab:"mcp",route:"security:mcp",requiresUserAction:true}];
  if(code==="NATIVE_CONSENT_REQUIRED")return [{kind:"open_tab",page:"security",
    tab:"register",route:"security:register",requiresUserAction:true}];
  if(code==="OAUTH_SCOPE_MISSING")return [{kind:"reconnect",requiredScopes:["mcp:tools:write"],requiresUserAction:true}];
  if(code==="SCHEMA_INVALID"&&schema)return [{kind:"inspect_schema",tool:schema.tool,
    fields:[...new Set(schema.fields.filter(field=>/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(field)))].slice(0,64),
    requiresUserAction:true}];
  if(code==="ALLOWED_TO_ATTEMPT")return [{kind:"none",reasonCode:"RUNTIME_RECHECK_REQUIRED"}];
  if(code==="TARGET_UNAVAILABLE")return [{kind:"none",reasonCode:"TARGET_UNAVAILABLE"}];
  return [{kind:"operator_repair",reasonCode:code,requiresUserAction:true}];
}

export interface BoundedDesktopPermissionInput {
  oauthAllowed: boolean;
  connectionDecision: "granted" | "approval_required" | "unavailable";
  filePolicyActive: boolean;
  /** Only a verdict from the actual production registeredFileToolGate. */
  hostBlock: string | null;
  supportedFields?: readonly string[];
  requiredScope?: string;
}

function buildDesktopRemediationAction(
  decisionCode: McpPermissionDecisionCode,
  input: Pick<BoundedDesktopPermissionInput, "supportedFields" | "requiredScope">,
): McpPermissionRemediationAction {
  switch (decisionCode) {
    case "OAUTH_SCOPE_MISSING":
      return { kind: "reauthorize_oauth", requiredScope: input.requiredScope ?? "mcp:tools:write", retryableWithMcpGrant: false };
    case "SCHEMA_INVALID":
      return {
        kind: "fix_arguments",
        ...(input.supportedFields ? { supportedFields: input.supportedFields } : {}),
        retryableWithMcpGrant: false,
      };
    case "HOST_FILE_POLICY_UNCERTIFIED":
    case "HOST_FILE_POLICY_DENIED":
      return { kind: "host_policy_blocked", retryableWithMcpGrant: false };
    case "POLICY_STORE_UNAVAILABLE":
      return { kind: "repair_policy_store", retryableWithMcpGrant: false };
    case "MCP_CONNECTION_EXECUTE_REQUIRED":
      return {
        kind: "open_tray_section",
        trayPage: "security",
        trayTab: "connections",
        projectId: "mcp-connection",
        requiredCapability: "execute",
        retryableAfterGrant: true,
      };
    default:
      return { kind: "none", advisoryOnly: true };
  }
}

export function describeBoundedDesktopPermission(
  input: BoundedDesktopPermissionInput,
  schema?: McpPermissionSchemaContext,
) {
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
    remediationAction: buildDesktopRemediationAction(decisionCode, input),
    remediationActions: getMcpPermissionRemediationActions(decisionCode, schema),
    performedExecution: false as const,
  };
}

/** Service inspection is explicitly metadata-only. Never query a path, owner,
 * executable, policy grant or process during this advisory preflight. */
const SERVICE_INSPECTION_FIELDS = ["action", "service", "port", "limit"] as const;

function isValidReadOnlyServiceArgs(args: unknown): { valid: boolean; action: string } {
  const parsed = parseReadOnlyServiceArgs(args);
  return {
    valid: parsed !== null,
    action: parsed?.action ?? "unrecognized",
  };
}

export function describeBoundedServicePermission(
  args: unknown,
  filePolicyActive: boolean,
  schema?: McpPermissionSchemaContext,
) {
  const { valid, action } = isValidReadOnlyServiceArgs(args);
  return {
    decisionCode: valid ? "ALLOWED_TO_ATTEMPT" as const : "SCHEMA_INVALID" as const,
    action,
    layers: ({
      oauthScope: "granted",
      connectionExecute: "not_checked",
      projectCapability: "not_checked",
      hostFilePolicy: !filePolicyActive ? "not_checked" : valid ? "granted" : "blocked",
      nativeConsent: "not_checked",
      targetIdentity: "not_checked",
      hostOwner: "not_checked",
    } satisfies Record<string, McpPermissionLayerState>),
    remediation: valid
      ? "Metadata-only advisory. Runtime still validates action, owner and target."
      : "Only bounded read-only action, service, port and limit are permitted; no approval changes the schema.",
    remediationAction: valid
      ? ({ kind: "none", advisoryOnly: true } satisfies McpPermissionRemediationAction)
      : ({
          kind: "fix_arguments",
          supportedFields: SERVICE_INSPECTION_FIELDS,
          supportedActions: [...READ_ONLY_SERVICE_ACTIONS],
          retryableWithMcpGrant: false,
        } satisfies McpPermissionRemediationAction),
    remediationActions: getMcpPermissionRemediationActions(valid ? "ALLOWED_TO_ATTEMPT" : "SCHEMA_INVALID", schema),
    performedExecution: false as const,
  };
}

export interface BoundedServiceManagePermissionInput {
  args: unknown;
  oauthAllowed: boolean;
  connectionDecision: "granted" | "approval_required" | "unavailable";
  filePolicyActive: boolean;
  hostBlock: string | null;
}

export function describeBoundedServiceManagePermission(input: BoundedServiceManagePermissionInput) {
  const x = input.args && typeof input.args === "object" && !Array.isArray(input.args)
    ? input.args as Record<string, unknown> : null;
  const rawAction = x && typeof x.action === "string" ? x.action : "";
  const isReadAction = READ_ONLY_SERVICE_ACTIONS.has(rawAction);
  const { valid: readShapeValid } = isValidReadOnlyServiceArgs(input.args);
  const schemaInvalid = !x || (isReadAction && !readShapeValid);
  const effectiveHostBlock = schemaInvalid
    ? "unsupported arguments"
    : input.hostBlock;

  const decisionCode: McpPermissionDecisionCode =
    !input.oauthAllowed ? "OAUTH_SCOPE_MISSING" :
    schemaInvalid ? "SCHEMA_INVALID" :
    effectiveHostBlock ? "HOST_FILE_POLICY_UNCERTIFIED" :
    input.connectionDecision === "unavailable" ? "POLICY_STORE_UNAVAILABLE" :
    input.connectionDecision !== "granted" ? "MCP_CONNECTION_EXECUTE_REQUIRED" :
    "ALLOWED_TO_ATTEMPT";

  const remediation = {
    ALLOWED_TO_ATTEMPT: "Advisory only: invocation must recheck OAuth write scope, Connection Execute, host policy, owner and target.",
    OAUTH_SCOPE_MISSING: "Reconnect with the required OAuth write scope; a connection label is not authority.",
    SCHEMA_INVALID: "Only bounded read-only action, service, port and limit are permitted for inspection; no approval changes the schema.",
    HOST_FILE_POLICY_UNCERTIFIED: "The host file policy blocks this service mutation; approving MCP Execute cannot override it.",
    POLICY_STORE_UNAVAILABLE: "The operator must repair the permission store; do not retry grants or assume access.",
    MCP_CONNECTION_EXECUTE_REQUIRED: "Open Security Approval > MCP Connections for a human-scoped Execute grant.",
  } as const;

  return {
    decisionCode,
    action: isReadAction && readShapeValid ? rawAction : "unrecognized",
    layers: ({
      oauthScope: input.oauthAllowed ? "granted" : "blocked",
      connectionExecute: input.connectionDecision === "granted" ? "granted"
        : input.connectionDecision === "unavailable" ? "unknown" : "blocked",
      projectCapability: "not_checked",
      hostFilePolicy: !input.filePolicyActive ? "not_checked"
        : effectiveHostBlock ? "blocked" : "granted",
      nativeConsent: "not_checked",
      targetIdentity: "not_checked",
      hostOwner: "not_checked",
    } satisfies Record<string, McpPermissionLayerState>),
    remediation: remediation[decisionCode as keyof typeof remediation],
    remediationAction: buildDesktopRemediationAction(decisionCode, {
      supportedFields: isReadAction ? SERVICE_INSPECTION_FIELDS : undefined,
      requiredScope: "mcp:tools:write",
    }),
    performedExecution: false as const,
  };
}

export function describeBoundedBrowserObservePermission(
  args: unknown,
  filePolicyActive: boolean,
  oauthAllowed: boolean,
) {
  const x = args && typeof args === "object" && !Array.isArray(args)
    ? args as Record<string, unknown> : undefined;
  const valid = Boolean(x && certifiedBrowserObservation({ name: "superagent_chrome_cdp_observe", args: x }));
  const decisionCode: McpPermissionDecisionCode =
    !oauthAllowed ? "OAUTH_SCOPE_MISSING" :
    !valid ? "SCHEMA_INVALID" :
    "ALLOWED_TO_ATTEMPT";
  return {
    decisionCode,
    command: valid && typeof x?.command === "string" ? x.command : "unrecognized",
    layers: ({
      oauthScope: oauthAllowed ? "granted" : "blocked",
      connectionExecute: "not_checked",
      projectCapability: "not_checked",
      hostFilePolicy: !filePolicyActive ? "not_checked" : valid ? "granted" : "blocked",
      nativeConsent: "not_checked",
      targetIdentity: "not_checked",
      hostOwner: "not_checked",
    } satisfies Record<string, McpPermissionLayerState>),
    remediation: decisionCode === "ALLOWED_TO_ATTEMPT"
      ? "Metadata-only Chrome observation advisory. Runtime still validates managed/Delegate transport identity."
      : decisionCode === "OAUTH_SCOPE_MISSING"
        ? "Reconnect with OAuth read scope."
        : "Only certified list_targets or transport_status with bounded transport arguments are permitted.",
    remediationAction: decisionCode === "ALLOWED_TO_ATTEMPT"
      ? ({ kind: "none", advisoryOnly: true } satisfies McpPermissionRemediationAction)
      : decisionCode === "OAUTH_SCOPE_MISSING"
        ? ({ kind: "reauthorize_oauth", requiredScope: "mcp:tools", retryableWithMcpGrant: false } satisfies McpPermissionRemediationAction)
        : ({
            kind: "fix_arguments",
            supportedFields: ["command", "transport", "delegateClientId", "debug_port"],
            supportedActions: ["list_targets", "transport_status"],
            retryableWithMcpGrant: false,
          } satisfies McpPermissionRemediationAction),
    performedExecution: false as const,
  };
}
