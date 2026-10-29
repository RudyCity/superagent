import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  registerManagedBrowser, listManagedBrowserRegistrations,
  listVerifiedManagedBrowserRegistrations, currentManagedBrowserFingerprint,
  resetManagedBrowserRegistrationsForTests, validateManagedBrowserRegistration,
} from "../src/core/tools/managedBrowserRegistry.js";
const pair = {
  profileId: "default-managed",
  generation: "3210-1792926500000000000",
  port: 53331,
  targetId: "TARGET123",
  browserFingerprint: "a".repeat(64),
};
const originalDir = process.env.SUPERAGENT_CDP_SESSION_DIR;
let testDir = "";
beforeAll(() => {
  testDir = mkdtempSync(join(tmpdir(), "managed-registry-test-"));
  process.env.SUPERAGENT_CDP_SESSION_DIR = testDir;
});
afterEach(() => resetManagedBrowserRegistrationsForTests());
afterAll(() => {
  if (originalDir === undefined) delete process.env.SUPERAGENT_CDP_SESSION_DIR;
  else process.env.SUPERAGENT_CDP_SESSION_DIR = originalDir;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
});
describe("managed browser Core registration", () => {
  test("announces only a verified live tab; never issues a CDP capability", async () => {
    const discover = async (port: number) => {
      expect(port).toBe(53331);
      return [{ targetId: "TARGET123", title: "Test", url: "about:blank" }];
    };
    const row = await registerManagedBrowser(pair, discover, 1000, async () => pair.browserFingerprint);
    expect(row.expiresAt).toBe(91000);
    expect(listManagedBrowserRegistrations(1001)).toHaveLength(1);
    expect(JSON.stringify(row)).not.toContain("sessionToken");
    expect(JSON.stringify(row)).not.toContain("password");
    const verified = await listVerifiedManagedBrowserRegistrations(1001, async () => pair.browserFingerprint);
    expect(verified).toHaveLength(1);
    expect(JSON.stringify(verified)).not.toContain(pair.browserFingerprint);
    expect(await listVerifiedManagedBrowserRegistrations(1001, async () => "b".repeat(64))).toEqual([]);
    expect(await currentManagedBrowserFingerprint(pair.port, pair.targetId,
      async () => pair.browserFingerprint)).toBeNull(); // fixture timestamps have expired in real time
    expect(listManagedBrowserRegistrations(91000)).toHaveLength(0);
  });
  test("prevents a stale owner from using a replaced managed browser identity", async () => {
    const now = Date.now();
    const discover = async () => [{ targetId: pair.targetId, title: "Test", url: "about:blank" }];
    await registerManagedBrowser(pair, discover, now, async () => pair.browserFingerprint);
    expect(await currentManagedBrowserFingerprint(pair.port, pair.targetId,
      async () => pair.browserFingerprint)).toBe(pair.browserFingerprint);
    await expect(currentManagedBrowserFingerprint(pair.port, pair.targetId,
      async () => "b".repeat(64))).rejects.toThrow("fresh desktop pairing");
  });
  test("rejects forged body, stale target and conflicting generations", async () => {
    for (const override of [
      { profileId: "../Default" }, { generation: "../../other" },
      { port: 80 }, { targetId: "invalid/tab" }, { sessionToken: "forbidden" },
      { browserFingerprint: "invalid" },
    ]) {
      expect(() => validateManagedBrowserRegistration({ ...pair, ...override })).toThrow();
    }
    const discover = async () => [{ targetId: "TARGET123", title: "", url: "" }];
    await expect(registerManagedBrowser({ ...pair, targetId: "MISSING" }, discover, 1000, async () => pair.browserFingerprint)).rejects.toThrow();
    await expect(registerManagedBrowser(pair, discover, 1000, async () => "b".repeat(64))).rejects.toThrow("identity changed");
    await registerManagedBrowser(pair, discover, 1000, async () => pair.browserFingerprint);
    await expect(registerManagedBrowser({ ...pair, generation: "3211-1792926500000000000" }, discover, 2000, async () => pair.browserFingerprint)).rejects.toThrow("conflict");
    expect(listManagedBrowserRegistrations(2000)).toHaveLength(1);
  });
});
