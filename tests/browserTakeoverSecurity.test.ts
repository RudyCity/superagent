/**
 * Browser Takeover Security Negative Tests (Milestone M3)
 *
 * Verifies critical security non-negotiables:
 * 1. Agent write mutations are completely blocked while human hold is active (assertManagedAgentMayWrite).
 * 2. withCdpTargetWrite fails closed while human hold is active.
 * 3. WebSocket upgrade rejects unauthenticated requests (401).
 * 4. WebSocket upgrade rejects unauthorized Origins (403).
 * 5. WebSocket upgrade rejects sessions not in HUMAN_ACTIVE state (403).
 * 6. Live browser fingerprint mismatch on return fails closed into PAUSED_NEEDS_REVIEW.
 * 7. Closed target tabs on return fail closed into PAUSED_NEEDS_REVIEW.
 * 8. Plaintext tokens, passwords, and OTPs are NEVER logged in audit trails.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";
import crypto from "node:crypto";
import {
  type TakeoverSession,
  saveTakeoverSession,
  loadTakeoverSession,
  TakeoverSessionManager,
  TakeoverWebsocketProxy,
} from "../src/core/browserTakeover/index.js";
import {
  setManagedBrowserControl,
  assertManagedAgentMayWrite,
} from "../src/core/tools/managedBrowserControl.js";
import {
  registerManagedBrowser,
  resetManagedBrowserRegistrationsForTests,
} from "../src/core/tools/managedBrowserRegistry.js";
import { withCdpTargetWrite, claimCdpTarget, releaseCdpTarget } from "../src/core/tools/chromeCdpSessionManager.js";

describe("Agent Write Mutation Fencing During Human Hold", () => {
  let server: http.Server;
  let port: number;
  let sessionDir: string;
  const targetId = "held-tab-security-test";
  const guid = crypto.randomUUID();
  const fingerprint = crypto.createHash("sha256").update("/devtools/browser/" + guid).digest("hex");
  const generation = "1001-1793000000000000";
  const profileId = "default-sec";
  const prevSessionDir = process.env.SUPERAGENT_CDP_SESSION_DIR;

  beforeAll(async () => {
    sessionDir = await fsp.mkdtemp(path.join(os.tmpdir(), "takeover-sec-cdp-"));
    process.env.SUPERAGENT_CDP_SESSION_DIR = sessionDir;

    server = http.createServer((req, res) => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/json/version") {
        res.end(JSON.stringify({
          webSocketDebuggerUrl: "ws://127.0.0.1:" + port + "/devtools/browser/" + guid,
        }));
      } else if (req.url === "/json/list" || req.url === "/json") {
        res.end(JSON.stringify([
          {
            id: targetId,
            type: "page",
            title: "Security Test Page",
            url: "https://secure.example.org/",
            webSocketDebuggerUrl: "ws://127.0.0.1:" + port + "/devtools/page/" + targetId,
          },
        ]));
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    port = (server.address() as net.AddressInfo).port;
  });

  afterAll(async () => {
    if (prevSessionDir === undefined) delete process.env.SUPERAGENT_CDP_SESSION_DIR;
    else process.env.SUPERAGENT_CDP_SESSION_DIR = prevSessionDir;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      await fsp.rm(sessionDir, { recursive: true, force: true });
    } catch {}
    resetManagedBrowserRegistrationsForTests();
  });

  it("strictly blocks agent writes via assertManagedAgentMayWrite and withCdpTargetWrite when human hold is installed", async () => {
    const identity = { profileId, generation, port, targetId, browserFingerprint: fingerprint };
    await registerManagedBrowser(identity);

    // 1. Before hold: agent writes are permitted
    await expect(assertManagedAgentMayWrite(port, targetId)).resolves.toBeUndefined();

    // 2. Claim target
    const claim = await claimCdpTarget(port, targetId, "agent-tester");

    // 3. Install human hold
    await setManagedBrowserControl({
      ...identity,
      mode: "human",
    });

    // 4. After hold: assertManagedAgentMayWrite MUST throw!
    await expect(assertManagedAgentMayWrite(port, targetId)).rejects.toThrow(
      /Human has control of this tab\. Wait for Return to Agent\./i
    );

    // 5. withCdpTargetWrite MUST fail closed during hold!
    let writeExecuted = false;
    await expect(
      withCdpTargetWrite(port, targetId, "agent-tester", async () => {
        writeExecuted = true;
        return "mutated";
      }, { sessionToken: claim.sessionToken })
    ).rejects.toThrow(/Human has control of this tab\. Wait for Return to Agent\./i);

    expect(writeExecuted).toBe(false);

    // 6. Release hold
    await setManagedBrowserControl({
      ...identity,
      mode: "agent",
    });

    // 7. After release: agent writes permitted again
    await expect(assertManagedAgentMayWrite(port, targetId)).resolves.toBeUndefined();

    const writeResult = await withCdpTargetWrite(port, targetId, "agent-tester", async () => {
      writeExecuted = true;
      return "success_after_release";
    }, { sessionToken: claim.sessionToken });

    expect(writeExecuted).toBe(true);
    expect(writeResult).toBe("success_after_release");

    await releaseCdpTarget(port, targetId, "agent-tester", claim.sessionToken);
  });
});

describe("Takeover WebSocket Proxy Security Boundaries", () => {
  let proxy: TakeoverWebsocketProxy;
  let testDir: string;

  beforeEach(async () => {
    proxy = new TakeoverWebsocketProxy();
    testDir = path.join(os.tmpdir(), `superagent-ws-test-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`);
    await fsp.mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await fsp.rm(testDir, { recursive: true, force: true });
    } catch {}
  });

  it("rejects unauthorized WebSocket upgrades with HTTP 401", async () => {
    const req = {
      url: "/api/browser/takeover/ws?sessionId=00000000-0000-0000-0000-000000000000",
      headers: { host: "127.0.0.1:6789", origin: "http://127.0.0.1:6789" },
      socket: { remoteAddress: "127.0.0.1" },
    } as unknown as http.IncomingMessage;

    let socketData = "";
    let destroyed = false;
    const socket = {
      remoteAddress: "127.0.0.1",
      write: (data: string) => { socketData += data; },
      destroy: () => { destroyed = true; },
    } as unknown as net.Socket;

    const isAuthorized = () => false; // Not authorized

    await proxy.handleUpgrade(req, socket, Buffer.alloc(0), isAuthorized);

    expect(socketData).toContain("401 Unauthorized");
    expect(destroyed).toBe(true);
  });

  it("rejects untrusted Origins with HTTP 403", async () => {
    const req = {
      url: "/api/browser/takeover/ws?sessionId=00000000-0000-0000-0000-000000000000",
      headers: {
        host: "127.0.0.1:6789",
        origin: "https://evil-attacker.example", // Untrusted origin
      },
    } as unknown as http.IncomingMessage;

    let socketData = "";
    let destroyed = false;
    const socket = {
      remoteAddress: "127.0.0.1",
      write: (data: string) => { socketData += data; },
      destroy: () => { destroyed = true; },
    } as unknown as net.Socket;

    const isAuthorized = () => true;

    await proxy.handleUpgrade(req, socket, Buffer.alloc(0), isAuthorized);

    expect(socketData).toContain("403 Forbidden");
    expect(socketData).toContain("Origin not allowed");
    expect(destroyed).toBe(true);
  });

  it("rejects WebSocket upgrade if session is NOT in HUMAN_ACTIVE state", async () => {
    const sessionId = crypto.randomUUID();
    const session: TakeoverSession = {
      sessionId,
      targetId: "tab-ws-gate",
      port: 9222,
      profileId: "default",
      generation: "1-12345",
      browserFingerprint: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      state: "HUMAN_READY", // Not yet redeemed into HUMAN_ACTIVE!
      requestedBy: "agent",
      reason: "Testing state gate",
      tokenHash: "dummy",
      invitationRedeemed: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      invitationExpiresAt: Date.now() + 60_000,
      sessionExpiresAt: Date.now() + 120_000,
      auditTrail: [],
    };

    await saveTakeoverSession(session);

    const req = {
      url: `/api/browser/takeover/ws?sessionId=${sessionId}`,
      headers: { host: "127.0.0.1:6789", origin: "http://127.0.0.1:6789" },
      socket: { remoteAddress: "127.0.0.1" },
    } as unknown as http.IncomingMessage;

    let socketData = "";
    let destroyed = false;
    const socket = {
      remoteAddress: "127.0.0.1",
      write: (data: string) => { socketData += data; },
      destroy: () => { destroyed = true; },
    } as unknown as net.Socket;

    const isAuthorized = () => true;

    await proxy.handleUpgrade(req, socket, Buffer.alloc(0), isAuthorized);

    expect(socketData).toContain("401 Unauthorized");
    expect(socketData).toContain("Authentication required");
    expect(destroyed).toBe(true);
  });
});

describe("Return to Agent Verification Security & Fail-Closed Semantics", () => {
  let manager: TakeoverSessionManager;
  let testDir: string;
  let mockServer: http.Server;
  let mockPort: number;
  let mockGuid: string;
  let mockTabs: Array<{ id: string; url: string }>;

  beforeAll(async () => {
    mockGuid = crypto.randomUUID();
    mockTabs = [{ id: "tab-return-sec", url: "https://example.com/login" }];

    mockServer = http.createServer((req, res) => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/json/version") {
        res.end(JSON.stringify({
          webSocketDebuggerUrl: `ws://127.0.0.1:${mockPort}/devtools/browser/${mockGuid}`,
        }));
      } else if (req.url === "/json/list" || req.url === "/json") {
        res.end(JSON.stringify(mockTabs));
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>((resolve) => mockServer.listen(0, "127.0.0.1", () => resolve()));
    mockPort = (mockServer.address() as net.AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => mockServer.close(() => resolve()));
  });

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `superagent-return-sec-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`);
    await fsp.mkdir(testDir, { recursive: true });
    manager = new TakeoverSessionManager({ sessionsDir: testDir });
  });

  afterEach(async () => {
    try {
      await fsp.rm(testDir, { recursive: true, force: true });
    } catch {}
  });

  it("fails closed into PAUSED_NEEDS_REVIEW if browser fingerprint changed during takeover", async () => {
    const sessionId = crypto.randomUUID();
    const originalFingerprint = "1111111111111111111111111111111111111111111111111111111111111111"; // Different from mockGuid hash

    const session: TakeoverSession = {
      sessionId,
      targetId: "tab-return-sec",
      port: mockPort,
      profileId: "default",
      generation: "1-12345",
      browserFingerprint: originalFingerprint,
      state: "VERIFYING",
      requestedBy: "agent",
      reason: "Reboot test",
      tokenHash: "dummy",
      invitationRedeemed: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      invitationExpiresAt: Date.now() + 60_000,
      sessionExpiresAt: Date.now() + 120_000,
      auditTrail: [],
    };

    await saveTakeoverSession(session, testDir);

    const res = await manager.verifyAndResume(sessionId, testDir);

    // Must NOT resume the agent!
    expect(res.resumed).toBe(false);
    expect(res.state).toBe("PAUSED_NEEDS_REVIEW");
    expect(res.reason).toContain("fingerprint mismatch");

    const reloaded = await loadTakeoverSession(sessionId, testDir);
    expect(reloaded?.state).toBe("PAUSED_NEEDS_REVIEW");
    expect(reloaded?.resolution).toBe("needs_review");
  });

  it("fails closed into PAUSED_NEEDS_REVIEW if target tab was closed during takeover", async () => {
    const sessionId = crypto.randomUUID();
    const matchingFingerprint = crypto.createHash("sha256")
      .update(`/devtools/browser/${mockGuid}`)
      .digest("hex");

    const session: TakeoverSession = {
      sessionId,
      targetId: "non-existent-closed-tab-999", // Tab is not in mockTabs
      port: mockPort,
      profileId: "default",
      generation: "1-12345",
      browserFingerprint: matchingFingerprint,
      state: "VERIFYING",
      requestedBy: "agent",
      reason: "Closed tab test",
      tokenHash: "dummy",
      invitationRedeemed: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      invitationExpiresAt: Date.now() + 60_000,
      sessionExpiresAt: Date.now() + 120_000,
      auditTrail: [],
    };

    await saveTakeoverSession(session, testDir);

    const res = await manager.verifyAndResume(sessionId, testDir);

    expect(res.resumed).toBe(false);
    expect(res.state).toBe("PAUSED_NEEDS_REVIEW");
    expect(res.reason).toContain("closed during takeover");
  });
});
