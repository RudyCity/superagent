/** Authenticated local Core API used by native SuperAgent Tray.
 * The server authenticates bearer requests before this route is invoked.
 * MCP agents do NOT receive this operator API; they use project-granted tools.
 */
import type http from "node:http";
import { lifecycleAction } from "./externalLifecycle.js";

export async function handleExternalLifecycleRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  ctx: { sendJSON: (res: http.ServerResponse, status: number, body: unknown) => void; readBody: (req: http.IncomingMessage) => Promise<string> },
): Promise<boolean> {
  if (pathname !== "/api/lifecycle/action") return false;
  if (req.method !== "POST") {
    ctx.sendJSON(res, 405, { success: false, error: "POST required." });
    return true;
  }
  try {
    const raw = await ctx.readBody(req);
    if (raw.length > 80_000) throw new Error("Request too large.");
    const payload: unknown = JSON.parse(raw || "{}");
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Expected object.");
    const data = payload as Record<string, unknown>;
    const action = typeof data.action === "string" ? data.action : "";
    // Worker identities and lease receipts can only originate from a verified
    // MCP session, never from the operator API or browser UI.
    if (!["list", "status", "workers", "create", "run.now", "pause", "resume",
      "cancel", "review.retry", "targets", "worker.bind", "worker.unbind", "worker.revoke"].includes(action)) throw new Error("Operator action is not supported.");
    const workspace = data.workspace;
    if (typeof workspace !== "string" || !workspace) throw new Error("An explicit workspace is required.");
    const args = data.args && typeof data.args === "object" && !Array.isArray(data.args)
      ? data.args as Record<string, unknown> : {};
    if (action === "targets") {
      const { listApprovedCdpTargets } = await import("./cdpWakeAdapter.js");
      ctx.sendJSON(res, 200, { success: true, result: { targets: await listApprovedCdpTargets() } });
      return true;
    }
    if (action === "worker.bind") {
      const clientId = args.clientId, tabId = args.tabId;
      if (typeof clientId !== "string" || !Number.isSafeInteger(tabId) || Number(tabId) <= 0) {
        throw new Error("Binding requires an exact paired clientId and ChatGPT tabId.");
      }
      const { verifyApprovedCdpTarget } = await import("./cdpWakeAdapter.js");
      await verifyApprovedCdpTarget(clientId, Number(tabId));
    }
    const result = lifecycleAction(action, args, {
      workspace, actor: "local-operator", principal: "local-operator", admin: true,
    });
    ctx.sendJSON(res, 200, { success: true, result });
  } catch (err) {
    ctx.sendJSON(res, 400, { success: false, error: err instanceof Error ? err.message : "Lifecycle operation failed." });
  }
  return true;
}
