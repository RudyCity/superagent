import { WebSocketServer, WebSocket } from "ws";
import { setBrowserControlHandler, browserControlHandler } from "./browserMacroTools.js";

const DEFAULT_REMOTE_WS_PORT = 9223;

let wss: WebSocketServer | null = null;
let activeClient: WebSocket | null = null;
const pendingRequests = new Map<
  string,
  { resolve: (value: string) => void; reject: (reason: any) => void; timeout: NodeJS.Timeout }
>();

let messageCounter = 0;

/**
 * Initializes a serverless WebSocket server on port 9223 for Superagent CLI remote control.
 * Allows CLI tools to communicate directly with Superagent Remote Chrome Extension without running `superagent --server`.
 */
export function ensureRemoteChromeBridge(port: number = DEFAULT_REMOTE_WS_PORT): Promise<boolean> {
  if (wss) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    try {
      wss = new WebSocketServer({ port });

      wss.on("listening", () => {
        // Register the serverless handler
        setBrowserControlHandler(sendRemoteCommand);
        resolve(true);
      });

      wss.on("connection", (ws: WebSocket) => {
        activeClient = ws;

        ws.on("message", (raw: Buffer | string) => {
          try {
            const data = JSON.parse(raw.toString());
            const { id, success, result, error } = data;

            if (id && pendingRequests.has(id)) {
              const pending = pendingRequests.get(id)!;
              clearTimeout(pending.timeout);
              pendingRequests.delete(id);

              if (success) {
                pending.resolve(result || "");
              } else {
                pending.reject(new Error(error || "Remote Chrome Extension returned failure status."));
              }
            }
          } catch {}
        });

        ws.on("close", () => {
          if (activeClient === ws) {
            activeClient = null;
          }
        });
      });

      wss.on("error", (err: any) => {
        // Port taken or error occurred; if server already running elsewhere, fallback gracefully
        if (!browserControlHandler) {
          setBrowserControlHandler(sendRemoteCommand);
        }
        resolve(false);
      });
    } catch (err) {
      if (!browserControlHandler) {
        setBrowserControlHandler(sendRemoteCommand);
      }
      resolve(false);
    }
  });
}

/**
 * Sends a command to the connected Superagent Remote Chrome Extension via WebSocket.
 */
export function sendRemoteCommand(
  action: string,
  target: string,
  value?: string,
  instanceId?: string
): Promise<string> {
  if (!activeClient || activeClient.readyState !== WebSocket.OPEN) {
    return Promise.reject(
      new Error(
        "Superagent Remote Chrome Extension is not connected. " +
          "Ensure Superagent Remote Bridge extension is installed in Chrome and active on port 9223."
      )
    );
  }

  const id = `req_${Date.now()}_${++messageCounter}`;

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        reject(new Error(`Timeout waiting for Remote Chrome Extension response to action '${action}'.`));
      }
    }, 15000);

    pendingRequests.set(id, { resolve, reject, timeout });

    try {
      activeClient!.send(
        JSON.stringify({
          id,
          action,
          target,
          value,
          instanceId,
        })
      );
    } catch (err) {
      clearTimeout(timeout);
      pendingRequests.delete(id);
      reject(err);
    }
  });
}

/**
 * Stop serverless bridge server.
 */
export function stopRemoteChromeBridge(): Promise<void> {
  return new Promise((resolve) => {
    // Clear pending request timeouts and reject pending promises
    for (const [id, pending] of pendingRequests.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Remote Chrome Bridge server stopped."));
    }
    pendingRequests.clear();

    if (activeClient) {
      try {
        activeClient.close();
      } catch {}
      activeClient = null;
    }

    if (wss) {
      const server = wss;
      wss = null;
      setBrowserControlHandler(null);
      server.close(() => {
        resolve();
      });
      // Fallback resolve if server.close callback is delayed
      setTimeout(resolve, 50);
    } else {
      setBrowserControlHandler(null);
      resolve();
    }
  });
}
