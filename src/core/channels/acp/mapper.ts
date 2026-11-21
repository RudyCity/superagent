/**
 * Agent Client Protocol (ACP) - Superagent Bridge Mappers
 * Converts internal Superagent timeline events and approval lifecycles
 * into standardized ACP JSON-RPC notifications and permission requests.
 */

import type { AgentTimelineEvent } from "../tlineAgentTimeline.js";
import type { ApprovalRecord, ApprovalState } from "../tlineApprovalRegistry.js";
import {
  type AcpApprovalDecision,
  type AcpPermissionAction,
  type AcpUpdatePayload,
  type RequestPermissionParams,
  type SessionUpdateParams,
  createAcpNotification,
  createAcpRequest,
} from "./types.js";

/**
 * Maps an internal Superagent AgentTimelineEvent to an ACP SessionUpdatePayload.
 */
export function mapTimelineEventToAcpUpdate(
  event: AgentTimelineEvent
): AcpUpdatePayload {
  switch (event.kind) {
    case "tool_start":
      return {
        kind: "tool_call_start",
        callId: event.callId || `call_${event.seq}`,
        tool: event.tool || "unknown_tool",
        actor: event.actor,
      };

    case "tool_end":
      return {
        kind: "tool_call_end",
        callId: event.callId || `call_${event.seq}`,
        tool: event.tool || "unknown_tool",
        actor: event.actor,
        status: event.status === "failed" ? "failed" : "completed",
      };

    case "subagent_status":
      return {
        kind: "subagent_status",
        subagentId: event.actor,
        role: event.tool || "subagent",
        status: (event.status as any) || "running",
        parentActor: event.parent,
      };

    case "permission_requested":
      return {
        kind: "status_change",
        status: "awaiting_approval",
        summary: `Action pending user authorization: ${event.tool || "system_action"}`,
      };

    case "permission_decided":
      return {
        kind: "status_change",
        status: event.status === "approved" || event.status === "approved_session"
          ? "executing_tools"
          : "thinking",
        summary: `Permission ${event.status}`,
      };

    case "agent_done":
      return {
        kind: "status_change",
        status: "done",
        summary: "Execution sequence finished",
      };

    default:
      return {
        kind: "status_change",
        status: "thinking",
        summary: `Status: ${event.status || "active"}`,
      };
  }
}

/**
 * Builds an ACP `session/update` JSON-RPC notification from an internal event.
 */
export function createAcpSessionUpdateNotification(
  sessionId: string,
  event: AgentTimelineEvent
) {
  const updatePayload = mapTimelineEventToAcpUpdate(event);
  const params: SessionUpdateParams = {
    sessionId,
    seq: event.seq,
    timestamp: event.at,
    update: updatePayload,
  };

  return createAcpNotification("session/update", params);
}

/**
 * Maps an internal Superagent ApprovalRecord into an ACP `session/request_permission` request.
 */
export function mapApprovalRecordToAcpPermissionRequest(
  record: ApprovalRecord,
  meta?: {
    action?: AcpPermissionAction;
    target?: string;
    description?: string;
  }
) {
  const expiresInMs = Math.max(0, record.expiresAt - Date.now());
  const params: RequestPermissionParams = {
    permissionId: record.permissionId,
    sessionId: record.sessionId,
    workspacePath: record.workspace,
    action: meta?.action || "command_execute",
    target: meta?.target || "workspace_operation",
    description: meta?.description || "Superagent requests permission to execute an action.",
    riskLevel: meta?.action === "file_write" ? "medium" : "high",
    expiresInMs,
  };

  return createAcpRequest(record.permissionId, "session/request_permission", params);
}

/**
 * Maps an ACP approval decision back to Superagent ApprovalState.
 */
export function mapAcpDecisionToApprovalState(
  decision: AcpApprovalDecision
): ApprovalState {
  switch (decision) {
    case "approved":
      return "approved";
    case "approved_session":
      return "approved_session";
    case "denied":
      return "denied";
    case "cancelled":
      return "cancelled";
    default:
      return "denied";
  }
}
