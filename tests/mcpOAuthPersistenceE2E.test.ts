/**
 * End-to-end proof for the reported failure: a ChatGPT/Gemini client obtains an
 * OAuth token, the MCP owner restarts with the same public issuer, and the same
 * token must still authenticate `/mcp`.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startMcpHttpServer, MCP_HTTP_PATH, type McpHttpServerHandle } from "../src/core/mcp/mcpHttpTransport.js";
import { generateBootstrapCode } from "../src/core/mcp/mcpOAuthRoutes.js";
import { createPersistentMcpOAuthStore, issuerOAuthStateDir } from "../src/core/mcp/mcpOAuthPersistentStore.js";

const winIt = process.platform === "win32" ? it : it.skip;
const openHandles: McpHttpServerHandle[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const handle of openHandles.splice(0)) await handle.close().catch(() => {});
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function freePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

interface OAuthOwner {
  handle: McpHttpServerHandle;
  base: string;
  bootstrapCode: string;
}

async function startOAuthOwner(issuer: string, port: number, rootDir: string): Promise<OAuthOwner> {
  const bootstrap = generateBootstrapCode();
  const selection = createPersistentMcpOAuthStore({ issuer, rootDir });
  expect(selection.persistent).toBe(true);
  const handle = await startMcpHttpServer({
    port,
    allowDangerous: false,
    authMode: "oauth",
    oauthStore: selection.store,
    oauth: { publicBaseUrl: issuer, bootstrapCodeHash: bootstrap.codeHash },
    auditLogPath: path.join(rootDir, "audit.jsonl"),
  });
  openHandles.push(handle);
  return { handle, base: `http://127.0.0.1:${handle.port}`, bootstrapCode: bootstrap.code };
}

async function approveAndGetToken(owner: OAuthOwner, issuer: string): Promise<string> {
  const redirectUri = "https://client.example/cb";
  const register = await fetch(`${owner.base}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: "e2e-client", redirect_uris: [redirectUri] }),
  });
  expect(register.status).toBe(201);

  const verifier = "e2e-code-verifier-value-0123456789abcdef";
  const challenge = crypto.createHash("sha256").update(verifier, "utf8").digest("base64url");
  const authorizeUrl = new URL(`${owner.base}/oauth/authorize`);
  authorizeUrl.searchParams.set("client_id", "e2e-client");
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("code_challenge", challenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set("scope", "mcp:tools");
  authorizeUrl.searchParams.set("state", "state-1");
  authorizeUrl.searchParams.set("resource", `${issuer}/mcp`);

  const consent = await fetch(authorizeUrl);
  expect(consent.status).toBe(200);
  const requestId = /name="request_id" value="([^"]+)"/.exec(await consent.text())?.[1];
  expect(requestId).toBeTruthy();

  const approval = await fetch(`${owner.base}/oauth/authorize`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      request_id: requestId as string,
      bootstrap_code: owner.bootstrapCode,
      decision: "approve",
    }).toString(),
    redirect: "manual",
  });
  expect(approval.status).toBe(302);
  const code = new URL(approval.headers.get("location") as string).searchParams.get("code");
  expect(code).toBeTruthy();

  const token = await fetch(`${owner.base}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: code as string,
      client_id: "e2e-client",
      redirect_uri: redirectUri,
      code_verifier: verifier,
      resource: `${issuer}/mcp`,
    }).toString(),
  });
  expect(token.status).toBe(200);
  const payload = (await token.json()) as { access_token?: string };
  expect(payload.access_token).toBeTruthy();
  return payload.access_token as string;
}

function initialize(base: string, accessToken: string): Promise<Response> {
  return fetch(`${base}${MCP_HTTP_PATH}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e", version: "1" } },
    }),
  });
}

describe("MCP OAuth token survival across an owner restart", () => {
  winIt("keeps an issued token valid for the same public issuer", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-oauth-e2e-"));
    roots.push(rootDir);
    const port = await freePort();
    const issuer = `http://127.0.0.1:${port}`;

    const first = await startOAuthOwner(issuer, port, rootDir);
    const accessToken = await approveAndGetToken(first, issuer);
    expect((await initialize(first.base, accessToken)).status).toBe(200);

    await first.handle.close();
    openHandles.length = 0;

    const statePath = path.join(issuerOAuthStateDir(issuer, rootDir), "oauth-state.json");
    expect(fs.existsSync(statePath)).toBe(true);
    expect(fs.readFileSync(statePath, "utf8")).not.toContain(accessToken);

    const restarted = await startOAuthOwner(issuer, port, rootDir);
    const afterRestart = await initialize(restarted.base, accessToken);
    expect(afterRestart.status).toBe(200);
    expect(await afterRestart.text()).toContain("superagent-mcp-server");
  }, 120000);

  winIt("does not transfer tokens to a different public issuer", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-oauth-e2e-"));
    roots.push(rootDir);
    const port = await freePort();
    const issuer = `http://127.0.0.1:${port}`;
    const first = await startOAuthOwner(issuer, port, rootDir);
    const accessToken = await approveAndGetToken(first, issuer);
    expect((await initialize(first.base, accessToken)).status).toBe(200);
    await first.handle.close();
    openHandles.length = 0;

    const otherPort = await freePort();
    const otherIssuer = `http://127.0.0.1:${otherPort}`;
    const other = await startOAuthOwner(otherIssuer, otherPort, rootDir);
    expect((await initialize(other.base, accessToken)).status).toBe(401);
  }, 120000);
});
