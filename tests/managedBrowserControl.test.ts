import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setManagedBrowserControl } from "../src/core/tools/managedBrowserControl.js";
import { registerManagedBrowser } from "../src/core/tools/managedBrowserRegistry.js";
import { claimCdpTarget, withCdpTargetWrite, withCdpTargetRead } from "../src/core/tools/chromeCdpSessionManager.js";

describe("same-tab human/agent handoff", () => {
  let server: Server;
  let port: number;
  let directory: string;
  const targetId = "HANDOFF_TAB";
  const guid = randomUUID();
  const fingerprint = createHash("sha256").update("/devtools/browser/" + guid).digest("hex");
  const previous = process.env.SUPERAGENT_CDP_SESSION_DIR;
  const generation = "1001-1793000000000000";
  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), "browser-handoff-"));
    process.env.SUPERAGENT_CDP_SESSION_DIR = directory;
    server = createServer((req, res) => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/json/version") {
        res.end(JSON.stringify({ webSocketDebuggerUrl: "ws://127.0.0.1:" + port + "/devtools/browser/" + guid }));
      } else if (req.url === "/json/list") {
        res.end(JSON.stringify([{ id: targetId, type: "page", title: "Shared", url: "https://example.org/",
          webSocketDebuggerUrl: "ws://127.0.0.1:" + port + "/devtools/page/" + targetId }]));
      } else { res.writeHead(404); res.end(); }
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
    port = (server.address() as { port: number }).port;
  });
  afterAll(async () => {
    if (previous === undefined) delete process.env.SUPERAGENT_CDP_SESSION_DIR;
    else process.env.SUPERAGENT_CDP_SESSION_DIR = previous;
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  });
  test("blocks agent writes during human control and resumes without changing CDP tab", async () => {
    const identity = { profileId: "default-managed", generation, port, targetId, browserFingerprint: fingerprint };
    await registerManagedBrowser(identity, async () => [{ targetId, title: "Shared", url: "https://example.org/" }]);
    const claim = await claimCdpTarget(port, targetId, "unit-agent");
    expect((await setManagedBrowserControl({ ...identity, mode: "human" })).mode).toBe("human");
    let writes = 0;
    await expect(withCdpTargetWrite(port, targetId, "unit-agent", async () => { writes++; }, {
      sessionToken: claim.sessionToken,
    })).rejects.toThrow(/Human has control/);
    expect(writes).toBe(0);
    // The agent may still observe, but cannot click/type/navigate.
    expect(await withCdpTargetRead(port, targetId, { agentId: "unit-agent", sessionToken: claim.sessionToken },
      async () => "preview")).toBe("preview");
    expect((await setManagedBrowserControl({ ...identity, mode: "agent" })).mode).toBe("agent");
    await withCdpTargetWrite(port, targetId, "unit-agent", async () => { writes++; }, {
      sessionToken: claim.sessionToken,
    });
    expect(writes).toBe(1);
    await expect(setManagedBrowserControl({ ...identity, browserFingerprint: "f".repeat(64), mode: "human" }))
      .rejects.toThrow();
  });
  test("rejects unauthenticated or malformed local control input", async () => {
    await expect(setManagedBrowserControl({ mode: "human", port })).rejects.toThrow();
    await expect(setManagedBrowserControl({ mode: "force", port, targetId })).rejects.toThrow();
    await expect(setManagedBrowserControl({ profileId: "default-managed", generation, port, targetId,
      browserFingerprint: fingerprint, mode: "human", sessionToken: "forbidden" })).rejects.toThrow();
  });
});
