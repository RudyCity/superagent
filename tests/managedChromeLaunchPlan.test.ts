import { describe, expect, it } from "vitest";
import path from "node:path";
import os from "node:os";
import { planManagedChromeLaunch } from "../src/core/browserRuntime/managedChromeLaunchPlan.js";
import { launchChromeProfileTool } from "../src/core/tools/chromeBrowserTools.js";

const dir = (port: number) => path.join(os.tmpdir(), "test-superagent", "cdp-" + port);
const plan = (input: Parameters<typeof planManagedChromeLaunch>[0] = {}) =>
  planManagedChromeLaunch(input, dir);

describe("owner-initiated managed Chrome CDP launch preflight", () => {
  it("selects an isolated profile per port, loopback host and blank startup URL", () => {
    const defaultPort = plan();
    expect(defaultPort).toMatchObject({
      port: 9222, userDataDir: dir(9222), host: "127.0.0.1",
      profileName: "Default", url: "about:blank",
    });
    expect(plan({ port: 9333 }).userDataDir).toBe(dir(9333));
    expect(plan({ port: 9333 }).userDataDir).not.toBe(defaultPort.userDataDir);
  });

  it("rejects invalid ports, duplicate-profile policy and unsupported profile identifiers", () => {
    for (const port of [0, 80, 65536, -1, 1.5, NaN]) {
      expect(() => plan({port})).toThrow(/MANAGED_CDP_INVALID_PORT/);
    }
    expect(() => plan({ isolated: false })).toThrow(/ISOLATION_REQUIRED/);
    expect(() => plan({ profileName: "../Default" })).toThrow(/INVALID_PROFILE/);
    expect(() => plan({ profileName: "Profile 1", port: 9333 })).not.toThrow();
  });

  it("rejects file, Chrome-internal, javascript and credential-containing URLs", () => {
    for (const url of [
      "file:///C:/private.txt", "javascript:alert(1)", "chrome://settings",
      "https://user:secret@example.org", "not-a-url", "a".repeat(2049),
    ]) expect(() => plan({url})).toThrow(/MANAGED_CDP_INVALID_URL/);
    expect(plan({url:"https://tab.ub.ac.id/profil/"}).url)
      .toBe("https://tab.ub.ac.id/profil/");
    expect(plan({url:"about:blank"}).url).toBe("about:blank");
  });

  it("refuses the default personal Chrome user-data directory and relative paths", () => {
    const defaultChromeData = process.platform === "win32"
      ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
        "Google", "Chrome", "User Data")
      : process.platform === "darwin"
        ? path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome")
        : path.join(os.homedir(), ".config", "google-chrome");
    expect(() => plan({ userDataDir: defaultChromeData })).toThrow(/PROFILE_CONFLICT/);
    expect(() => plan({ userDataDir: "relative/unsafe" })).toThrow(/INVALID_PROFILE_DIR/);
  });

  it("invalid explicit launch settings fail before any Chrome spawn", async () => {
    const badPort = await launchChromeProfileTool.execute({ remoteDebuggingPort: 0 });
    expect(String(badPort)).toMatch(/MANAGED_CDP_INVALID_PORT/);
    const nonIsolated = await launchChromeProfileTool.execute({
      remoteDebuggingPort: 9222, isolated: false,
    });
    expect(String(nonIsolated)).toMatch(/MANAGED_CDP_ISOLATION_REQUIRED/);
    const explicitMode = await launchChromeProfileTool.execute({
      managedCdp: true, isolated: false, mode: "headed",
    });
    expect(String(explicitMode)).toMatch(/MANAGED_CDP_ISOLATION_REQUIRED/);
  });
});
