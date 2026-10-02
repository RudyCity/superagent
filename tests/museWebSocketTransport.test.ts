import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import os from "os";
import fs from "fs";
import { WebSocket } from "ws";
import {
  generateSecureWsToken,
  maskSecret,
  isMuseWsActive,
  saveRemoteAgentConfig,
  loadRemoteAgentConfig,
  RemoteAgentConfig,
} from "../src/core/remoteAgent/config.js";
import {
  timingSafeCompare,
  validateCloudflareAccess,
  extractBearerToken,
  validateBearerToken,
  ReplayValidator,
} from "../src/core/remoteAgent/museWsAuth.js";
import { MuseWsServerTransport } from "../src/core/remoteAgent/museWsTransport.js";
import { MuseWatcher } from "../src/core/remoteAgent/museWatcher.js";
import {
  TaskBatchEnvelope,
  TaskResultEnvelope,
  RemoteAgentEnvelope,
} from "../src/core/remoteAgent/protocol.js";

describe("Muse WebSocket & Cloudflare Security Suite", () => {
  let tmpConfigDir: string;
  let tmpConfigFile: string;
  let testProjectAlpha: string;
  let testProjectBeta: string;

  beforeEach(() => {
    tmpConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "muse-ws-test-"));
    tmpConfigFile = path.join(tmpConfigDir, "remote-agent.json");
    testProjectAlpha = path.join(tmpConfigDir, "alpha");
    testProjectBeta = path.join(tmpConfigDir, "beta");

    fs.mkdirSync(testProjectAlpha, { recursive: true });
    fs.mkdirSync(testProjectBeta, { recursive: true });

    fs.writeFileSync(path.join(testProjectAlpha, "alpha.txt"), "hello from alpha");
    fs.writeFileSync(path.join(testProjectBeta, "beta.txt"), "hello from beta");
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpConfigDir, { recursive: true, force: true });
    } catch {}
  });

  describe("Security & Authentication Primitives", () => {
    it("should generate random high-entropy tokens and mask secrets safely", () => {
      const token1 = generateSecureWsToken();
      const token2 = generateSecureWsToken();

      expect(typeof token1).toBe("string");
      expect(token1.length).toBeGreaterThanOrEqual(32);
      expect(token1).not.toBe(token2);

      expect(maskSecret(token1)).toContain("...");
      expect(maskSecret(token1).startsWith(token1.slice(0, 4))).toBe(true);
      expect(maskSecret("short")).toBe("********");
      expect(maskSecret("")).toBe("(not configured)");
    });

    it("should perform timing-safe string comparison", () => {
      expect(timingSafeCompare("secret_token_123", "secret_token_123")).toBe(true);
      expect(timingSafeCompare("secret_token_123", "secret_token_456")).toBe(false);
      expect(timingSafeCompare("secret_token_123", "short")).toBe(false);
      expect(timingSafeCompare(undefined, "token")).toBe(false);
    });

    it("should validate Cloudflare Access headers timing-safely", () => {
      const validHeaders = {
        "cf-access-client-id": "client_id_999.access",
        "cf-access-client-secret": "secret_abc123xyz789",
      };

      // Both match
      const check1 = validateCloudflareAccess(
        validHeaders,
        "client_id_999.access",
        "secret_abc123xyz789"
      );
      expect(check1.ok).toBe(true);

      // Wrong secret
      const check2 = validateCloudflareAccess(
        validHeaders,
        "client_id_999.access",
        "wrong_secret"
      );
      expect(check2.ok).toBe(false);
      expect(check2.reason).toContain("CF-Access-Client-Secret");

      // Wrong id
      const check3 = validateCloudflareAccess(
        validHeaders,
        "wrong_id",
        "secret_abc123xyz789"
      );
      expect(check3.ok).toBe(false);
      expect(check3.reason).toContain("CF-Access-Client-Id");

      // None expected -> should pass
      const check4 = validateCloudflareAccess(validHeaders);
      expect(check4.ok).toBe(true);
    });

    it("should extract bearer token from header or URL parameter", () => {
      expect(extractBearerToken("Bearer token_abc_123")).toBe("token_abc_123");
      expect(extractBearerToken("bearer   token_spaced  ")).toBe("token_spaced");
      expect(extractBearerToken(undefined, "/muse?token=my_secret_token")).toBe("my_secret_token");
      expect(extractBearerToken(undefined, "/muse?auth=auth_secret")).toBe("auth_secret");
      expect(extractBearerToken("Basic user:pass")).toBeUndefined();
    });

    it("should enforce replay protection and clock drift window", () => {
      const validator = new ReplayValidator({ maxClockDriftMs: 5000 });
      const now = Date.now();

      // Valid frame
      expect(validator.validate({ ts: now, nonce: "n1" }).ok).toBe(true);

      // Duplicate nonce (replay attack)
      const replay = validator.validate({ ts: now, nonce: "n1" });
      expect(replay.ok).toBe(false);
      expect(replay.reason).toContain("duplicate nonce");

      // Expired timestamp (exceeded drift)
      const expired = validator.validate({ ts: now - 10000, nonce: "n2" });
      expect(expired.ok).toBe(false);
      expect(expired.reason).toContain("Timestamp drift exceeded");

      // Fresh nonce within window
      expect(validator.validate({ ts: now + 500, nonce: "n3" }).ok).toBe(true);
    });
  });

  describe("MuseWsServerTransport Live Socket Tests", () => {
    const testPort = 19225;
    const testToken = "secure_test_bearer_token_999";

    it("should authenticate connection via Bearer token and accept envelopes", async () => {
      const transport = new MuseWsServerTransport({
        wsHost: "127.0.0.1",
        wsPort: testPort,
        wsPath: "/muse",
        wsToken: testToken,
      });

      const receivedEnvelopes: RemoteAgentEnvelope[] = [];
      await transport.start(async (env) => {
        receivedEnvelopes.push(env);
      });

      expect(transport.isConnected()).toBe(false);

      // Connect with valid token
      const ws = new WebSocket(`ws://127.0.0.1:${testPort}/muse`, {
        headers: {
          Authorization: `Bearer ${testToken}`,
        },
      });

      await new Promise<void>((resolve, reject) => {
        ws.on("open", () => resolve());
        ws.on("error", (err) => reject(err));
      });

      expect(transport.isConnected()).toBe(true);

      // Send a test envelope from client
      const testEnvelope: RemoteAgentEnvelope = {
        v: 1,
        kind: "chat",
        text: "hello from test client",
      };

      ws.send(JSON.stringify(testEnvelope));

      // Wait for server to process
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(receivedEnvelopes.length).toBe(1);
      expect(receivedEnvelopes[0].kind).toBe("chat");
      expect((receivedEnvelopes[0] as any).text).toBe("hello from test client");

      // Test server sending envelope to client
      const clientReceived: any[] = [];
      ws.on("message", (data) => {
        clientReceived.push(JSON.parse(data.toString()));
      });

      const serverEnvelope: RemoteAgentEnvelope = {
        v: 1,
        kind: "chat",
        text: "hello from superagent server",
      };
      await transport.sendEnvelope(serverEnvelope);

      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(clientReceived.length).toBe(1);
      expect(clientReceived[0].text).toBe("hello from superagent server");

      ws.close();
      await transport.stop();
    });

    it("should reject connection with invalid Bearer token", async () => {
      const transport = new MuseWsServerTransport({
        wsHost: "127.0.0.1",
        wsPort: testPort,
        wsPath: "/muse",
        wsToken: testToken,
      });

      await transport.start(async () => {});

      // Connect with wrong token
      const ws = new WebSocket(`ws://127.0.0.1:${testPort}/muse`, {
        headers: {
          Authorization: "Bearer wrong_token_xyz",
        },
      });

      const wasRejected = await new Promise<boolean>((resolve) => {
        ws.on("unexpected-response", (req, res) => {
          if (res.statusCode === 401) {
            resolve(true);
          } else {
            resolve(false);
          }
        });
        ws.on("error", () => resolve(true));
        ws.on("open", () => resolve(false));
      });

      expect(wasRejected).toBe(true);
      await transport.stop();
    });

    it("should validate Cloudflare Access headers on connection upgrade", async () => {
      const transport = new MuseWsServerTransport({
        wsHost: "127.0.0.1",
        wsPort: testPort,
        wsPath: "/muse",
        wsToken: testToken,
        cfAccessClientId: "cf_client_123",
        cfAccessClientSecret: "cf_secret_456",
      });

      await transport.start(async () => {});

      // Connect missing CF headers
      const wsBad = new WebSocket(`ws://127.0.0.1:${testPort}/muse`, {
        headers: {
          Authorization: `Bearer ${testToken}`,
        },
      });

      const badRejected = await new Promise<boolean>((resolve) => {
        wsBad.on("unexpected-response", (req, res) => {
          resolve(res.statusCode === 403);
        });
        wsBad.on("error", () => resolve(true));
        wsBad.on("open", () => resolve(false));
      });

      expect(badRejected).toBe(true);

      // Connect with valid CF headers
      const wsGood = new WebSocket(`ws://127.0.0.1:${testPort}/muse`, {
        headers: {
          Authorization: `Bearer ${testToken}`,
          "CF-Access-Client-Id": "cf_client_123",
          "CF-Access-Client-Secret": "cf_secret_456",
        },
      });

      const goodConnected = await new Promise<boolean>((resolve) => {
        wsGood.on("open", () => resolve(true));
        wsGood.on("error", () => resolve(false));
      });

      expect(goodConnected).toBe(true);

      wsGood.close();
      await transport.stop();
    });

    it("should enforce singleton session and reject secondary competing connection", async () => {
      const transport = new MuseWsServerTransport({
        wsHost: "127.0.0.1",
        wsPort: testPort,
        wsPath: "/muse",
        wsToken: testToken,
      });

      await transport.start(async () => {});

      // Primary connection
      const ws1 = new WebSocket(`ws://127.0.0.1:${testPort}/muse`, {
        headers: { Authorization: `Bearer ${testToken}` },
      });

      await new Promise<void>((resolve) => ws1.on("open", () => resolve()));
      expect(transport.isConnected()).toBe(true);

      // Competing secondary connection
      const ws2 = new WebSocket(`ws://127.0.0.1:${testPort}/muse`, {
        headers: { Authorization: `Bearer ${testToken}` },
      });

      const ws2Closed = await new Promise<boolean>((resolve) => {
        ws2.on("close", (code) => {
          resolve(code === 4009);
        });
        ws2.on("error", () => resolve(true));
      });

      expect(ws2Closed).toBe(true);

      ws1.close();
      await transport.stop();
    });
  });

  describe("MuseWatcher with WebSocket Transport & Multi-Project Routing", () => {
    const watcherPort = 19226;
    const watcherToken = "watcher_secret_token_123";

    it("should execute task_batch in targeted workspace over WebSocket and return task_result", async () => {
      saveRemoteAgentConfig(
        {
          transport: "websocket",
          wsHost: "127.0.0.1",
          wsPort: watcherPort,
          wsPath: "/muse",
          wsToken: watcherToken,
          defaultWorkspace: testProjectAlpha,
          workspaces: [testProjectAlpha, testProjectBeta],
        },
        tmpConfigFile
      );

      const watcher = new MuseWatcher({
        customConfigPath: tmpConfigFile,
        announce: false,
      });

      await watcher.start();

      const stats = watcher.getStats();
      expect(stats.isRunning).toBe(true);
      expect(stats.transport).toBe("websocket");
      expect(stats.workspaces.length).toBe(2);

      // Connect remote client
      const ws = new WebSocket(`ws://127.0.0.1:${watcherPort}/muse`, {
        headers: { Authorization: `Bearer ${watcherToken}` },
      });

      await new Promise<void>((resolve) => ws.on("open", () => resolve()));

      const clientResults: TaskResultEnvelope[] = [];
      ws.on("message", (data) => {
        try {
          const env = JSON.parse(data.toString());
          if (env.kind === "task_result") {
            clientResults.push(env as TaskResultEnvelope);
          }
        } catch {}
      });

      // Send a task batch targeting testProjectBeta
      const batchEnvelope: TaskBatchEnvelope = {
        v: 1,
        kind: "task_batch",
        id: "batch_test_001",
        task_id: "task_ws_multi",
        project: "beta",
        calls: [
          {
            id: "call_read_beta",
            tool: "read_file",
            args: { path: "beta.txt" },
          },
        ],
      };

      ws.send(JSON.stringify(batchEnvelope));

      // Wait for batch execution and result back over WebSocket
      await new Promise((resolve) => setTimeout(resolve, 800));

      expect(clientResults.length).toBe(1);
      const res = clientResults[0];
      expect(res.task_id).toBe("task_ws_multi");
      expect(res.results.length).toBe(1);
      expect(res.results[0].id).toBe("call_read_beta");
      expect(res.results[0].ok).toBe(true);
      expect(res.results[0].output).toContain("hello from beta");

      ws.close();
      await watcher.stop();
    });
  });
});
