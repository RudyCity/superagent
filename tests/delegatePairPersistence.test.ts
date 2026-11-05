import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import WebSocket from "ws";
import { DelegateBridge } from "../src/core/delegate/bridge.js";
import { digestDelegateToken, loadDelegatePairProofs, matchesDelegateTokenDigest } from "../src/core/delegate/pairedClientStore.js";

const clientId = "delegate-profile-001";
const origin = "chrome-extension://" + "a".repeat(32);
const otherOrigin = "chrome-extension://" + "b".repeat(32);
const bridges: DelegateBridge[] = [];
const sockets: WebSocket[] = [];
const dirs: string[] = [];

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return await new Promise(resolve => server.close(() => resolve(address.port)));
}

async function dial(
  port: number, credentials: { pair?: string; authToken?: string; origin?: string } = {},
): Promise<{ ws: WebSocket; ack?: any; closeCode?: number }> {
  const ws = new WebSocket("ws://127.0.0.1:" + port, {
    headers: { Origin: credentials.origin || origin },
  });
  sockets.push(ws);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  const outcome = new Promise<{ ws: WebSocket; ack?: any; closeCode?: number }>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("handshake timeout")), 1500);
    ws.on("message", raw => {
      const response = JSON.parse(raw.toString());
      if (response.type === "hello_ack") {
        clearTimeout(timeout);
        resolve({ ws, ack: response });
      }
    });
    ws.once("close", code => { clearTimeout(timeout); resolve({ ws, closeCode: code }); });
  });
  ws.send(JSON.stringify({
    type: "hello", protocol: "superagent-delegate-v1", clientId, label: "Test",
    ...(credentials.pair ? { pairingCode: credentials.pair } : {}),
    ...(credentials.authToken ? { authToken: credentials.authToken } : {}),
  }));
  return outcome;
}

function makeBridge(port: number, master: string, path: string): DelegateBridge {
  const bridge = new DelegateBridge(port, master, () => {}, () => {}, path);
  bridges.push(bridge);
  return bridge;
}

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  for (const bridge of bridges.splice(0)) await bridge.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Delegate pairing remains authenticated across Core restarts", () => {
  it("stores only an origin-bound digest and accepts the same Chrome profile after a new Core master secret", async () => {
    const dir = mkdtempSync(join(tmpdir(), "delegate-proof-"));
    dirs.push(dir);
    const file = join(dir, "pairs.json");
    const port = await freePort();
    const first = makeBridge(port, "a".repeat(64), file);
    await first.start();
    const pair = first.getPairingCode()?.code;
    expect(pair).toBeTruthy();
    const initial = await dial(port, { pair });
    expect(initial.ack).toBeDefined();
    const bearer = initial.ack.authToken as string;
    expect(bearer.length).toBeGreaterThanOrEqual(32);
    const disk = readFileSync(file, "utf8");
    expect(disk).not.toContain(bearer);
    expect(disk).toContain(digestDelegateToken(bearer));
    expect(loadDelegatePairProofs(file).get(clientId)?.extensionId).toBe("a".repeat(32));
    await first.close();

    const second = makeBridge(port, "b".repeat(64), file);
    await second.start();
    const wrongOrigin = await dial(port, { authToken: bearer, origin: otherOrigin });
    expect(wrongOrigin.closeCode).toBe(1008);
    const wrongSecret = await dial(port, { authToken: "c".repeat(64) });
    expect(wrongSecret.closeCode).toBe(1008);
    const restored = await dial(port, { authToken: bearer });
    expect(restored.ack?.clientId).toBe(clientId);
    expect(restored.ack?.authToken).toBeUndefined();
    expect(second.listConnections()).toHaveLength(1);
    expect(second.disconnectClient(clientId)).toBe(true);
    await second.close();

    const third = makeBridge(port, "d".repeat(64), file);
    await third.start();
    const revoked = await dial(port, { authToken: bearer });
    expect(revoked.closeCode).toBe(1008);
  });

  it("fails closed on malformed digest stores or invalid credentials", () => {
    const dir = mkdtempSync(join(tmpdir(), "delegate-proof-malformed-"));
    dirs.push(dir);
    const file = join(dir, "pairs.json");
    writeFileSync(file, JSON.stringify({ version: 1, clients: [
      { clientId, extensionId: "a".repeat(32), tokenDigest: "not-a-digest" },
    ] }));
    expect(loadDelegatePairProofs(file).size).toBe(0);
    expect(matchesDelegateTokenDigest("x".repeat(64), "a".repeat(64))).toBe(false);
    expect(matchesDelegateTokenDigest(digestDelegateToken("a".repeat(64)), "z".repeat(64))).toBe(false);
    expect(matchesDelegateTokenDigest(digestDelegateToken("a".repeat(64)), "a".repeat(64))).toBe(true);
  });
});
