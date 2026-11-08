import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { manageServices } from "../src/core/runtime/serviceManager.js";
import {
  assessDesktopMcpOwnerEvidence,
  type McpServiceEvidence,
} from "../src/core/desktopUi/liveActivationGate.js";

function fail(code: string, details?: string): never {
  process.stderr.write(JSON.stringify({
    status: "BLOCKED", code, ...(details ? { details } : {}),
  }) + "\n");
  process.exit(2);
}

async function bounded<T>(request: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      request,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("DEADLINE_EXCEEDED")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function readOwner(action: "status" | "doctor", port: number): Promise<McpServiceEvidence | undefined> {
  const result = await bounded(manageServices({ action, service: "mcp", port }), 18_000);
  const services = (result as { services?: McpServiceEvidence[] }).services;
  return services?.find((item) => item.service === "mcp");
}

async function main() {
  if (process.env.SUPERAGENT_DESKTOP_UI_LIVE_ACCEPTANCE !== "1") {
    fail("LIVE_ACCEPTANCE_OPT_IN_REQUIRED");
  }
  const expectedUrl = process.env.SUPERAGENT_DESKTOP_MCP_URL?.trim();
  const token = process.env.SUPERAGENT_DESKTOP_MCP_ACCESS_TOKEN?.trim();
  const port = Number(process.env.SUPERAGENT_DESKTOP_MCP_PORT || "9227");
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) fail("MCP_OWNER_PORT_INVALID");
  if (!expectedUrl) fail("MCP_URL_REQUIRED");
  let url: URL;
  try {
    url = new URL(expectedUrl);
  } catch {
    fail("MCP_URL_INVALID");
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    (url.protocol === "http:" && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) ||
    url.username || url.password || url.search || url.hash || url.pathname !== "/mcp"
  ) {
    fail("MCP_URL_UNSAFE_OR_INVALID");
  }
  if (!token) fail("MCP_ACCESS_TOKEN_REQUIRED");

  const status = await readOwner("status", port);
  const doctor = await readOwner("doctor", port);
  const readiness = assessDesktopMcpOwnerEvidence(status, doctor, url.href);
  if (!readiness.ready) fail("MCP_OWNER_PREFLIGHT_BLOCKED", readiness.reasons.join(","));

  const client = new Client({ name: "desktop-ui-live-acceptance", version: "1.0.0" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: "Bearer " + token } },
  });
  try {
    await bounded(client.connect(transport), 15_000);
    const names = (await bounded(client.listTools(), 15_000)).tools.map((tool) => tool.name);
    if (!names.includes("superagent_desktop_ui")) throw new Error("DESKTOP_UI_NOT_ADVERTISED");
    const result = await bounded(client.callTool({
      name: "superagent_desktop_ui", arguments: { command: "probe" },
    }), 20_000);
    if (result.isError) throw new Error("DESKTOP_UI_PROBE_DENIED");
    const text = result.content.find((item) => item.type === "text");
    if (!text || text.type !== "text") throw new Error("DESKTOP_UI_PROBE_RESPONSE_INVALID");
    let parsed: { success?: boolean; capabilities?: { available?: boolean; platform?: string } };
    try {
      parsed = JSON.parse(text.text);
    } catch {
      throw new Error("DESKTOP_UI_PROBE_RESPONSE_INVALID");
    }
    if (parsed.success !== true || parsed.capabilities?.available !== true) {
      throw new Error("DESKTOP_UI_HOST_PROBE_FAILED");
    }
    process.stdout.write(JSON.stringify({
      status: "PASS", verifiedThrough: "live-mcp-http",
      platform: parsed.capabilities.platform ?? "unknown",
      ownerPid: readiness.ownerPid,
      backendPid: readiness.backendPid,
      warnings: readiness.warnings,
    }) + "\n");
  } finally {
    await bounded(client.close().catch(() => undefined), 5_000).catch(() => undefined);
  }
}

main().catch((error: unknown) => {
  const reason = error instanceof Error ? error.message : "";
  const allowed = new Set([
    "DESKTOP_UI_NOT_ADVERTISED", "DESKTOP_UI_PROBE_DENIED",
    "DESKTOP_UI_PROBE_RESPONSE_INVALID", "DESKTOP_UI_HOST_PROBE_FAILED",
  ]);
  fail(allowed.has(reason) ? reason
    : reason === "DEADLINE_EXCEEDED" ? "MCP_LIVE_CHECK_TIMEOUT" : "MCP_LIVE_CHECK_FAILED");
});
