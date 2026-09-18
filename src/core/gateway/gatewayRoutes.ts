import http from "http";
import { URL } from "url";
import { gatewayManager } from "./gatewayManager.js";
import { GatewayInboundMessage, GatewaySessionMapping } from "./gatewayTypes.js";

export async function handleGatewayRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  parsedUrl: URL,
  ctx: {
    sendJSON: (res: http.ServerResponse, status: number, data: any) => void;
    readBody: (req: http.IncomingMessage) => Promise<string>;
    executeAgentPrompt?: (prompt: string, workspace: string, sessionId?: string) => Promise<string>;
  }
): Promise<boolean> {
  const { sendJSON, readBody, executeAgentPrompt } = ctx;

  const defaultRunner = async (inbound: GatewayInboundMessage, session: GatewaySessionMapping): Promise<string> => {
    if (executeAgentPrompt) {
      return await executeAgentPrompt(inbound.text, session.workspace, session.sessionId);
    }
    return `[Echo via Gateway]: Received message "${inbound.text}" in session ${session.sessionId}`;
  };

  // Status
  if (pathname === "/api/gateway/status" && req.method === "GET") {
    sendJSON(res, 200, { success: true, ...gatewayManager.getStatus() });
    return true;
  }

  // Get Config
  if (pathname === "/api/gateway/config" && req.method === "GET") {
    sendJSON(res, 200, { success: true, config: gatewayManager.getConfig() });
    return true;
  }

  // Update Config
  if (pathname === "/api/gateway/config" && req.method === "POST") {
    try {
      const rawBody = await readBody(req);
      const updates = JSON.parse(rawBody || "{}");
      const updated = gatewayManager.updateConfig(updates);
      sendJSON(res, 200, { success: true, config: updated });
    } catch (err: any) {
      sendJSON(res, 400, { error: err.message || "Invalid JSON payload" });
    }
    return true;
  }

  // Webhook
  if (pathname === "/api/gateway/webhook" && req.method === "POST") {
    const adapter = gatewayManager.getAdapter("webhook");
    if (!adapter.isAuthorized(req.headers as any)) {
      sendJSON(res, 401, { error: "Unauthorized: Invalid webhook secret token" });
      return true;
    }

    try {
      const rawBody = await readBody(req);
      const body = JSON.parse(rawBody || "{}");
      const inbound = adapter.parseInbound(body, req.headers as any);
      const outbound = await gatewayManager.processInbound(inbound, defaultRunner);
      sendJSON(res, outbound.status === "error" ? 400 : 200, outbound);
    } catch (err: any) {
      sendJSON(res, 500, { error: err.message || "Internal webhook error" });
    }
    return true;
  }

  // Telegram
  if (pathname === "/api/gateway/telegram" && req.method === "POST") {
    const adapter = gatewayManager.getAdapter("telegram");
    if (!adapter.isAuthorized(req.headers as any)) {
      sendJSON(res, 401, { error: "Unauthorized: Invalid Telegram secret token" });
      return true;
    }

    try {
      const rawBody = await readBody(req);
      const body = JSON.parse(rawBody || "{}");
      const inbound = adapter.parseInbound(body);
      if (!inbound) {
        // Return 200 OK so Telegram does not retry unhandled non-message updates
        sendJSON(res, 200, { ok: true, ignored: true });
        return true;
      }
      const outbound = await gatewayManager.processInbound(inbound, defaultRunner);
      sendJSON(res, 200, { ok: outbound.status === "success", result: outbound });
    } catch (err: any) {
      sendJSON(res, 500, { error: err.message });
    }
    return true;
  }

  // Discord
  if (pathname === "/api/gateway/discord" && req.method === "POST") {
    const adapter = gatewayManager.getAdapter("discord");
    try {
      const rawBody = await readBody(req);
      const body = JSON.parse(rawBody || "{}");

      // Handle Discord Ping (Type 1)
      if (body?.type === 1) {
        sendJSON(res, 200, { type: 1 });
        return true;
      }

      const inbound = adapter.parseInbound(body);
      if (!inbound) {
        sendJSON(res, 200, { ignored: true });
        return true;
      }

      const outbound = await gatewayManager.processInbound(inbound, defaultRunner);
      sendJSON(res, 200, {
        type: 4, // ChannelMessageWithSource
        data: {
          content: outbound.text
        }
      });
    } catch (err: any) {
      sendJSON(res, 500, { error: err.message });
    }
    return true;
  }

  // Slack
  if (pathname === "/api/gateway/slack" && req.method === "POST") {
    const adapter = gatewayManager.getAdapter("slack");
    try {
      const rawBody = await readBody(req);
      const body = JSON.parse(rawBody || "{}");

      // Handle Slack URL verification challenge
      const verification = adapter.handleUrlVerification(body);
      if (verification) {
        sendJSON(res, 200, verification);
        return true;
      }

      const inbound = adapter.parseInbound(body);
      if (!inbound) {
        sendJSON(res, 200, { ok: true, ignored: true });
        return true;
      }

      const outbound = await gatewayManager.processInbound(inbound, defaultRunner);
      sendJSON(res, 200, { ok: outbound.status === "success", text: outbound.text });
    } catch (err: any) {
      sendJSON(res, 500, { error: err.message });
    }
    return true;
  }

  return false;
}
