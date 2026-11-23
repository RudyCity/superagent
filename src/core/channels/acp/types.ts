/**
 * Agent Client Protocol (ACP) - Type Definitions & JSON-RPC 2.0 Contract
 * Standardized protocol specifications for connecting T-Line (Desktop Client / Host)
 * with Superagent Core (Agent Runtime).
 */

// ============================================================================
// 1. JSON-RPC 2.0 Core Specification Primitives
// ============================================================================

export const JSONRPC_VERSION = "2.0" as const;

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest<TMethod extends string = string, TParams = unknown> {
  jsonrpc: typeof JSONRPC_VERSION;
  id: JsonRpcId;
  method: TMethod;
  params: TParams;
}

export interface JsonRpcNotification<TMethod extends string = string, TParams = unknown> {
  jsonrpc: typeof JSONRPC_VERSION;
  method: TMethod;
  params: TParams;
}

export interface JsonRpcSuccessResponse<TResult = unknown> {
  jsonrpc: typeof JSONRPC_VERSION;
  id: JsonRpcId;
  result: TResult;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcErrorResponse {
  jsonrpc: typeof JSONRPC_VERSION;
  id: JsonRpcId;
  error: JsonRpcErrorObject;
}

export type JsonRpcResponse<TResult = unknown> =
  | JsonRpcSuccessResponse<TResult>
  | JsonRpcErrorResponse;

export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcResponse;

// Standard JSON-RPC Error Codes
export const ACP_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  // Custom ACP Server Error Codes (-32000 to -32099)
  SESSION_NOT_FOUND: -32001,
  WORKSPACE_ACCESS_DENIED: -32002,
  PERMISSION_EXPIRED: -32003,
  AGENT_BUSY: -32004,
  TASK_ABORTED: -32005,
} as const;

// ============================================================================
// 2. ACP Capabilities & Handshake (initialize)
// ============================================================================

export const ACP_PROTOCOL_VERSION = "1.0.0" as const;

export interface AcpClientCapabilities {
  streaming?: boolean;
  diffInspection?: boolean;
  terminalControls?: boolean;
  interactivePermissions?: boolean;
  multiSession?: boolean;
}

export interface AcpAgentCapabilities {
  promptStreaming?: boolean;
  toolExecution?: boolean;
  multiTierAgents?: boolean;
  permissionEscalation?: boolean;
  supportedTools?: string[];
}

export interface AcpClientInfo {
  name: string;
  version: string;
}

export interface AcpAgentInfo {
  name: string;
  version: string;
}

export interface InitializeParams {
  protocolVersion: string | number;
  clientInfo: AcpClientInfo;
  capabilities: AcpClientCapabilities;
  workspace: {
    workspacePath: string;
    rootUri?: string;
  };
}

export interface InitializeResult {
  protocolVersion: string;
  agentInfo: AcpAgentInfo;
  capabilities: AcpAgentCapabilities;
  supportedMethods: string[];
}

// ============================================================================
// 3. ACP Session Lifecycle
// ============================================================================

export interface SessionNewParams {
  sessionId?: string;
  workspacePath: string;
  clientMode?: "tline" | "zed" | "generic";
  initialRole?: string;
  environment?: Record<string, string>;
}

export interface SessionNewResult {
  sessionId: string;
  workspacePath: string;
  status: "ready" | "busy";
  createdAt: number;
}

export interface SessionPromptParams {
  sessionId: string;
  prompt: string | Array<{ type: string; text?: string; [key: string]: any }>;
  mode?: string;
  loop?: boolean;
  goalMode?: string;
  maxIterations?: number;
  attachments?: Array<{
    type: "file" | "image" | "url";
    path?: string;
    content?: string;
    mimeType?: string;
  }>;
  context?: {
    activeFilePath?: string;
    mode?: string;
    loop?: boolean;
    goalMode?: string;
    maxIterations?: number;
    selection?: {
      startLine: number;
      endLine: number;
      text: string;
    };
  };
}

export interface SessionPromptResult {
  promptId: string;
  sessionId: string;
  accepted: boolean;
  startedAt: number;
}

export interface SessionCancelParams {
  sessionId: string;
  reason?: string;
}

export interface SessionCancelResult {
  sessionId: string;
  cancelled: boolean;
  stoppedAt: number;
}

// ============================================================================
// 4. ACP Streaming Updates (session/update Notification)
// ============================================================================

export type AcpUpdateKind =
  | "text_chunk"
  | "thought_chunk"
  | "tool_call_start"
  | "tool_call_end"
  | "subagent_status"
  | "diff_patch"
  | "status_change";

