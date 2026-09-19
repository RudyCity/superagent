import { gatewayManager } from "./gatewayManager.js";
import { createAgentExecutor } from "./gatewayServer.js";

export interface SlackPollerOptions {
  botToken?: string;
  appToken?: string;
  workspace?: string;
  signal?: AbortSignal;
  silent?: boolean;
}

export async function startSlackSocketMode(options: SlackPollerOptions = {}): Promise<void> {
  const cfg = gatewayManager.getConfig();
  const botToken = options.botToken || cfg.channels.slack?.botToken;
  const appToken = options.appToken || cfg.channels.slack?.appToken;
  const workspace = options.workspace || cfg.defaultWorkspace || process.cwd();
  const adapter = gatewayManager.getAdapter("slack");

  if (!appToken) {
    throw new Error(
      "No Slack app-level token (xapp-...) configured. Socket Mode requires an App Token with 'connections:write' scope. Configure it via '/gateway config slack appToken xapp-...'."
    );
  }

  if (!botToken) {
    throw new Error(
      "No Slack bot token (xoxb-...) configured. Configure it via '/gateway config slack botToken xoxb-...'."
    );
  }

  const executeAgentPrompt = await createAgentExecutor(workspace);

  if (!options.silent) {
    console.log("Starting Slack Socket Mode listener...");
    console.log(`- Workspace: ${workspace}`);
    console.log("- Mode: Real-time Socket Mode WebSocket (no public webhooks or open ports needed)");
    console.log("- Press Ctrl+C to disconnect\n");
  }

  // Request WebSocket link from Slack
  let wssUrl: string;
  try {
    const res = await fetch("https://slack.com/api/apps.connections.open", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Authorization": `Bearer ${appToken.trim()}`,
      },
    });

    const data = (await res.json().catch(() => ({}))) as { ok: boolean; url?: string; error?: string };
    if (!res.ok || !data.ok || !data.url) {
      throw new Error(`Slack API error: ${data.error || `HTTP ${res.status}`}`);
    }
    wssUrl = data.url;
  } catch (err: any) {
    throw new Error(`Failed to open Slack Socket Mode connection: ${err.message}`);
  }

  return new Promise((resolve, reject) => {
    let ws: WebSocket | null = null;
    let isConnected = false;

    const cleanup = () => {
      if (ws) {
        try {
          ws.close();
        } catch {}
        ws = null;
      }
    };

    if (options.signal) {
      options.signal.addEventListener("abort", () => {
        cleanup();
        if (!options.silent) {
          console.log("Slack socket listener disconnected.");
        }
        resolve();
      });
    }

    try {
      ws = new WebSocket(wssUrl);

      ws.onopen = () => {
        isConnected = true;
        if (!options.silent) {
          console.log("[Slack Socket Mode] Connected to Slack gateway.");
        }
      };

      ws.onmessage = async (event: MessageEvent) => {
        try {
          const raw = typeof event.data === "string" ? event.data : event.data.toString();
          const payload = JSON.parse(raw);

          // Acknowledge envelope immediately so Slack does not retry
          if (payload.envelope_id && ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ envelope_id: payload.envelope_id }));
          }

          // Handle events_api payloads
          if (payload.type === "events_api" && payload.payload) {
            const innerEvent = payload.payload.event;
            if (!innerEvent || innerEvent.bot_id || innerEvent.subtype === "bot_message") {
              return;
            }

            const senderUser = String(innerEvent.user || "");
            if (!adapter.isUserAllowed(senderUser)) {
              if (!options.silent) {
                console.log(`[Slack] Ignored message from unauthorized user: ${senderUser}`);
              }
              return;
            }

            const inbound = adapter.parseInbound(payload.payload);
            if (!inbound) return;

            const channelId = String(innerEvent.channel || inbound.senderId);
            if (!options.silent) {
              console.log(`[Slack] Received from ${senderUser} in #${channelId}: "${inbound.text}"`);
            }

            const runner = async (msg: typeof inbound) => {
              return await executeAgentPrompt(msg.text, workspace);
            };

            try {
              const outbound = await gatewayManager.processInbound(inbound, runner);
              if (!options.silent) {
                console.log(`[Slack] Replied to channel ${channelId} (${outbound.status})`);
              }
            } catch (err: any) {
              if (!options.silent) {
                console.error(`[Slack] Error processing message: ${err.message}`);
              }
              await adapter.sendReply(channelId, `Error processing message: ${err.message}`);
            }
          }

          // Handle disconnect requests from Slack
          if (payload.type === "disconnect") {
            if (!options.silent) {
              console.log(`[Slack Socket Mode] Disconnect requested: ${payload.reason || "unknown"}`);
            }
            cleanup();
            resolve();
          }
        } catch (err: any) {
          if (!options.silent) {
            console.error(`[Slack Socket Error] ${err.message}`);
          }
        }
      };

      ws.onerror = (err) => {
        if (!isConnected) {
          cleanup();
          reject(new Error(`Slack Socket Mode connection error: ${err}`));
        } else if (!options.silent) {
          console.error("[Slack Socket Error] Socket error encountered.");
        }
      };

      ws.onclose = () => {
        cleanup();
        if (!options.silent) {
          console.log("[Slack Socket Mode] Connection closed.");
        }
        resolve();
      };
    } catch (err: any) {
      cleanup();
      reject(err);
    }
  });
}
