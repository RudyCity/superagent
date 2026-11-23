/**
 * Agent Client Protocol (ACP) - HTTP & SSE Transport Adapter
 * Provides remote loopback and network connectivity for T-Line and external editors
 * via REST POST /api/acp and Server-Sent Events (SSE) /api/acp/stream.
 */

import http from "node:http";
import { URL } from "node:url";
import { PassThrough } from "node:stream";
import { AcpRuntime, type AcpRuntimeOptions } from "./acpRuntime.js";
import {
  ACP_ERROR_CODES,
  createAcpErrorResponse,
  isJsonRpcRequest,
} from "./types.js";

export interface AcpHttpServerOptions extends AcpRuntimeOptions {
  port?: number;
  host?: string;
}

export class AcpHttpServer {
  public readonly port: number;
  public readonly host: string;
  public readonly runtime: AcpRuntime;
  private httpServer: http.Server | null = null;
  private sseClients = new Set<{ res: http.ServerResponse; sessionId?: string }>();
  private recentSessionUpdates = new Map<string, string[]>();
  private sessionTurnState = new Map<string, "thinking" | "done" | "error">();

  // Streams for ACP stdio simulation inside the HTTP adapter
  private clientToServer = new PassThrough();
  private serverToClient = new PassThrough();

  constructor(options?: AcpHttpServerOptions) {
    this.port = options?.port || 7890;
    this.host = options?.host || "127.0.0.1";

    this.runtime = new AcpRuntime({
      ...options,
      inputStream: this.clientToServer,
      outputStream: this.serverToClient,
    });

    // Listen to output from AcpServer and broadcast notifications to SSE subscribers
    let buffer = "";
    this.serverToClient.on("data", (chunk: Buffer | string) => {
      buffer += chunk.toString();
      let idx: number;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line) {
          this.broadcastSse(line);
        }
      }
    });
  }

  private recordSessionUpdate(parsed: any, ssePayload: string): void {
    const sessionId = parsed?.params?.sessionId;
    if (typeof sessionId !== "string" || !sessionId) return;

    const queue = this.recentSessionUpdates.get(sessionId) ?? [];
    queue.push(ssePayload);
    if (queue.length > 100) {
      queue.splice(0, queue.length - 100);
    }
    this.recentSessionUpdates.set(sessionId, queue);

    const update = parsed?.params?.update;
    if (update?.kind === "status_change") {
      if (update.status === "thinking") {
        this.sessionTurnState.set(sessionId, "thinking");
      } else if (update.status === "done" || update.status === "error") {
        this.sessionTurnState.set(sessionId, update.status);
      }
    }
  }

  private replayBufferedUpdates(res: http.ServerResponse, sessionId?: string): void {
    if (!sessionId || res.destroyed || res.writableEnded) return;
    const buffered = this.recentSessionUpdates.get(sessionId);
    if (buffered && buffered.length > 0) {
      for (const payload of buffered) {
        res.write(payload);
      }
    }
    const terminalStatus = this.sessionTurnState.get(sessionId);
    if (terminalStatus === "done" || terminalStatus === "error") {
      const fallbackFrame = JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            kind: "status_change",
            status: terminalStatus,
            summary: terminalStatus === "done" ? "Completed turn" : "Execution error",
          },
        },
      });
      res.write(`event: session/update\ndata: ${fallbackFrame}\n\n`);
    }
  }

  private broadcastSse(rawJson: string): void {
    try {
      const parsed = JSON.parse(rawJson);
      const eventName = parsed.method || (parsed.id ? "response" : "message");
      const ssePayload = `event: ${eventName}\ndata: ${rawJson}\n\n`;
      this.recordSessionUpdate(parsed, ssePayload);

      for (const client of this.sseClients) {
        if (!client.res.destroyed && !client.res.writableEnded) {
          if (
            !client.sessionId ||
            !parsed.params?.sessionId ||
            client.sessionId === parsed.params.sessionId
          ) {
            client.res.write(ssePayload);
          }
        }
      }
    } catch {}
  }

  public async start(): Promise<void> {
    this.runtime.start();

    return new Promise((resolve, reject) => {
      this.httpServer = http.createServer(async (req, res) => {
        try {
          await this.handleRequest(req, res);
        } catch (err: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err?.message || "Internal server error" }));
        }
      });

      this.httpServer.on("error", reject);
      this.httpServer.listen(this.port, this.host, () => {
        resolve();
      });
    });
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const pathname = url.pathname;

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-workspace-path");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // 1. SSE Stream: GET /api/acp/stream
    if (pathname === "/api/acp/stream" && req.method === "GET") {
      const sessionId = url.searchParams.get("sessionId") || undefined;
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });

      const client = { res, sessionId };
      this.sseClients.add(client);
      res.write(": heartbeat\n\n");
      this.replayBufferedUpdates(res, sessionId);

      req.on("close", () => {
        this.sseClients.delete(client);
      });
      return;
    }

    // 2. RPC Handler: POST /api/acp
    if (pathname === "/api/acp" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) {
        body += chunk;
      }

      let parsed: any;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify(
            createAcpErrorResponse(null, ACP_ERROR_CODES.PARSE_ERROR, "Invalid JSON payload")
          )
        );
        return;
      }

      if (!isJsonRpcRequest(parsed)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify(
            createAcpErrorResponse(null, ACP_ERROR_CODES.INVALID_REQUEST, "Expected JSON-RPC 2.0 request")
          )
        );
        return;
      }

      // Collect response from ServerToClient
      const requestId = parsed.id;
      const responsePromise = new Promise<string>((resolve) => {
        const handler = (chunk: Buffer | string) => {
          const text = chunk.toString();
          for (const line of text.split("\n")) {
            if (!line.trim()) continue;
            try {
              const msg = JSON.parse(line);
              if (msg.id === requestId) {
                this.serverToClient.off("data", handler);
                resolve(line);
              }
            } catch {}
          }
        };
        this.serverToClient.on("data", handler);
      });

      // Forward request to AcpServer input stream
      this.clientToServer.write(JSON.stringify(parsed) + "\n");

      const responseLine = await responsePromise;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(responseLine);
      return;
    }

    // Fallthrough 404
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `Not Found: ${pathname}` }));
  }

  public async close(): Promise<void> {
    for (const client of this.sseClients) {
      try {
        client.res.end();
      } catch {}
    }
    this.sseClients.clear();
    this.runtime.close();

    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer?.close(() => resolve());
      });
      this.httpServer = null;
    }
  }
}
