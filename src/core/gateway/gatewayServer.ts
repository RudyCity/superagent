import http from "http";
import { URL } from "url";
import { gatewayManager } from "./gatewayManager.js";
import { handleGatewayRoutes } from "./gatewayRoutes.js";

export interface GatewayServerOptions {
  port?: number;
  workspace?: string;
  silent?: boolean;
}

export function sendJSON(res: http.ServerResponse, status: number, data: any): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body, "utf-8"),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Superagent-Secret",
  });
  res.end(body);
}

export function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 5 * 1024 * 1024) {
        req.destroy();
        reject(new Error("Request payload too large (exceeds 5MB)"));
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

export async function createAgentExecutor(defaultWorkspace: string) {
  const { Agent } = await import("../agent.js");

  return async (prompt: string, workspace?: string, sessionId?: string): Promise<string> => {
    const ws = workspace || defaultWorkspace;
    let accumulatedText = "";

    return new Promise((resolve, reject) => {
      const agent = new Agent(
        (event) => {
          if (event.type === "text" && event.content) {
            accumulatedText += event.content;
          }
        },
        async () => true, // Auto-approve permissions in gateway headless mode
        async () => "continue",
        undefined,
        undefined,
        ws
      );

      const cfg = gatewayManager.getConfig();
      agent.isMultiAgent = cfg.defaultMode === "multi";
      agent.tier = cfg.defaultMode === "multi" ? "master" : "single";

      agent
        .sendMessage(prompt)
        .then(() => resolve(accumulatedText || "[Agent completed action with no textual output]"))
        .catch(reject);
    });
  };
}

export async function startGatewayServer(
  options: GatewayServerOptions = {}
): Promise<{ server: http.Server; port: number }> {
  const port = options.port || 7890;
  const workspace = options.workspace || process.cwd();
  const executeAgentPrompt = await createAgentExecutor(workspace);

  const server = http.createServer(async (req, res) => {
    // Handle CORS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Superagent-Secret",
      });
      res.end();
      return;
    }

    try {
      const parsedUrl = new URL(req.url || "/", `http://localhost:${port}`);
      const pathname = parsedUrl.pathname;

      if (pathname === "/" || pathname === "/health") {
        sendJSON(res, 200, {
          status: "ok",
          service: "superagent-gateway",
          gateway: gatewayManager.getStatus(),
        });
        return;
      }

      if (pathname.startsWith("/api/gateway")) {
        const handled = await handleGatewayRoutes(req, res, pathname, parsedUrl, {
          sendJSON,
          readBody,
          executeAgentPrompt,
        });
        if (handled) return;
      }

      sendJSON(res, 404, { error: `Endpoint not found: ${pathname}` });
    } catch (err: any) {
      sendJSON(res, 500, { error: err.message || "Internal server error" });
    }
  });

  return new Promise((resolve, reject) => {
    server.listen(port, () => {
      if (!options.silent) {
        console.log(`\nOmnichannel Gateway Server listening on port ${port}`);
        console.log(`- Webhook URL : http://localhost:${port}/api/gateway/webhook`);
        console.log(`- Telegram URL: http://localhost:${port}/api/gateway/telegram`);
        console.log(`- Discord URL : http://localhost:${port}/api/gateway/discord`);
        console.log(`- Slack URL   : http://localhost:${port}/api/gateway/slack`);
        console.log(`- Status URL  : http://localhost:${port}/api/gateway/status`);
        console.log(`- Health URL  : http://localhost:${port}/health\n`);
      }
      resolve({ server, port });
    });
    server.on("error", reject);
  });
}
