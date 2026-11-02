import { afterEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import http from "node:http";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TakeoverSessionManager } from "../src/core/browserTakeover/takeoverSessionManager.js";
import { getBrowserProcessManager } from "../src/core/browserRuntime/browserProcessManager.js";
import { resetManagedBrowserRegistrationsForTests } from "../src/core/tools/managedBrowserRegistry.js";
import { assertManagedAgentMayWrite } from "../src/core/tools/managedBrowserControl.js";

describe("End-to-end same-tab takeover contention", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetManagedBrowserRegistrationsForTests();
  });

  it("rejects the rival takeover, keeps agent writes held, and only releases on verified return", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "sa-takeover-e2e-"));
    const previous = process.env.SUPERAGENT_CDP_SESSION_DIR;
    process.env.SUPERAGENT_CDP_SESSION_DIR = dir;
    const guid = crypto.randomUUID();
    const targetId = "e2e-owned-tab";
    const generation = "1001-1793000000000000";
    const profileName = "test-profile";
    const fingerprint = crypto.createHash("sha256").update("/devtools/browser/" + guid).digest("hex");
    let port = 0;
    const server = http.createServer((req, res) => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/json/version") {
        res.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/${guid}` }));
      } else if (req.url === "/json/list" || req.url === "/json") {
        res.end(JSON.stringify([{ id: targetId, type: "page", title: "Test", url: "https://example.org/",
          webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/${targetId}` }]));
      } else {
        res.writeHead(404); res.end();
      }
    });
    try {
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
      port = (server.address() as { port: number }).port;
      vi.spyOn(getBrowserProcessManager(), "getActiveInstance").mockImplementation((requestedPort) =>
        requestedPort === port ? ({
          port, profileName, generation, browserFingerprint: fingerprint,
          virtualDisplay: { displayNumber: 99, noVncPort: 6080, vncPort: 5999, vncPassword: "test-pass" },
        } as any) : undefined
      );
      const manager = new TakeoverSessionManager({ sessionsDir: dir, invitationTtlMs: 60_000, sessionTtlMs: 180_000 });
      const [first, second] = await Promise.allSettled([
        manager.requestTakeover({ port, targetId, reason: "first claimant" }, dir),
        manager.requestTakeover({ port, targetId, reason: "second claimant" }, dir),
      ]);
      const success = [first, second].filter(r => r.status === "fulfilled");
      expect(success).toHaveLength(1);
      expect([first, second].filter(r => r.status === "rejected")).toHaveLength(1);
      await expect(assertManagedAgentMayWrite(port, targetId)).rejects.toThrow(/Human has control/i);

      const invitation = (success[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof manager.requestTakeover>>>).value;
      const redeemed = await manager.redeemInvitation({
        sessionId: invitation.sessionId, invitationToken: invitation.invitationToken,
      }, dir);
      expect(redeemed.authorized).toBe(true);
      expect(redeemed.vncPassword).toBe("test-pass");
      expect((await manager.requestReturn({
        sessionId: invitation.sessionId, operatorToken: redeemed.operatorToken,
      }, dir)).state).toBe("VERIFYING");
      // Exactly one parallel verifier may release this browser hold.
      const outcomes = await Promise.allSettled([
        manager.verifyAndResume(invitation.sessionId, dir),
        manager.verifyAndResume(invitation.sessionId, dir),
      ]);
      expect(outcomes.filter(outcome => outcome.status === "fulfilled")).toHaveLength(1);
      expect(outcomes.filter(outcome => outcome.status === "rejected")).toHaveLength(1);
      expect((outcomes.find(outcome => outcome.status === "fulfilled") as PromiseFulfilledResult<any>).value.resumed).toBe(true);
      await expect(assertManagedAgentMayWrite(port, targetId)).resolves.toBeUndefined();

      // A verified return frees the reservation so another session may take
      // control, without requiring an unsafe forced cleanup.
      const next = await manager.requestTakeover({ port, targetId, reason: "new claim after verified return" }, dir);
      expect(next.sessionId).not.toBe(invitation.sessionId);
    } finally {
      if (previous === undefined) delete process.env.SUPERAGENT_CDP_SESSION_DIR;
      else process.env.SUPERAGENT_CDP_SESSION_DIR = previous;
      await new Promise<void>(resolve => server.close(() => resolve()));
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps native writes blocked through Core restart, browser outage, and operator retry", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "sa-m4b-browser-failure-"));
    const previous = process.env.SUPERAGENT_CDP_SESSION_DIR;
    const previousLeases = process.env.SUPERAGENT_TAKEOVER_SESSIONS_DIR;
    process.env.SUPERAGENT_CDP_SESSION_DIR = dir;
    process.env.SUPERAGENT_TAKEOVER_SESSIONS_DIR = dir;
    const guid = crypto.randomUUID();
    const targetId = "restart-owned-tab";
    const generation = "1001-1793000000000000";
    const fingerprint = crypto.createHash("sha256").update("/devtools/browser/" + guid).digest("hex");
    let port = 0;
    let browserOnline = true;
    const server = http.createServer((req, res) => {
      res.setHeader("Content-Type", "application/json");
      if (!browserOnline) {
        res.writeHead(503); res.end(JSON.stringify({ error: "browser stopped" })); return;
      }
      if (req.url === "/json/version") {
        res.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/${guid}` }));
      } else if (req.url === "/json/list" || req.url === "/json") {
        res.end(JSON.stringify([{ id: targetId, type: "page", title: "Recovery", url: "https://example.org/",
          webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/${targetId}` }]));
      } else { res.writeHead(404); res.end(); }
    });
    try {
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      port = (server.address() as { port: number }).port;
      vi.spyOn(getBrowserProcessManager(), "getActiveInstance").mockImplementation((p) =>
        p === port && browserOnline ? ({
          port, profileName: "test-profile", generation, browserFingerprint: fingerprint,
          virtualDisplay: { displayNumber: 99, noVncPort: 6080, vncPort: 5999 },
        } as any) : undefined
      );
      const firstCore = new TakeoverSessionManager({ sessionsDir: dir });
      const invitation = await firstCore.requestTakeover({ port, targetId, reason: "restart certification" }, dir);
      const { operatorToken } = await firstCore.redeemInvitation({
        sessionId: invitation.sessionId, invitationToken: invitation.invitationToken,
      }, dir);
      await expect(assertManagedAgentMayWrite(port, targetId)).rejects.toThrow(/Human has control/);

      const restartedCore = new TakeoverSessionManager({ sessionsDir: dir });
      const reconciliation = await restartedCore.reconcileAfterRestart();
      expect(reconciliation).toEqual({ scanned: 1, reconciled: 1, requiresReview: 1 });
      await expect(assertManagedAgentMayWrite(port, targetId)).rejects.toThrow(/Human has control/);
      await expect(restartedCore.requestReturn({ sessionId: invitation.sessionId, operatorToken: "invalid" }, dir))
        .rejects.toThrow(/authorization required/i);
      expect((await restartedCore.requestReturn({
        sessionId: invitation.sessionId, operatorToken,
      }, dir)).state).toBe("VERIFYING");

      browserOnline = false; // browser crashed before verification
      const failed = await restartedCore.verifyAndResume(invitation.sessionId, dir);
      expect(failed).toMatchObject({ state: "PAUSED_NEEDS_REVIEW", resumed: false });
      await expect(assertManagedAgentMayWrite(port, targetId)).rejects.toThrow(/identity unavailable|Human has control/i);
      browserOnline = true;
      await expect(restartedCore.requestTakeover({ port, targetId, reason: "rival" }, dir))
        .rejects.toThrow(/already reserves/i);

      expect((await restartedCore.requestReturn({
        sessionId: invitation.sessionId, operatorToken,
      }, dir)).state).toBe("VERIFYING");
      const recovered = await restartedCore.verifyAndResume(invitation.sessionId, dir);
      expect(recovered).toMatchObject({ state: "AGENT_ACTIVE", resumed: true });
      await expect(assertManagedAgentMayWrite(port, targetId)).resolves.toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.SUPERAGENT_CDP_SESSION_DIR;
      else process.env.SUPERAGENT_CDP_SESSION_DIR = previous;
      if (previousLeases === undefined) delete process.env.SUPERAGENT_TAKEOVER_SESSIONS_DIR;
      else process.env.SUPERAGENT_TAKEOVER_SESSIONS_DIR = previousLeases;
      await new Promise<void>(resolve => server.close(() => resolve()));
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});
