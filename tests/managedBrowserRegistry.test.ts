import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  registerManagedBrowser, listManagedBrowserRegistrations,
  resetManagedBrowserRegistrationsForTests, validateManagedBrowserRegistration,
} from "../src/core/tools/managedBrowserRegistry.js";
const pair = {
  profileId: "default-managed",
  generation: "3210-1792926500000000000",
  port: 53331,
  targetId: "TARGET123",
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
    const row = await registerManagedBrowser(pair, discover, 1000);
    expect(row.expiresAt).toBe(91000);
    expect(listManagedBrowserRegistrations(1001)).toHaveLength(1);
    expect(JSON.stringify(row)).not.toContain("sessionToken");
    expect(JSON.stringify(row)).not.toContain("password");
    expect(listManagedBrowserRegistrations(91000)).toHaveLength(0);
  });
  test("rejects forged body, stale target and conflicting generations", async () => {
    for (const override of [
      { profileId: "../Default" }, { generation: "../../other" },
      { port: 80 }, { targetId: "invalid/tab" }, { sessionToken: "forbidden" },
    ]) {
      expect(() => validateManagedBrowserRegistration({ ...pair, ...override })).toThrow();
    }
    const discover = async () => [{ targetId: "TARGET123", title: "", url: "" }];
    await expect(registerManagedBrowser({ ...pair, targetId: "MISSING" }, discover, 1000)).rejects.toThrow();
    await registerManagedBrowser(pair, discover, 1000);
    await expect(registerManagedBrowser({ ...pair, generation: "3211-1792926500000000000" }, discover, 2000)).rejects.toThrow("conflict");
    expect(listManagedBrowserRegistrations(2000)).toHaveLength(1);
  });
});