export interface AcpTextChunkUpdate {
  kind: "text_chunk";
  delta: string;
}

export interface AcpThoughtChunkUpdate {
  kind: "thought_chunk";
  delta: string;
}

export interface AcpToolCallStartUpdate {
  kind: "tool_call_start";
  callId: string;
  tool: string;
  actor: string;
  description?: string;
}

export interface AcpToolCallEndUpdate {
  kind: "tool_call_end";
  callId: string;
  tool: string;
  actor: string;
  status: "completed" | "failed";
  durationMs?: number;
  error?: string;
}

export interface AcpSubagentStatusUpdate {
  kind: "subagent_status";
  subagentId: string;
  role: string;
  status: "queued" | "running" | "completed" | "failed" | "terminated";
  parentActor?: string;
}

export interface AcpDiffPatchUpdate {
  kind: "diff_patch";
  filePath: string;
  patch: string;
  isStaged?: boolean;
}

export interface AcpStatusChangeUpdate {
  kind: "status_change";
  status: "idle" | "thinking" | "executing_tools" | "awaiting_approval" | "done" | "error";
  summary?: string;
}

export type AcpUpdatePayload =
  | AcpTextChunkUpdate
  | AcpThoughtChunkUpdate
  | AcpToolCallStartUpdate
  | AcpToolCallEndUpdate
  | AcpSubagentStatusUpdate
  | AcpDiffPatchUpdate
  | AcpStatusChangeUpdate;

export interface SessionUpdateParams {
  sessionId: string;
  seq: number;
  timestamp: number;
  update: AcpUpdatePayload;
}

// ============================================================================
// 5. ACP Security & Human-in-the-Loop Permissions (session/request_permission)
// ============================================================================

export type AcpPermissionAction =
  | "file_write"
  | "command_execute"
  | "network_access"
  | "subagent_spawn"
  | "mcp_grant";

export type AcpPermissionRiskLevel = "low" | "medium" | "high" | "critical";

export interface RequestPermissionParams {
  permissionId: string;
  sessionId: string;
  workspacePath: string;
  action: AcpPermissionAction;
  target: string;
  description: string;
  riskLevel: AcpPermissionRiskLevel;
  expiresInMs: number;
  details?: Record<string, unknown>;
}

export type AcpApprovalDecision =
  | "approved"
  | "approved_session"
  | "denied"
  | "cancelled";

export interface RequestPermissionResult {
  permissionId: string;
  decision: AcpApprovalDecision;
  reason?: string;
  decidedAt: number;
}

// ============================================================================
// 6. Type Guards & Factory Helpers
// ============================================================================

export function isJsonRpcRequest(msg: unknown): msg is JsonRpcRequest {
  if (typeof msg !== "object" || msg === null) return false;
  const m = msg as Record<string, unknown>;
  return m.jsonrpc === JSONRPC_VERSION && typeof m.method === "string" && "id" in m;
}

export function isJsonRpcNotification(msg: unknown): msg is JsonRpcNotification {
  if (typeof msg !== "object" || msg === null) return false;
  const m = msg as Record<string, unknown>;
  return m.jsonrpc === JSONRPC_VERSION && typeof m.method === "string" && !("id" in m);
}

export function isJsonRpcResponse(msg: unknown): msg is JsonRpcResponse {
  if (typeof msg !== "object" || msg === null) return false;
  const m = msg as Record<string, unknown>;
  return m.jsonrpc === JSONRPC_VERSION && "id" in m && ("result" in m || "error" in m);
}

export function createAcpRequest<TParams>(
  id: JsonRpcId,
  method: string,
  params: TParams
): JsonRpcRequest<string, TParams> {
  return {
    jsonrpc: JSONRPC_VERSION,
    id,
    method,
    params,
  };
}

export function createAcpNotification<TParams>(
  method: string,
  params: TParams
): JsonRpcNotification<string, TParams> {
  return {
    jsonrpc: JSONRPC_VERSION,
    method,
    params,
  };
}

export function createAcpSuccessResponse<TResult>(
  id: JsonRpcId,
  result: TResult
): JsonRpcSuccessResponse<TResult> {
  return {
    jsonrpc: JSONRPC_VERSION,
    id,
    result,
  };
}

export function createAcpErrorResponse(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown
): JsonRpcErrorResponse {
  return {
    jsonrpc: JSONRPC_VERSION,
    id,
    error: {
      code,
      message,
      ...(data !== undefined ? { data } : {}),
    },
  };
}
