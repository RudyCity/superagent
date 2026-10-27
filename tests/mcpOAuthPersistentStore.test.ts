import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpOAuthStore } from "../src/core/mcp/mcpOAuthStore.js";
import {
  createPersistentMcpOAuthStore,
  describeMcpOAuthStore,
  isPersistableMcpOAuthIssuer,
  issuerOAuthStateDir,
} from "../src/core/mcp/mcpOAuthPersistentStore.js";

const roots: string[] = [];
function root(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-oauth-persist-"));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const issuer = "https://persist-test.example";
const winIt = process.platform === "win32" ? it : it.skip;

describe("persistent production OAuth store selection", () => {
  it("recognizes only public HTTPS and exact loopback issuers", () => {
    expect(isPersistableMcpOAuthIssuer("https://public.example")).toBe(true);
    expect(isPersistableMcpOAuthIssuer("http://127.0.0.1:9227")).toBe(true);
    expect(isPersistableMcpOAuthIssuer("http://localhost:9227")).toBe(false);
    expect(isPersistableMcpOAuthIssuer("http://public.example")).toBe(false);
    expect(isPersistableMcpOAuthIssuer("")).toBe(false);
  });

  it("keeps in-memory state for an unsupported issuer", () => {
    const selection = createPersistentMcpOAuthStore({ issuer: "http://localhost:9227", rootDir: root() });
    expect(selection.persistent).toBe(false);
    expect(selection.reason).toBe("unsupported-issuer");
    expect(selection.store).toBeInstanceOf(McpOAuthStore);
    expect(describeMcpOAuthStore(selection)).toContain("issuer");
  });

  it("never writes a plaintext issuer key on platforms without DPAPI", () => {
    const dir = root();
    const selection = createPersistentMcpOAuthStore({ issuer, rootDir: dir, platform: "linux" });
    expect(selection.persistent).toBe(false);
    expect(selection.reason).toBe("dpapi-unavailable");
    expect(describeMcpOAuthStore(selection)).toContain("DPAPI");
    expect(fs.readdirSync(dir)).toHaveLength(0);
  });

  it("scopes state by issuer so a rotated public URL never inherits old tokens", () => {
    const dir = root();
    const first = issuerOAuthStateDir(issuer, dir);
    const rotated = issuerOAuthStateDir("https://rotated-tunnel.example", dir);
    expect(first).not.toBe(rotated);
    expect(issuerOAuthStateDir(issuer, dir)).toBe(first);
    expect(issuerOAuthStateDir(`${issuer}/`, dir)).toBe(first);
    expect(first.startsWith(path.join(dir, "issuer-"))).toBe(true);
  });

  winIt("survives an owner restart for the same issuer and stays isolated per issuer", () => {
    const dir = root();
    const first = createPersistentMcpOAuthStore({ issuer, rootDir: dir });
    expect(first.persistent).toBe(true);
    expect(first.profileDir).toBeTruthy();
    first.store.registerClient("client-restart", ["https://client.example/cb"]);

    const restarted = createPersistentMcpOAuthStore({ issuer, rootDir: dir });
    expect(restarted.persistent).toBe(true);
    expect(restarted.store.getClient("client-restart")).toBeDefined();

    const otherIssuer = createPersistentMcpOAuthStore({ issuer: "https://other-tunnel.example", rootDir: dir });
    expect(otherIssuer.persistent).toBe(true);
    expect(otherIssuer.store.getClient("client-restart")).toBeUndefined();
  }, 60000);
});
