import { describe, expect, it } from "vitest";
import {
  ACP_ERROR_CODES,
  ACP_PROTOCOL_VERSION,
  JSONRPC_VERSION,
  createAcpErrorResponse,
  createAcpNotification,
  createAcpRequest,
  createAcpSuccessResponse,
  isJsonRpcNotification,
  isJsonRpcRequest,
  isJsonRpcResponse,
} from "../../src/core/channels/acp/types.js";
import {
  createAcpSessionUpdateNotification,
  mapAcpDecisionToApprovalState,
  mapApprovalRecordToAcpPermissionRequest,
  mapTimelineEventToAcpUpdate,
} from "../../src/core/channels/acp/mapper.js";
import type { AgentTimelineEvent } from "../../src/core/channels/tlineAgentTimeline.js";
import type { ApprovalRecord } from "../../src/core/channels/tlineApprovalRegistry.js";

describe("Agent Client Protocol (ACP) - Specification & Type Guards", () => {
  it("verifies protocol version and jsonrpc constant", () => {
    expect(JSONRPC_VERSION).toBe("2.0");
    expect(ACP_PROTOCOL_VERSION).toBe("1.0.0");
  });

  it("identifies valid JSON-RPC requests using isJsonRpcRequest", () => {
    const validRequest = createAcpRequest(1, "initialize", {
      protocolVersion: "1.0.0",
      clientInfo: { name: "tline", version: "0.9.0" },
      capabilities: {},
      workspace: { workspacePath: "D:/test/workspace" },
    });

    expect(isJsonRpcRequest(validRequest)).toBe(true);
    expect(isJsonRpcNotification(validRequest)).toBe(false);
    expect(isJsonRpcResponse(validRequest)).toBe(false);
  });

  it("identifies valid JSON-RPC notifications using isJsonRpcNotification", () => {
    const validNotification = createAcpNotification("session/update", {
      sessionId: "sess_123",
      seq: 1,
      timestamp: Date.now(),
      update: { kind: "text_chunk", delta: "Hello world" },
    });

    expect(isJsonRpcNotification(validNotification)).toBe(true);
    expect(isJsonRpcRequest(validNotification)).toBe(false);
  });

  it("identifies valid JSON-RPC success responses", () => {
    const successResponse = createAcpSuccessResponse(1, {
      protocolVersion: "1.0.0",
      agentInfo: { name: "superagent", version: "1.14.107" },
      capabilities: { promptStreaming: true },
      supportedMethods: ["initialize", "session/new", "session/prompt"],
    });

    expect(isJsonRpcResponse(successResponse)).toBe(true);
    expect("result" in successResponse).toBe(true);
  });

  it("identifies valid JSON-RPC error responses with standard codes", () => {
    const errorResponse = createAcpErrorResponse(
      2,
      ACP_ERROR_CODES.SESSION_NOT_FOUND,
      "Session not found or expired"
    );

    expect(isJsonRpcResponse(errorResponse)).toBe(true);
    expect("error" in errorResponse).toBe(true);
    if ("error" in errorResponse) {
      expect(errorResponse.error.code).toBe(-32001);
      expect(errorResponse.error.message).toContain("Session not found");
    }
  });
});

describe("ACP Mapper - Timeline Events to ACP Notifications", () => {
  const baseTime = Date.now();

  it("maps tool_start and tool_end correctly", () => {
    const startEvent: AgentTimelineEvent = {
      seq: 1,
      at: baseTime,
      kind: "tool_start",
      actor: "main",
      tool: "read_files",
      callId: "call_abc",
    };

    const updateStart = mapTimelineEventToAcpUpdate(startEvent);
    expect(updateStart.kind).toBe("tool_call_start");
    if (updateStart.kind === "tool_call_start") {
      expect(updateStart.tool).toBe("read_files");
      expect(updateStart.callId).toBe("call_abc");
    }

    const endEvent: AgentTimelineEvent = {
      seq: 2,
      at: baseTime + 100,
      kind: "tool_end",
      actor: "main",
      tool: "read_files",
      callId: "call_abc",
      status: "completed",
    };

    const updateEnd = mapTimelineEventToAcpUpdate(endEvent);
    expect(updateEnd.kind).toBe("tool_call_end");
    if (updateEnd.kind === "tool_call_end") {
      expect(updateEnd.status).toBe("completed");
    }
  });

  it("creates a well-formed session/update notification", () => {
    const subagentEvent: AgentTimelineEvent = {
      seq: 3,
      at: baseTime + 200,
      kind: "subagent_status",
      actor: "subagent_coder_1",
      tool: "coder",
      status: "running",
      parent: "main",
    };

    const notification = createAcpSessionUpdateNotification("session_xyz", subagentEvent);
    expect(notification.method).toBe("session/update");
    expect(notification.params.sessionId).toBe("session_xyz");
    expect(notification.params.seq).toBe(3);
    expect(notification.params.update.kind).toBe("subagent_status");
  });
});

describe("ACP Mapper - Human-in-the-Loop Permissions", () => {
  it("maps ApprovalRecord to ACP session/request_permission", () => {
    const now = Date.now();
    const record: ApprovalRecord = {
      permissionId: "perm_789",
      sessionId: "session_001",
      workspace: "D:/project",
      state: "pending",
      requestedAt: now,
      updatedAt: now,
      expiresAt: now + 60000,
    };

    const req = mapApprovalRecordToAcpPermissionRequest(record, {
      action: "command_execute",
      target: "npm install",
      description: "Install dependencies",
    });

    expect(req.method).toBe("session/request_permission");
    expect(req.id).toBe("perm_789");
    expect(req.params.permissionId).toBe("perm_789");
    expect(req.params.riskLevel).toBe("high");
    expect(req.params.action).toBe("command_execute");
    expect(req.params.expiresInMs).toBeGreaterThan(0);
  });

  it("maps ACP approval decisions back to Superagent state", () => {
    expect(mapAcpDecisionToApprovalState("approved")).toBe("approved");
    expect(mapAcpDecisionToApprovalState("approved_session")).toBe("approved_session");
    expect(mapAcpDecisionToApprovalState("denied")).toBe("denied");
    expect(mapAcpDecisionToApprovalState("cancelled")).toBe("cancelled");
  });
});
