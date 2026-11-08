import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { execa, type ResultPromise } from "execa";
import { expect, it } from "vitest";
import {
  generateMcpBearerToken,
  startMcpHttpServer,
  type McpHttpServerHandle,
} from "../../src/core/mcp/mcpHttpTransport.js";
import { createSuperagentMcpServer } from "../../src/core/mcp/superagentMcpServer.js";
import { desktopUiSessionManager } from "../../src/core/tools/desktopUiTools.js";

const enabled = process.platform === "win32"
  && process.env.SUPERAGENT_DESKTOP_UI_LIVE_MCP_E2E === "1";
const liveTest = enabled ? it : it.skip;
const powershell = path.win32.join(
  process.env.SystemRoot || "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);

const fixtureScript = String.raw`
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$form = New-Object System.Windows.Forms.Form
$form.Text = $env:SUPERAGENT_DESKTOP_UI_TEST_TITLE
$form.Width = 420
$form.Height = 220
$form.StartPosition = "Manual"
$form.Location = New-Object System.Drawing.Point(120,120)
$form.TopMost = $true
$form.FormBorderStyle = "FixedSingle"
$form.MaximizeBox = $false

$button = New-Object System.Windows.Forms.Button
$button.Text = "Transport Probe"
$button.AccessibleName = "Transport Probe"
$button.AccessibleRole = [System.Windows.Forms.AccessibleRole]::PushButton
$button.Location = New-Object System.Drawing.Point(24,24)
$button.Size = New-Object System.Drawing.Size(180,44)
$form.Controls.Add($button)

$timeout = New-Object System.Windows.Forms.Timer
$timeout.Interval = 60000
$timeout.Add_Tick({ $timeout.Stop(); $form.Close() })
$timeout.Start()

$form.Show()
[Console]::Out.WriteLine("READY|" + $PID + "|" + $form.Handle.ToInt64())
[Console]::Out.Flush()
[System.Windows.Forms.Application]::Run($form)
`;

type FixtureChild = ResultPromise<{
  reject: false;
  buffer: false;
}>;

function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function parseTextResult(result: { content: unknown }): any {
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content.find((part: any) => part?.type === "text")?.text;
  if (typeof text !== "string") throw new Error("MCP result did not contain text JSON.");
  return JSON.parse(text);
}

function expectedStaticBearerPrincipal(bearer: string): string {
  const credentialHash = createHash("sha256").update(bearer).digest("hex");
  return createHash("sha256")
    .update(`static-bearer:credential:${credentialHash}`)
    .digest("hex");
}

async function awaitReady(child: FixtureChild): Promise<{ pid: number; nativeId: string }> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => finish(undefined, new Error("WinForms fixture did not become ready.")), 12_000);
    const finish = (result?: { pid: number; nativeId: string }, error?: Error) => {
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.off("error", onError);
      if (error) reject(error);
      else if (result) resolve(result);
    };
    const onError = (error: Error) => finish(undefined, error);
    const onData = (data: Buffer) => {
      output += data.toString();
      const match = output.match(/READY\|(\d+)\|(\d+)/);
      if (match) finish({ pid: Number(match[1]), nativeId: match[2] });
      else if (output.length > 8192) finish(undefined, new Error("Unexpected fixture startup output."));
    };
    child.stdout?.on("data", onData);
    child.on("error", onError);
  });
}

async function terminateFixture(child: FixtureChild): Promise<void> {
  child.kill("SIGTERM");
  const exited = () => Promise.race([
    child.then(() => true, () => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2500)),
  ]);
  if (await exited()) return;
  child.kill("SIGKILL");
  if (!(await exited())) throw new Error("Temporary WinForms process did not exit.");
}

async function startFixture() {
  const title = "SuperAgent MCP Transport E2E " + randomUUID();
  const encoded = Buffer.from(fixtureScript, "utf16le").toString("base64");
  const child = execa(
    powershell,
    ["-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", encoded],
    {
      reject: false,
      buffer: false,
      windowsHide: false,
      env: { SUPERAGENT_DESKTOP_UI_TEST_TITLE: title },
    },
  ) as FixtureChild;
  try {
    return { ...(await awaitReady(child)), title, child };
  } catch (error) {
    await terminateFixture(child);
    throw error;
  }
}

