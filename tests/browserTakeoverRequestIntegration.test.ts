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
      const verified = await manager.verifyAndResume(invitation.sessionId, dir);
      expect(verified.resumed).toBe(true);
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
});
