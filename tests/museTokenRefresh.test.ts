import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "path";
import os from "os";
import fs from "fs";
import { WebSocket } from "ws";
import {
  generateSecureWsToken,
  rotateWsToken,
  loadRemoteAgentConfig,
  saveRemoteAgentConfig,
} from "../src/core/remoteAgent/config.js";
import {
  validateBearerToken,
} from "../src/core/remoteAgent/museWsAuth.js";
import {
  validateEnvelope,
  TokenRefreshRequestEnvelope,
  TokenRefreshResponseEnvelope,
  TokenRefreshEnvelope,
  TokenAckEnvelope,
} from "../src/core/remoteAgent/protocol.js";
import {
  MuseWsServerTransport,
  MuseWsClientTransport,
} from "../src/core/remoteAgent/museWsTransport.js";

describe("Muse WebSocket Token Refresh & Handshake Suite", () => {
  let tmpConfigDir: string;
  let tmpConfigFile: string;

  beforeEach(() => {
    tmpConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "muse-token-test-"));
    tmpConfigFile = path.join(tmpConfigDir, "remote-agent.json");
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpConfigDir, { recursive: true, force: true });
    } catch {}
  });

  describe("Token Rotation & Dual-Token Validation Primitives", () => {
    it("should rotate token and preserve previous token with rotation timestamp", () => {
      const initialToken = "initial_token_12345678901234567890";
      saveRemoteAgentConfig(
        {
          transport: "websocket",
          wsToken: initialToken,
        },
        tmpConfigFile
      );

      const rotation = rotateWsToken(tmpConfigFile, 120000);
      expect(rotation.previousToken).toBe(initialToken);
      expect(rotation.newToken).toBeDefined();
      expect(rotation.newToken).not.toBe(initialToken);

      const updated = loadRemoteAgentConfig(tmpConfigFile);
      expect(updated.wsToken).toBe(rotation.newToken);
      expect(updated.previousWsToken).toBe(initialToken);
      expect(updated.tokenGracePeriodMs).toBe(120000);
      expect(typeof updated.tokenRotatedAt).toBe("number");
      expect(Date.now() - (updated.tokenRotatedAt || 0)).toBeLessThan(2000);
    });

    it("should accept active token and previous token during grace period", () => {
      const currentToken = "current_token_abc";
      const previousToken = "previous_token_xyz";
      const rotatedAt = Date.now() - 30000; // 30 seconds ago
      const gracePeriodMs = 60000; // 60 seconds grace window

      // Active token is valid
      expect(
        validateBearerToken(currentToken, currentToken, previousToken, rotatedAt, gracePeriodMs)
      ).toBe(true);

      // Previous token within grace period is valid
      expect(
        validateBearerToken(previousToken, currentToken, previousToken, rotatedAt, gracePeriodMs)
      ).toBe(true);

      // Completely invalid token is rejected
      expect(
        validateBearerToken("random_token", currentToken, previousToken, rotatedAt, gracePeriodMs)
      ).toBe(false);
    });

    it("should reject previous token once grace window expires", () => {
      const currentToken = "current_token_abc";
      const previousToken = "previous_token_xyz";
      const rotatedAt = Date.now() - 70000; // 70 seconds ago
      const gracePeriodMs = 60000; // 60 seconds grace window

      // Active token is still valid
      expect(
        validateBearerToken(currentToken, currentToken, previousToken, rotatedAt, gracePeriodMs)
      ).toBe(true);

      // Previous token after grace period is rejected
      expect(
        validateBearerToken(previousToken, currentToken, previousToken, rotatedAt, gracePeriodMs)
      ).toBe(false);
    });
  });

  describe("Token Refresh Protocol Envelope Validation", () => {
    it("should validate token_refresh_request envelope", () => {
      const envelope: TokenRefreshRequestEnvelope = {
        v: 1,
        kind: "token_refresh_request",
        id: "req_123",
        reason: "scheduled_renewal",
        ts: Date.now(),
        nonce: "nonce_123",
      };

      const result = validateEnvelope(envelope);
      expect(result.valid).toBe(true);
      expect(result.envelope?.kind).toBe("token_refresh_request");
    });

    it("should validate token_refresh_response envelope", () => {
      const envelope: TokenRefreshResponseEnvelope = {
        v: 1,
        kind: "token_refresh_response",
        id: "resp_123",
        request_id: "req_123",
        token: "brand_new_token_456",
        expires_in: 86400,
        grace_period_seconds: 300,
        ts: Date.now(),
        nonce: "nonce_456",
      };

      const result = validateEnvelope(envelope);
      expect(result.valid).toBe(true);
      expect(result.envelope?.kind).toBe("token_refresh_response");
    });

    it("should validate token_refresh and token_ack envelopes", () => {
      const refreshEnvelope: TokenRefreshEnvelope = {
        v: 1,
        kind: "token_refresh",
        id: "refresh_789",
        token: "brand_new_token_789",
        expires_in: 86400,
        grace_period_seconds: 300,
        ts: Date.now(),
        nonce: "nonce_789",
      };

      const ackEnvelope: TokenAckEnvelope = {
        v: 1,
        kind: "token_ack",
        id: "ack_999",
        refresh_id: "refresh_789",
        status: "ok",
        ts: Date.now(),
        nonce: "nonce_999",
      };

      expect(validateEnvelope(refreshEnvelope).valid).toBe(true);
      expect(validateEnvelope(ackEnvelope).valid).toBe(true);
    });

    it("should reject token envelopes with missing required fields", () => {
      const badRefresh = {
        v: 1,
        kind: "token_refresh",
        id: "refresh_bad",
        // missing token!
      };
      expect(validateEnvelope(badRefresh).valid).toBe(false);

      const badAck = {
        v: 1,
        kind: "token_ack",
        id: "ack_bad",
        // missing refresh_id
      };
      expect(validateEnvelope(badAck).valid).toBe(false);
    });
  });

  describe("Interactive Handshake over Live WebSocket Server", () => {
    const testPort = 19230;
    const initialToken = "handshake_token_alpha_123456789";

    it("should exchange token_refresh_request and token_refresh_response over live connection", async () => {
      saveRemoteAgentConfig(
        {
          transport: "websocket",
          wsHost: "127.0.0.1",
          wsPort: testPort,
          wsPath: "/muse",
          wsToken: initialToken,
          tokenGracePeriodMs: 60000,
        },
        tmpConfigFile
      );

      const transport = new MuseWsServerTransport(
        {
          wsHost: "127.0.0.1",
          wsPort: testPort,
          wsPath: "/muse",
          wsToken: initialToken,
          tokenGracePeriodMs: 60000,
        },
        tmpConfigFile
      );

      await transport.start(async () => {});

      const ws = new WebSocket(`ws://127.0.0.1:${testPort}/muse`, {
        headers: { Authorization: `Bearer ${initialToken}` },
      });

      await new Promise<void>((resolve) => ws.on("open", () => resolve()));
      expect(transport.isConnected()).toBe(true);

      const receivedMessages: any[] = [];
      ws.on("message", (data) => {
        try {
          receivedMessages.push(JSON.parse(data.toString()));
        } catch {}
      });

      // Send token_refresh_request
      const req: TokenRefreshRequestEnvelope = {
        v: 1,
        kind: "token_refresh_request",
        id: "req_test_handshake",
        reason: "periodic_refresh",
        ts: Date.now(),
        nonce: "test_nonce_1",
      };
      ws.send(JSON.stringify(req));

      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(receivedMessages.length).toBe(1);
      const resp = receivedMessages[0];
      expect(resp.kind).toBe("token_refresh_response");
      expect(resp.request_id).toBe("req_test_handshake");
      expect(resp.token).toBeDefined();
      expect(resp.token).not.toBe(initialToken);
      expect(resp.grace_period_seconds).toBe(60);

      // Verify that config was updated on disk
      const updatedConfig = loadRemoteAgentConfig(tmpConfigFile);
      expect(updatedConfig.wsToken).toBe(resp.token);
      expect(updatedConfig.previousWsToken).toBe(initialToken);

      // Close first connection so second can become active
      await new Promise<void>((resolve) => {
        ws.on("close", () => resolve());
        ws.close();
      });
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Reconnect using the previous token during grace period
      const wsReconnPrev = new WebSocket(`ws://127.0.0.1:${testPort}/muse`, {
        headers: { Authorization: `Bearer ${initialToken}` },
      });

      const reconnOpened = await new Promise<boolean>((resolve) => {
        wsReconnPrev.on("open", () => resolve(true));
        wsReconnPrev.on("error", () => resolve(false));
        wsReconnPrev.on("close", () => resolve(false));
      });
      expect(reconnOpened).toBe(true);

      wsReconnPrev.close();
      await transport.stop();
    });

    it("should push proactive token_refresh and receive token_ack", async () => {
      const port = 19231;
      const serverToken = "proactive_server_token_123";

      saveRemoteAgentConfig(
        {
          transport: "websocket",
          wsHost: "127.0.0.1",
          wsPort: port,
          wsPath: "/muse",
          wsToken: serverToken,
          tokenGracePeriodMs: 60000,
        },
        tmpConfigFile
      );

      const transport = new MuseWsServerTransport(
        {
          wsHost: "127.0.0.1",
          wsPort: port,
          wsPath: "/muse",
          wsToken: serverToken,
          tokenGracePeriodMs: 60000,
        },
        tmpConfigFile
      );

      await transport.start(async () => {});

      const ws = new WebSocket(`ws://127.0.0.1:${port}/muse`, {
        headers: { Authorization: `Bearer ${serverToken}` },
      });

      await new Promise<void>((resolve) => ws.on("open", () => resolve()));

      const clientEnvelopes: any[] = [];
      ws.on("message", (data) => {
        try {
          const env = JSON.parse(data.toString());
          clientEnvelopes.push(env);
          if (env.kind === "token_refresh") {
            // Reply with token_ack
            const ack: TokenAckEnvelope = {
              v: 1,
              kind: "token_ack",
              id: "ack_test_1",
              refresh_id: env.id,
              status: "ok",
              ts: Date.now(),
              nonce: "ack_nonce_1",
            };
            ws.send(JSON.stringify(ack));
          }
        } catch {}
      });

      // Proactively rotate token on server
      const rotation = transport.rotateToken("admin_rotation");
      expect(rotation.newToken).toBeDefined();
      expect(rotation.previousToken).toBe(serverToken);

      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(clientEnvelopes.length).toBe(1);
      expect(clientEnvelopes[0].kind).toBe("token_refresh");
      expect(clientEnvelopes[0].token).toBe(rotation.newToken);

      ws.close();
      await transport.stop();
    });

    it("should handle client transport receiving token_refresh and storing new token", async () => {
      const port = 19232;
      const initialServerToken = "client_test_token_initial";

      const serverTransport = new MuseWsServerTransport(
        {
          wsHost: "127.0.0.1",
          wsPort: port,
          wsPath: "/muse",
          wsToken: initialServerToken,
          tokenGracePeriodMs: 60000,
        },
        tmpConfigFile
      );

      await serverTransport.start(async () => {});

      const clientConfigPath = path.join(tmpConfigDir, "client-config.json");
      saveRemoteAgentConfig(
        {
          wsMode: "client",
          wsRemoteUrl: `ws://127.0.0.1:${port}/muse`,
          wsToken: initialServerToken,
        },
        clientConfigPath
      );

      const clientTransport = new MuseWsClientTransport(
        {
          wsMode: "client",
          wsRemoteUrl: `ws://127.0.0.1:${port}/muse`,
          wsToken: initialServerToken,
        },
        clientConfigPath
      );

      await clientTransport.start(async () => {});

      // Allow connection to establish
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(clientTransport.isConnected()).toBe(true);

      // Server pushes token rotation
      const rotation = serverTransport.rotateToken("scheduled");

      await new Promise((resolve) => setTimeout(resolve, 300));

      // Client config file should now be updated with the fresh token
      const clientConfig = loadRemoteAgentConfig(clientConfigPath);
      expect(clientConfig.wsToken).toBe(rotation.newToken);

      await clientTransport.stop();
      await serverTransport.stop();
    });
  });
});
