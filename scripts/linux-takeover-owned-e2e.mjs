/**
 * M4-C native owned-Linux component E2E. Uses the real BrowserProcessManager,
 * TakeoverSessionManager and WebSocket proxy; HTTP harness is loopback/test only.
 * This is not a deployed Core gateway or mobile TLS/OIDC certification.
 */
import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { getBrowserProcessManager } from "../dist/core/browserRuntime/browserProcessManager.js";
import { getTakeoverSessionManager } from "../dist/core/browserTakeover/takeoverSessionManager.js";
import { TakeoverWebsocketProxy } from "../dist/core/browserTakeover/takeoverWebsocketProxy.js";
import { discoverCdpPages } from "../dist/core/tools/chromeCdpTools.js";
import { assertManagedAgentMayWrite } from "../dist/core/tools/managedBrowserControl.js";
import { loadTakeoverSession } from "../dist/core/browserTakeover/takeoverStateMachine.js";
import { isAbstractX11DisplayListening } from "../dist/core/browserRuntime/virtualDisplayAllocation.js";

const alloc = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const port = server.address().port;
    server.close(() => resolve(port));
  });
});
async function until(fn, message, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise(resolve => setTimeout(resolve, 90));
  }
  throw Error(message);
}
async function websocket(url, protocols, headers = {}) {
  const ws = new WebSocket(url, protocols, { headers });
  return await new Promise((resolve, reject) => {
    const guard = setTimeout(() => reject(Error("WebSocket handshake timeout")), 8000);
    ws.once("open", () => { clearTimeout(guard); resolve(ws); });
    ws.once("unexpected-response", (_req, res) => {
      res.resume(); clearTimeout(guard);
      reject(Error("WebSocket rejected: " + res.statusCode));
    });
    ws.once("error", err => { clearTimeout(guard); reject(err); });
  });
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sa-m4c-owned-e2e-"));
const previousSessionsDir = process.env.SUPERAGENT_TAKEOVER_SESSIONS_DIR;
const previousCdpDir = process.env.SUPERAGENT_CDP_SESSION_DIR;
process.env.SUPERAGENT_TAKEOVER_SESSIONS_DIR = tmp;
process.env.SUPERAGENT_CDP_SESSION_DIR = tmp;
const { port: cdpPort, vncPort, noVncPort, apiPort } = Object.fromEntries(
  await Promise.all(["port", "vncPort", "noVncPort", "apiPort"].map(async key => [key, await alloc()])));
const browser = getBrowserProcessManager();
const manager = getTakeoverSessionManager({ sessionsDir: tmp, invitationTtlMs: 60_000, sessionTtlMs: 180_000 });
const proxy = new TakeoverWebsocketProxy();
const apiSecret = crypto.randomBytes(24).toString("hex");
let server, instance, sessionId, operatorToken, targetId, returned;
try {
  instance = await browser.launchBrowser({
    port: cdpPort, mode: "virtual-display",
    executablePath: "/usr/bin/google-chrome",
    url: "about:blank", userDataDir: path.join(tmp, "chrome"),
    timeoutMs: 24000,
    virtualDisplay: { enableLocalVnc: true, enableLocalNoVnc: true, vncPort, noVncPort },
  });
  await until(async () => {
    const h = await browser.checkHealth(cdpPort);
    return h.virtualDisplay?.vncRunning && h.virtualDisplay?.noVncRunning;
  }, "Managed Linux Xvfb/VNC/noVNC never became ready");
  if (!await isAbstractX11DisplayListening(instance.virtualDisplay.displayNumber)) {
    throw Error("Owned Xvfb abstract Unix socket was not detected; collision protection is incomplete");
  }
  const tabs = await discoverCdpPages(cdpPort);
  targetId = tabs.find(p => p.targetId)?.targetId;
  if (!targetId) throw Error("BrowserProcessManager did not own a CDP page");
  const invite = await manager.requestTakeover({
    port: cdpPort, targetId, reason: "Linux owned full path",
  });
  sessionId = invite.sessionId;
  await assertManagedAgentMayWrite(cdpPort, targetId).then(
    () => { throw Error("Agent write fence unexpectedly open during human takeover"); },
    () => {});
  const redeem = await manager.redeemInvitation({
    sessionId, invitationToken: invite.invitationToken,
  });
  operatorToken = redeem.operatorToken;
  if (!redeem.vncPassword) throw Error("Managed VNC credentials not returned to human operator");
  server = http.createServer(async (req, res) => {
    // Test-only HTTP harness: the true manager and WebSocket proxy are used,
    // not the production Core server/HTTP router.
    const authorized = req.headers.authorization === "Bearer " + apiSecret;
    if (!authorized) { res.writeHead(401); res.end(); return; }
    if (req.url === "/return" && req.method === "POST") {
      try {
        const session = await manager.requestReturn({ sessionId, operatorToken });
        const result = await manager.verifyAndResume(sessionId);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ transition: session.state, ...result }));
      } catch (error) { res.writeHead(409); res.end(String(error)); }
      return;
    }
    res.writeHead(404); res.end();
  });
  server.on("upgrade", (req, socket, head) =>
    void proxy.handleUpgrade(req, socket, head, () => false).catch(err => {
      console.error("M4C_PROXY_UPGRADE_REJECTED", err instanceof Error ? err.message : String(err));
      socket.destroy();
    }));
  await new Promise(resolve => server.listen(apiPort, "127.0.0.1", resolve));
  process.env.M4C_CDP_PORT = String(cdpPort);
  process.env.M4C_WS_PORT = String(noVncPort);
  process.env.M4C_VNC_PASSWORD = redeem.vncPassword;
  process.env.M4C_OPERATOR_TOKEN = operatorToken;
  process.env.M4C_PROXY_WS_URL =
    `ws://127.0.0.1:${apiPort}/api/browser/takeover/ws?sessionId=${sessionId}`;

  // Input script checks a *real* VNC RFB handshake and validates Chrome's DOM
  // after click + keydown, via the authorized proxy rather than direct VNC.
  await import("./linux-takeover-input-smoke.mjs");
  delete process.env.M4C_VNC_PASSWORD;
  delete process.env.M4C_OPERATOR_TOKEN;
  delete process.env.M4C_PROXY_WS_URL;
  await until(() => proxy.getActiveCount() === 0, "Proxy did not clean first operator connection");

  const url = `ws://127.0.0.1:${apiPort}/api/browser/takeover/ws?sessionId=${sessionId}`;
  const origin = `http://127.0.0.1:${apiPort}`;
  const next = await websocket(url, ["binary", "operator." + operatorToken], { Origin: origin });
  await until(() => proxy.getActiveCount() === 1, "Valid second operator reconnect failed");
  const closed = new Promise(resolve => next.once("close", resolve));
  const result = await fetch(`http://127.0.0.1:${apiPort}/return`, {
    method: "POST", headers: { Authorization: "Bearer " + apiSecret },
  });
  returned = await result.json();
  if (result.status !== 200 || returned.state !== "AGENT_ACTIVE" || !returned.resumed) {
    throw Error("Authorized Return to Agent did not verify/resume: " + JSON.stringify(returned));
  }
  await closed;
  await until(() => proxy.getActiveCount() === 0, "Return failed to revoke active operator input");
  const reconnected = await new Promise(resolve => {
    const ws = new WebSocket(url, ["binary", "operator." + operatorToken], { headers: { Origin: origin } });
    ws.once("unexpected-response", (_r,res)=>{res.resume();resolve(res.statusCode);});
    ws.once("open",()=>{ws.close();resolve(101);});
    ws.once("error",()=>resolve("network-error"));
  });
  if (reconnected !== 401) throw Error("Expired operator connection was not rejected: " + reconnected);
  await assertManagedAgentMayWrite(cdpPort, targetId);
  const final = await loadTakeoverSession(sessionId,tmp);
  console.log("M4C_OWNED_LINUX_TAKEOVER_E2E_PASS",JSON.stringify({
    platform: process.platform,
    display: instance.virtualDisplay.displayStr, authenticatedProxy: true,
    operatorInputViaVncAndCdp: true, reconnect: true,
    verifiedReturn: true, postReturnWebsocketDenied: reconnected,
    finalState: final.state,
  }));
} finally {
  delete process.env.M4C_OPERATOR_TOKEN;
  delete process.env.M4C_VNC_PASSWORD;
  delete process.env.M4C_PROXY_WS_URL;
  if (sessionId) proxy.closeSessionTunnel(sessionId);
  if (server) await new Promise(resolve => server.close(() => resolve()));
  if (instance) {
    const stopped=await browser.stopBrowser({port:cdpPort,timeoutMs:2500});
    console.log("M4C_OWNED_LINUX_CLEANUP",JSON.stringify({
      success:stopped.success,virtualDisplayStopped:stopped.virtualDisplayStopped
    }));
  }
  await fs.rm(tmp, { recursive:true,force:true });
  if (previousSessionsDir === undefined) delete process.env.SUPERAGENT_TAKEOVER_SESSIONS_DIR;
  else process.env.SUPERAGENT_TAKEOVER_SESSIONS_DIR = previousSessionsDir;
  if (previousCdpDir === undefined) delete process.env.SUPERAGENT_CDP_SESSION_DIR;
  else process.env.SUPERAGENT_CDP_SESSION_DIR = previousCdpDir;
}
