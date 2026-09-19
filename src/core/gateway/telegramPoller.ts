import { gatewayManager } from "./gatewayManager.js";
import { createAgentExecutor } from "./gatewayServer.js";

export interface TelegramPollerOptions {
  botToken?: string;
  workspace?: string;
  signal?: AbortSignal;
  silent?: boolean;
}

export async function startTelegramPolling(options: TelegramPollerOptions = {}): Promise<void> {
  const cfg = gatewayManager.getConfig();
  const token = options.botToken || cfg.channels.telegram?.botToken;
  const workspace = options.workspace || cfg.defaultWorkspace || process.cwd();
  const adapter = gatewayManager.getAdapter("telegram");

  if (!token) {
    throw new Error(
      "No Telegram bot token configured. Set it via '/gateway config telegram botToken <token>' or pass it to poller."
    );
  }

  const executeAgentPrompt = await createAgentExecutor(workspace);

  if (!options.silent) {
    console.log("Starting Telegram Bot Long-Polling loop...");
    console.log(`- Workspace: ${workspace}`);
    console.log("- Mode: Direct getUpdates (no webhook or public port required)");
    console.log("- Press Ctrl+C to stop polling\n");
  }

  // Clear existing webhook so getUpdates succeeds
  try {
    const delRes = await fetch(`https://api.telegram.org/bot${token}/deleteWebhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ drop_pending_updates: false }),
    });
    if (!delRes.ok && !options.silent) {
      console.warn("Notice: deleteWebhook returned non-200, proceeding with polling anyway.");
    }
  } catch (err: any) {
    if (!options.silent) {
      console.warn(`Notice: Could not reset webhook: ${err.message}`);
    }
  }

  let offset = 0;
  let consecutiveErrors = 0;

  while (!options.signal?.aborted) {
    try {
      const url = `https://api.telegram.org/bot${token}/getUpdates?offset=${offset}&timeout=20`;
      const res = await fetch(url, {
        signal: options.signal,
      });

      if (!res.ok) {
        throw new Error(`Telegram API responded with status ${res.status}`);
      }

      const data = await res.json() as { ok: boolean; result?: any[] };
      consecutiveErrors = 0;

      if (data.ok && Array.isArray(data.result) && data.result.length > 0) {
        for (const update of data.result) {
          offset = Math.max(offset, (update.update_id || 0) + 1);

          const inbound = adapter.parseInbound(update);
          if (!inbound) continue;

          if (!adapter.isUserAllowed(inbound.senderId)) {
            if (!options.silent) {
              console.log(`[Telegram] Ignored message from unauthorized user ID: ${inbound.senderId}`);
            }
            continue;
          }

          if (!options.silent) {
            console.log(`[Telegram] Received from ${inbound.senderName} (${inbound.senderId}): "${inbound.text}"`);
          }

          // Process inbound message through Gateway Manager with autonomous agent execution
          const runner = async (msg: typeof inbound) => {
            return await executeAgentPrompt(msg.text, workspace);
          };

          try {
            const outbound = await gatewayManager.processInbound(inbound, runner);
            if (!options.silent) {
              console.log(`[Telegram] Replied to ${inbound.senderId} (${outbound.status})`);
            }
          } catch (execErr: any) {
            if (!options.silent) {
              console.error(`[Telegram] Error handling message: ${execErr.message}`);
            }
            await adapter.sendReply(inbound.senderId, `Error processing request: ${execErr.message}`);
          }
        }
      }
    } catch (err: any) {
      if (options.signal?.aborted || err.name === "AbortError") {
        break;
      }
      consecutiveErrors++;
      const backoffMs = Math.min(1000 * Math.pow(2, consecutiveErrors), 15000);
      if (!options.silent) {
        console.error(`[Telegram Polling Error] ${err.message}. Retrying in ${backoffMs}ms...`);
      }
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }

  if (!options.silent) {
    console.log("Telegram bot polling stopped cleanly.");
  }
}
