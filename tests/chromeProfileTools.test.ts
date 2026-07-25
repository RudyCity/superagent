import { describe, test, expect } from "vitest";
import {
  getChromeUserDataPath,
  detectChromeProfiles,
  listChromeProfilesTool,
} from "../src/core/tools/chromeProfileTools.js";
import { launchChromeProfileTool } from "../src/core/tools/chromeBrowserTools.js";
import fs from "fs";
import path from "path";
import os from "os";

describe("chromeProfileTools", () => {
  test("getChromeUserDataPath returns valid OS path string", () => {
    const userDataPath = getChromeUserDataPath();
    expect(typeof userDataPath).toBe("string");
    expect(userDataPath.length).toBeGreaterThan(0);
  });

  test("detectChromeProfiles correctly parses Local State mock directory", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "chrome-test-"));
    const localStatePath = path.join(tmpDir, "Local State");

    const mockLocalState = {
      profile: {
        info_cache: {
          Default: { name: "Personal Profile", user_name: "user@gmail.com" },
          "Profile 1": { name: "Work Profile", user_name: "work@company.com" },
        },
      },
    };

    fs.writeFileSync(localStatePath, JSON.stringify(mockLocalState));

    const profiles = await detectChromeProfiles(tmpDir);
    expect(profiles).toHaveLength(2);
    expect(profiles[0].name).toBe("Personal Profile");
    expect(profiles[0].email).toBe("user@gmail.com");
    expect(profiles[1].name).toBe("Work Profile");
    expect(profiles[1].email).toBe("work@company.com");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("detectChromeProfiles falls back gracefully when Local State is missing", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "chrome-test-empty-"));
    const profiles = await detectChromeProfiles(tmpDir);
    expect(profiles).toHaveLength(0);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("detectChromeProfiles handles corrupted Local State JSON", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "chrome-test-corrupt-"));
    const localStatePath = path.join(tmpDir, "Local State");
    fs.writeFileSync(localStatePath, "INVALID_JSON_CONTENT");

    const profiles = await detectChromeProfiles(tmpDir);
    expect(profiles).toHaveLength(0);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("listChromeProfilesTool execute returns formatted markdown table", async () => {
    const result = await listChromeProfilesTool.execute({});
    expect(typeof result).toBe("string");
    expect(result).toContain("Chrome Profiles");
  });

  test("launchChromeProfileTool constructs valid launch command response", async () => {
    const res = await launchChromeProfileTool.execute({
      profileDirectory: "Default",
      url: "https://example.com",
    });
    expect(typeof res).toBe("string");
    expect(res).toContain("Default");
  });
});
