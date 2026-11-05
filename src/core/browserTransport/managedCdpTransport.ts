import { get as httpGet } from "node:http";
import WebSocket from "ws";
import { BrowserTransportError, type BrowserTargetRef, type BrowserTransport, type BrowserTransportCapabilities } from "./types.js";

type ManagedCdpTargetRow = {
  id?: string;
  type?: string;
  title?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
};

function configuredHost(): string {
  return process.env.SUPERAGENT_CDP_HOST || "127.0.0.1";
}

function configuredPort(connectionId?: string): number {
  const raw = connectionId || process.env.SUPERAGENT_CDP_PORT || "9222";
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
    throw new BrowserTransportError("BROWSER_CONNECTION_INVALID", "Managed CDP connectionId must be a local port between 1024 and 65535.");
  }
  return port;
}

function timeoutMs(): number {
  return Number(process.env.SUPERAGENT_CDP_TIMEOUT_MS) || 20_000;
}

function getJson(host: string, port: number, path: string, signal?: AbortSignal): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = httpGet({ host, port, path, timeout: timeoutMs() }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", chunk => { body += chunk; });
      res.on("end", () => {
        if (res.statusCode !== 200) {
          reject(new BrowserTransportError("MANAGED_CDP_HTTP_ERROR", `Managed CDP ${path} returned HTTP ${res.statusCode}.`));
          return;
        }
        try { resolve(JSON.parse(body)); }
        catch { reject(new BrowserTransportError("MANAGED_CDP_INVALID_RESPONSE", `Managed CDP ${path} returned invalid JSON.`)); }
      });
    });
    const abort = () => req.destroy(new BrowserTransportError("MANAGED_CDP_ABORTED", "Managed CDP request aborted."));
    signal?.addEventListener("abort", abort, { once: true });
    req.once("close", () => signal?.removeEventListener("abort", abort));
    req.on("timeout", () => req.destroy(new BrowserTransportError("MANAGED_CDP_TIMEOUT", `Managed CDP ${path} timed out.`)));
    req.on("error", reject);
  });
}

async function findTarget(target: BrowserTargetRef, signal?: AbortSignal): Promise<ManagedCdpTargetRow> {
  if (target.kind !== "managed") throw new BrowserTransportError("BROWSER_TARGET_INVALID", "Managed target required.");
  const port = configuredPort(target.connectionId);
  const rows = await getJson(configuredHost(), port, "/json/list", signal) as ManagedCdpTargetRow[];
  const row = rows.find(candidate => candidate.id === target.targetId);
  if (!row) throw new BrowserTransportError("MANAGED_CDP_TARGET_NOT_FOUND", `Managed target ${target.targetId} is not available on port ${port}.`);
  return row;
}

function websocketCommand(url: string, method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { handshakeTimeout: timeoutMs() });
    const id = 1;
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      try { ws.close(); } catch {}
      if (error) reject(error); else resolve(value);
    };
    const abort = () => finish(new BrowserTransportError("MANAGED_CDP_ABORTED", `Managed CDP command ${method} aborted.`));
    timer = setTimeout(() => finish(new BrowserTransportError("MANAGED_CDP_TIMEOUT", `Managed CDP command ${method} timed out.`)), timeoutMs());
    timer.unref?.();
    signal?.addEventListener("abort", abort, { once: true });
    ws.once("open", () => ws.send(JSON.stringify({ id, method, params })));
    ws.on("message", raw => {
      let message: any;
      try { message = JSON.parse(raw.toString()); } catch { return; }
      if (message?.id !== id) return;
      if (message.error) {
        finish(new BrowserTransportError("MANAGED_CDP_COMMAND_FAILED", String(message.error?.message || `CDP command ${method} failed.`)));
      } else {
        finish(undefined, message.result ?? {});
      }
    });
    ws.once("error", error => finish(error instanceof Error ? error : new Error(String(error))));
  });
}

export const managedCdpCapabilities: BrowserTransportCapabilities = {
  commands: ["*"],
  rawCdp: true,
  cookies: true,
  privilegedUrls: false,
};

export class ManagedCdpTransport implements BrowserTransport {
  readonly kind = "managed" as const;

  async listTargets(connectionId?: string, signal?: AbortSignal): Promise<BrowserTargetRef[]> {
    const port = configuredPort(connectionId);
    const rows = await getJson(configuredHost(), port, "/json/list", signal) as ManagedCdpTargetRow[];
    return rows
      .filter(row => row.type === "page" && typeof row.id === "string")
      .map(row => ({
        kind: "managed" as const,
        connectionId: String(port),
        targetId: row.id!,
        title: row.title,
        url: row.url,
      }));
  }

  async attach(target: BrowserTargetRef, signal?: AbortSignal): Promise<void> {
    await findTarget(target, signal);
  }

  async detach(target: BrowserTargetRef): Promise<void> {
    if (target.kind !== "managed") throw new BrowserTransportError("BROWSER_TARGET_INVALID", "Managed target required.");
    // Managed CDP exposes direct per-target WebSocket endpoints, so this
    // adapter never holds a persistent chrome.debugger-style attachment.
  }

  async command(target: BrowserTargetRef, method: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<unknown> {
    const row = await findTarget(target, signal);
    if (!row.webSocketDebuggerUrl) {
      throw new BrowserTransportError("MANAGED_CDP_WEBSOCKET_MISSING", `Managed target ${target.targetId} has no WebSocket debugger URL.`);
    }
    return websocketCommand(row.webSocketDebuggerUrl, method, params, signal);
  }

  async capabilities(): Promise<BrowserTransportCapabilities> {
    return managedCdpCapabilities;
  }

  async health(connectionId?: string, signal?: AbortSignal) {
    const port = configuredPort(connectionId);
    try {
      const version = await getJson(configuredHost(), port, "/json/version", signal);
      return {
        ok: true,
        kind: "managed" as const,
        connectionId: String(port),
        detail: JSON.stringify({ browser: version?.Browser || "", protocolVersion: version?.["Protocol-Version"] || "" }),
      };
    } catch (error: any) {
      return {
        ok: false,
        kind: "managed" as const,
        connectionId: String(port),
        detail: String(error?.message || error),
      };
    }
  }
}

export const managedCdpTransport = new ManagedCdpTransport();
