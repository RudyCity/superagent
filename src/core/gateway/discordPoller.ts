import { gatewayManager } from "./gatewayManager.js";
import { createAgentExecutor } from "./gatewayServer.js";

export interface DiscordPollerOptions {
  botToken?: string;
  workspace?: string;
  signal?: AbortSignal;
  silent?: boolean;
}

export async function startDiscordGateway(options: DiscordPollerOptions = {}): Promise<void> {
  const cfg = gatewayManager.getConfig();
  const token = options.botToken || cfg.channels.discord?.botToken;
  const workspace = options.workspace || cfg.defaultWorkspace || process.cwd();
  const adapter = gatewayManager.getAdapter("discord");

  if (!token) {
    throw new Error(
      "No Discord bot token configured. Set it via '/gateway config discord botToken <token>' or pass it to poller."
    );
  }

  const executeAgentPrompt = await createAgentExecutor(workspace);

  if (!options.silent) {
    console.log("Starting Discord Gateway WebSocket connection...");
    console.log(`- Workspace: ${workspace}`);
    console.log("- Mode: Real-time Gateway WebSocket (no webhook or open port needed)");
    console.log("- Press Ctrl+C to disconnect\n");
  }

  return new Promise((resolve, reject) => {
    let ws: WebSocket | null = null;
    let heartbeatIntervalId: any = null;
    let sequenceNumber: number | null = null;
    let isConnected = false;

    const cleanup = () => {
      if (heartbeatIntervalId) {
        clearInterval(heartbeatIntervalId);
        heartbeatIntervalId = null;
      }
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
          console.log("Discord gateway listener disconnected.");
        }
        resolve();
      });
    }

    try {
      ws = new WebSocket("wss://gateway.discord.gg/?v=10&encoding=json");

      ws.onopen = () => {
        isConnected = true;
        if (!options.silent) {
          console.log("[Discord Gateway] WebSocket handshake connected.");
        }
      };

      ws.onmessage = async (event: MessageEvent) => {
        try {
          const raw = typeof event.data === "string" ? event.data : event.data.toString();
          const payload = JSON.parse(raw);

          const { op, d, s, t } = payload;
          if (s !== undefined && s !== null) {
            sequenceNumber = s;
          }

          // Opcode 10: Hello -> start heartbeat and send Identify
          if (op === 10) {
            const heartbeatMs = d.heartbeat_interval;
            heartbeatIntervalId = setInterval(() => {
              if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ op: 1, d: sequenceNumber }));
              }
            }, heartbeatMs);

            // Send Identify
            const identifyPayload = {
              op: 2,
              d: {
                token: token.trim(),
                intents: 37377, // GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT
                properties: {
                  os: process.platform,
                  browser: "superagent",
                  device: "superagent",
                },
              },
            };
            if (ws && ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify(identifyPayload));
            }
          }

          // Opcode 11: Heartbeat ACK
          if (op === 11) {
            // Heartbeat acknowledged
          }

          // Opcode 0: Dispatch event
          if (op === 0 && t === "READY") {
            if (!options.silent) {
              console.log(`[Discord Gateway] Bot logged in as ${d.user?.username}#${d.user?.discriminator || "0"}`);
            }
          }

          if (op === 0 && t === "MESSAGE_CREATE") {
            // Avoid responding to other bots or self
            if (d.author?.bot) return;

            const text = String(d.content || "").trim();
            if (!text) return;

            const authorId = String(d.author?.id || "");
            if (!adapter.isUserAllowed(authorId)) {
              if (!options.silent) {
                console.log(`[Discord] Ignored message from unauthorized user ID: ${authorId}`);
              }
              return;
            }

            const channelId = String(d.channel_id || authorId);
            if (!options.silent) {
              console.log(`[Discord] Received from ${d.author?.username} in #${channelId}: "${text}"`);
            }

            const inbound = adapter.parseInbound(d);
            if (!inbound) return;

            const runner = async (msg: typeof inbound) => {
              return await executeAgentPrompt(msg.text, workspace);
            };

            try {
              const outbound = await gatewayManager.processInbound(inbound, runner);
              if (!options.silent) {
                console.log(`[Discord] Replied to channel ${channelId} (${outbound.status})`);
              }
            } catch (err: any) {
              if (!options.silent) {
                console.error(`[Discord] Failed to process message: ${err.message}`);
              }
              await adapter.sendReply(channelId, `Error processing message: ${err.message}`);
            }
          }
        } catch (err: any) {
          if (!options.silent) {
            console.error(`[Discord Gateway Error] ${err.message}`);
          }
        }
      };

      ws.onerror = (err) => {
        if (!isConnected) {
          cleanup();
          reject(new Error(`Failed to connect to Discord Gateway WebSocket: ${err}`));
        } else if (!options.silent) {
          console.error("[Discord Gateway Error] Connection error encountered.");
        }
      };

      ws.onclose = () => {
        cleanup();
        if (!options.silent) {
          console.log("[Discord Gateway] Connection closed.");
        }
        resolve();
      };
    } catch (err: any) {
      cleanup();
      reject(err);
    }
  });
}
