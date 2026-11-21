/**
 * Agent Client Protocol (ACP) - Server Transport Implementation
 * Handles bidirectional JSON-RPC 2.0 communication over line-delimited streams
 * (stdio, Unix sockets, or duplex streams) connecting T-Line and Superagent.
 */

import { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";
import {
  ACP_ERROR_CODES,
  ACP_PROTOCOL_VERSION,
  type AcpAgentCapabilities,
  type AcpUpdatePayload,
  type InitializeParams,
  type InitializeResult,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type RequestPermissionParams,
  type RequestPermissionResult,
  type SessionCancelParams,
  type SessionCancelResult,
  type SessionNewParams,
  type SessionNewResult,
  type SessionPromptParams,
  type SessionPromptResult,
  type SessionUpdateParams,
  createAcpErrorResponse,
  createAcpNotification,
  createAcpRequest,
  createAcpSuccessResponse,
  isJsonRpcNotification,
  isJsonRpcRequest,
  isJsonRpcResponse,
} from "./types.js";

export type AcpRequestHandler<TParams = any, TResult = any> = (
  params: TParams,
  id: JsonRpcId
) => Promise<TResult> | TResult;

export type AcpNotificationHandler<TParams = any> = (
  params: TParams
) => Promise<void> | void;

export interface AcpServerOptions {
  name?: string;
  version?: string;
  capabilities?: AcpAgentCapabilities;
  inputStream: Readable;
  outputStream: Writable;
  onPrompt?: (
    params: SessionPromptParams,
    server: AcpServer
  ) => Promise<void> | void;
}

export interface ActiveSession {
  sessionId: string;
  workspacePath: string;
  clientMode?: string;
  createdAt: number;
}

export class AcpServer extends EventEmitter {
  public readonly name: string;
  public readonly version: string;
  public readonly capabilities: AcpAgentCapabilities;

  private inputStream: Readable;
  private outputStream: Writable;
  private buffer = "";
  private isRunning = false;

  private requestHandlers = new Map<string, AcpRequestHandler>();
  private notificationHandlers = new Map<string, AcpNotificationHandler>();
  private pendingOutboundRequests = new Map<
    string | number,
    {
      resolve: (value: any) => void;
      reject: (reason: any) => void;
      timer: NodeJS.Timeout;
    }
  >();

  private activeSessions = new Map<string, ActiveSession>();
  private messageSeq = 0;
  private outboundRequestId = 1;
  private onDataBound: (chunk: Buffer | string) => void;

  constructor(options: AcpServerOptions) {
    super();
    this.name = options.name || "superagent-core";
    this.version = options.version || "1.14.107";
    this.capabilities = {
      promptStreaming: true,
      toolExecution: true,
      multiTierAgents: true,
      permissionEscalation: true,
      supportedTools: ["read_files", "write_file", "execute_command", "mcp_tool"],
      ...(options.capabilities || {}),
    };

    this.inputStream = options.inputStream;
    this.outputStream = options.outputStream;
    this.onDataBound = this.handleData.bind(this);

    // Register built-in default ACP handlers
    this.registerDefaultHandlers(options.onPrompt);
  }

  /**
   * Registers default ACP protocol methods: initialize, session/new, session/prompt, session/cancel.
   */
  private registerDefaultHandlers(
    onPrompt?: (params: SessionPromptParams, server: AcpServer) => Promise<void> | void
  ): void {
    // 1. initialize
    this.onRequest<InitializeParams, InitializeResult>(
      "initialize",
      async (params) => {
        this.emit("initialized", params);
        return {
          protocolVersion: ACP_PROTOCOL_VERSION,
          agentInfo: {
            name: this.name,
            version: this.version,
          },
          capabilities: this.capabilities,
          supportedMethods: [
            "initialize",
            "session/new",
            "session/prompt",
            "session/cancel",
            "session/request_permission",
          ],
        };
      }
    );

    // 2. session/new
    this.onRequest<SessionNewParams, SessionNewResult>(
      "session/new",
      async (params) => {
        const sessionId =
          params.sessionId || `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const session: ActiveSession = {
          sessionId,
          workspacePath: params.workspacePath,
          clientMode: params.clientMode || "tline",
          createdAt: Date.now(),
        };

        this.activeSessions.set(sessionId, session);
        this.emit("session_created", session);

        return {
          sessionId,
          workspacePath: session.workspacePath,
          status: "ready",
          createdAt: session.createdAt,
        };
      }
    );

    // 3. session/cancel
    this.onRequest<SessionCancelParams, SessionCancelResult>(
      "session/cancel",
      async (params) => {
        const session = this.activeSessions.get(params.sessionId);
        if (!session) {
          throw {
            code: ACP_ERROR_CODES.SESSION_NOT_FOUND,
            message: `Session ${params.sessionId} not found`,
          };
        }

        this.emit("session_cancelled", { sessionId: params.sessionId, reason: params.reason });
        return {
          sessionId: params.sessionId,
          cancelled: true,
          stoppedAt: Date.now(),
        };
      }
    );

    // 4. session/prompt
    this.onRequest<SessionPromptParams, SessionPromptResult>(
      "session/prompt",
      async (params) => {
        const session = this.activeSessions.get(params.sessionId);
        if (!session) {
          throw {
            code: ACP_ERROR_CODES.SESSION_NOT_FOUND,
            message: `Session ${params.sessionId} not found`,
          };
        }

        const promptId = `prompt_${Date.now()}`;
        this.emit("prompt_received", { promptId, params });

        if (onPrompt) {
          // Trigger asynchronous background execution
          Promise.resolve(onPrompt(params, this)).catch((err) => {
            this.sendUpdate(params.sessionId, {
              kind: "status_change",
              status: "error",
              summary: err instanceof Error ? err.message : String(err),
            });
          });
        }

        return {
          promptId,
          sessionId: params.sessionId,
          accepted: true,
          startedAt: Date.now(),
        };
      }
    );
  }

  /**
   * Starts listening for incoming JSON-RPC lines on the input stream.
   */
  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.inputStream.on("data", this.onDataBound);
    this.inputStream.on("error", (err) => this.emit("error", err));
  }

  /**
   * Stops listening and cleans up pending requests.
   */
  public close(): void {
    if (!this.isRunning) return;
    this.isRunning = false;
    this.inputStream.off("data", this.onDataBound);

    for (const [id, pending] of this.pendingOutboundRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error("ACP Server closed"));
    }
    this.pendingOutboundRequests.clear();
    this.activeSessions.clear();
  }

  /**
   * Registers a custom handler for a JSON-RPC request method.
   */
  public onRequest<TParams = any, TResult = any>(
    method: string,
    handler: AcpRequestHandler<TParams, TResult>
  ): void {
    this.requestHandlers.set(method, handler);
  }

  /**
   * Registers a custom handler for a JSON-RPC notification method.
   */
  public onNotification<TParams = any>(
    method: string,
    handler: AcpNotificationHandler<TParams>
  ): void {
    this.notificationHandlers.set(method, handler);
  }

  /**
   * Sends a streaming notification (e.g. `session/update`) to the client.
   */
  public sendNotification<TParams>(method: string, params: TParams): void {
    const notification = createAcpNotification(method, params);
    this.writeMessage(notification);
  }

  /**
   * Sends an ACP `session/update` delta update to the client.
   */
  public sendUpdate(sessionId: string, update: AcpUpdatePayload): void {
    this.messageSeq++;
    const params: SessionUpdateParams = {
      sessionId,
      seq: this.messageSeq,
      timestamp: Date.now(),
      update,
    };
    this.sendNotification("session/update", params);
  }

  /**
   * Sends a reverse request to the client asking for user permission (`session/request_permission`).
   */
  public async requestPermission(
    params: Omit<RequestPermissionParams, "expiresInMs"> & { expiresInMs?: number }
  ): Promise<RequestPermissionResult> {
    const timeoutMs = params.expiresInMs || 5 * 60_000;
    const fullParams: RequestPermissionParams = {
      ...params,
      expiresInMs: timeoutMs,
    };

    const id = `perm_req_${this.outboundRequestId++}`;
    const request = createAcpRequest(id, "session/request_permission", fullParams);

    return new Promise<RequestPermissionResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingOutboundRequests.delete(id);
        reject({
          code: ACP_ERROR_CODES.PERMISSION_EXPIRED,
          message: `Permission request ${params.permissionId} timed out`,
        });
      }, timeoutMs);

      this.pendingOutboundRequests.set(id, { resolve, reject, timer });
      this.writeMessage(request);
    });
  }

  /**
   * Writes a raw JSON-RPC message ending with a newline delimiter.
   */
  private writeMessage(msg: JsonRpcMessage): void {
    try {
      const serialized = JSON.stringify(msg) + "\n";
      this.outputStream.write(serialized);
    } catch (err) {
      this.emit("error", err);
    }
  }

  /**
   * Parses line-delimited chunks from the incoming stream.
   */
  private handleData(chunk: Buffer | string): void {
    this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf-8");

    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);

      if (line.length > 0) {
        this.processMessageLine(line);
      }
    }
  }

  /**
   * Dispatches an individual line message.
   */
  private async processMessageLine(line: string): Promise<void> {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      this.writeMessage(
        createAcpErrorResponse(null, ACP_ERROR_CODES.PARSE_ERROR, "Parse error: Malformed JSON")
      );
      return;
    }

    // 1. Inbound Request
    if (isJsonRpcRequest(msg)) {
      await this.handleIncomingRequest(msg);
      return;
    }

    // 2. Inbound Notification
    if (isJsonRpcNotification(msg)) {
      await this.handleIncomingNotification(msg);
      return;
    }

    // 3. Inbound Response (e.g. response to outbound permission request)
    if (isJsonRpcResponse(msg)) {
      this.handleIncomingResponse(msg);
      return;
    }

    // Invalid JSON-RPC shape
    this.writeMessage(
      createAcpErrorResponse(null, ACP_ERROR_CODES.INVALID_REQUEST, "Invalid JSON-RPC 2.0 object")
    );
  }

  private async handleIncomingRequest(request: JsonRpcRequest): Promise<void> {
    const handler = this.requestHandlers.get(request.method);
    if (!handler) {
      this.writeMessage(
        createAcpErrorResponse(
          request.id,
          ACP_ERROR_CODES.METHOD_NOT_FOUND,
          `Method '${request.method}' not found`
        )
      );
      return;
    }

    try {
      const result = await handler(request.params, request.id);
      this.writeMessage(createAcpSuccessResponse(request.id, result));
    } catch (err: any) {
      const code = typeof err?.code === "number" ? err.code : ACP_ERROR_CODES.INTERNAL_ERROR;
      const message = typeof err?.message === "string" ? err.message : String(err);
      this.writeMessage(createAcpErrorResponse(request.id, code, message, err?.data));
    }
  }

  private async handleIncomingNotification(notification: JsonRpcNotification): Promise<void> {
    const handler = this.notificationHandlers.get(notification.method);
    if (handler) {
      try {
        await handler(notification.params);
      } catch (err) {
        this.emit("error", err);
      }
    }
  }

  private handleIncomingResponse(response: any): void {
    if (!response.id) return;
    const pending = this.pendingOutboundRequests.get(response.id);
    if (!pending) return;

    this.pendingOutboundRequests.delete(response.id);
    clearTimeout(pending.timer);

    if ("error" in response) {
      pending.reject(response.error);
    } else {
      pending.resolve(response.result);
    }
  }

  public getSession(sessionId: string): ActiveSession | undefined {
    return this.activeSessions.get(sessionId);
  }
}