function createHttpClient(url: string, bearer: string, name: string) {
  const client = new Client({ name, version: "1.0.0" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: "Bearer " + bearer } },
  });
  return { client, transport };
}

async function closeClient(client: Client): Promise<void> {
  await withTimeout(client.close().catch(() => undefined), "MCP client close", 5000);
}

async function closeServer(server: McpHttpServerHandle | null): Promise<void> {
  if (server) await withTimeout(server.close(), "MCP server close", 5000);
}

liveTest("Windows host: public MCP HTTP transport activates desktop UI with principal and remote guards", async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), "superagent-desktop-mcp-transport-"));
  const previousConfigDir = process.env.SUPERAGENT_CONFIG_DIR;
  process.env.SUPERAGENT_CONFIG_DIR = configDir;
  await writeFile(
    path.join(configDir, "yolo-mode.json"),
    JSON.stringify({ mode: "scoped", updatedAt: Date.now(), workspace: process.cwd() }),
    "utf8",
  );

  const bearerA = generateMcpBearerToken();
  const bearerB = generateMcpBearerToken();
  const principalA = expectedStaticBearerPrincipal(bearerA);
  const principalB = expectedStaticBearerPrincipal(bearerB);
  expect(principalA).not.toBe(principalB);

  let serverA: McpHttpServerHandle | null = null;
  let serverB: McpHttpServerHandle | null = null;
  let clientA: Client | null = null;
  let clientB: Client | null = null;
  let remoteClient: Client | null = null;
  let remoteServer: ReturnType<typeof createSuperagentMcpServer> | null = null;
  let fixture: Awaited<ReturnType<typeof startFixture>> | null = null;
  let sessionToken: string | null = null;

  try {
    serverA = await withTimeout(startMcpHttpServer({
      port: 0,
      bearerToken: bearerA,
      allowDangerous: true,
      toolExposure: "full",
      auditLogPath: path.join(configDir, "mcp-audit-a.log"),
    }), "primary MCP server start");
    serverB = await withTimeout(startMcpHttpServer({
      port: 0,
      bearerToken: bearerB,
      allowDangerous: true,
      toolExposure: "full",
      auditLogPath: path.join(configDir, "mcp-audit-b.log"),
    }), "secondary MCP server start");

    expect(serverA.port).toBeGreaterThan(0);
    expect(serverB.port).toBeGreaterThan(0);
    expect(serverA.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(serverB.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);

    const deniedProbe = await withTimeout(fetch(serverA.url, {
      method: "HEAD",
      headers: { Authorization: "Bearer " + generateMcpBearerToken() },
    }), "unauthorized MCP probe");
    expect(deniedProbe.status).toBe(401);

    const a = createHttpClient(serverA.url, bearerA, "desktop-mcp-principal-a");
    clientA = a.client;
    await withTimeout(clientA.connect(a.transport), "primary MCP client connect");

    const b = createHttpClient(serverB.url, bearerB, "desktop-mcp-principal-b");
    clientB = b.client;
    await withTimeout(clientB.connect(b.transport), "secondary MCP client connect");

    const toolNames = (await withTimeout(clientA.listTools(), "desktop tool discovery"))
      .tools.map((tool) => tool.name);
    expect(toolNames).toContain("superagent_desktop_ui");

    const probeResult = await withTimeout(clientA.callTool({
      name: "superagent_desktop_ui",
      arguments: { command: "probe" },
    }), "desktop native probe", 20_000);
    expect(probeResult.isError).not.toBe(true);
    const probe = parseTextResult(probeResult as any);
    expect(probe.success).toBe(true);
    expect(probe.capabilities.platform).toBe("win32");
    expect(probe.capabilities.available).toBe(true);

    fixture = await startFixture();
    const openedResult = await withTimeout(clientA.callTool({
      name: "superagent_desktop_ui",
      arguments: {
        command: "open",
        pid: fixture.pid,
        nativeId: fixture.nativeId,
        title: fixture.title,
        allowInput: false,
        ttlMs: 60_000,
      },
    }), "desktop session open", 20_000);
    expect(openedResult.isError).not.toBe(true);
    const opened = parseTextResult(openedResult as any);
    sessionToken = opened.session.sessionToken;
    expect(opened.session.inputAllowed).toBe(false);
    expect(desktopUiSessionManager.getSession(sessionToken!, principalA)).not.toBeNull();
    expect(desktopUiSessionManager.getSession(sessionToken!, principalB)).toBeNull();

    const snapshotResult = await withTimeout(clientA.callTool({
      name: "superagent_desktop_ui",
      arguments: {
        command: "snapshot",
        sessionToken,
        includeScreenshotImage: false,
      },
    }), "desktop snapshot", 20_000);
    expect(snapshotResult.isError).not.toBe(true);
    const snapshot = parseTextResult(snapshotResult as any);
    expect(snapshot.success).toBe(true);
    expect(snapshot.schema.screenshot.targetWindow.pid).toBe(fixture.pid);
    expect(snapshot.schema.screenshot.targetWindow.nativeId).toBe(fixture.nativeId);
    expect(snapshot.screenshotImage).toBeUndefined();
    expect(snapshot.schema.elements.some((element: any) =>
      element.source === "accessibility"
      && element.role === "button"
      && element.label === "Transport Probe"
      && element.actionable,
    )).toBe(true);

    const foreignSnapshot = await withTimeout(clientB.callTool({
      name: "superagent_desktop_ui",
      arguments: {
        command: "snapshot",
        sessionToken,
        includeScreenshotImage: false,
      },
    }), "foreign-principal snapshot");
    expect(foreignSnapshot.isError).toBe(true);
    const foreignError = parseTextResult(foreignSnapshot as any);
    expect(foreignError.code).toBe("TARGET_NOT_FOUND");
    expect(foreignError.error).toMatch(/owned by another principal/i);

    const [remoteClientTransport, remoteServerTransport] = InMemoryTransport.createLinkedPair();
    remoteServer = createSuperagentMcpServer({
      workspace: "ssh://fixture.invalid/project",
      allowDangerous: true,
      toolExposure: "full",
      authMode: "static-bearer",
      getIdentity: () => ({
        mode: "static-bearer",
        subject: "remote-fixture",
        credentialHash: "ab".repeat(32),
      }),
    });
    remoteClient = new Client({ name: "desktop-mcp-remote-workspace", version: "1.0.0" }, { capabilities: {} });
    await withTimeout(remoteServer.connect(remoteServerTransport), "remote MCP server connect");
    await withTimeout(remoteClient.connect(remoteClientTransport), "remote MCP client connect");
    await expect(withTimeout(remoteClient.callTool({
      name: "superagent_desktop_ui",
      arguments: { command: "probe" },
    }), "remote workspace desktop denial")).rejects.toThrow(/Scoped YOLO boundary/);

    const closedResult = await withTimeout(clientA.callTool({
      name: "superagent_desktop_ui",
      arguments: { command: "close", sessionToken },
    }), "desktop session close");
    expect(closedResult.isError).not.toBe(true);
    expect(parseTextResult(closedResult as any).closed).toBe(true);
    sessionToken = null;
  } finally {
    if (sessionToken && clientA) {
      await withTimeout(clientA.callTool({
        name: "superagent_desktop_ui",
        arguments: { command: "close", sessionToken },
      }).then(() => undefined).catch(() => undefined), "desktop fallback close", 5000);
    }
    if (remoteClient) await closeClient(remoteClient);
    if (remoteServer) await withTimeout(remoteServer.close().catch(() => undefined), "remote MCP server close", 5000);
    if (clientB) await closeClient(clientB);
    if (clientA) await closeClient(clientA);
    await closeServer(serverB);
    await closeServer(serverA);
    desktopUiSessionManager.clearAllSessions();
    if (fixture) await terminateFixture(fixture.child);
    if (previousConfigDir === undefined) delete process.env.SUPERAGENT_CONFIG_DIR;
    else process.env.SUPERAGENT_CONFIG_DIR = previousConfigDir;
    await rm(configDir, { recursive: true, force: true });
  }
}, 90_000);
