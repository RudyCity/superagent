import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_DESKTOP_UI_POLICY,
  DESKTOP_UI_POLICY_FILENAME,
  desktopUiRequiresDangerousExecution,
  isReadOnlyDesktopUiCall,
  readDesktopUiPolicy,
  resolveDesktopUiCommand,
} from "../../src/core/desktopUi/desktopUiPolicy.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sa-desktop-ui-policy-"));
}

function writePolicy(dir: string, value: unknown): void {
  fs.writeFileSync(path.join(dir, DESKTOP_UI_POLICY_FILENAME), JSON.stringify(value), "utf8");
}

describe("desktop UI operator policy", () => {
  it("defaults to requiring the dangerous path for discovery", () => {
    const dir = tempDir();
    const policy = readDesktopUiPolicy({ configDir: dir });
    expect(policy).toEqual(DEFAULT_DESKTOP_UI_POLICY);
    expect(policy.discoveryRequiresDangerousTool).toBe(true);
  });

  it("reads an explicit operator opt-in", () => {
    const dir = tempDir();
    writePolicy(dir, { version: 1, discoveryRequiresDangerousTool: false });
    expect(readDesktopUiPolicy({ configDir: dir }).discoveryRequiresDangerousTool).toBe(false);
  });

  it("fails closed for malformed, oversized, wrong-version or extra-field files", () => {
    const cases: unknown[] = [
      { version: 2, discoveryRequiresDangerousTool: false },
      { version: 1 },
      { version: 1, discoveryRequiresDangerousTool: "false" },
      { version: 1, discoveryRequiresDangerousTool: false, extra: true },
      [],
      "off",
    ];
    for (const value of cases) {
      const dir = tempDir();
      writePolicy(dir, value);
      expect(readDesktopUiPolicy({ configDir: dir }).discoveryRequiresDangerousTool).toBe(true);
    }
    const oversized = tempDir();
    fs.writeFileSync(path.join(oversized, DESKTOP_UI_POLICY_FILENAME), "x".repeat(5000));
    expect(readDesktopUiPolicy({ configDir: oversized }).discoveryRequiresDangerousTool).toBe(true);
    expect(readDesktopUiPolicy({ configDir: path.join(os.tmpdir(), "definitely-missing-dir-xyz") })
      .discoveryRequiresDangerousTool).toBe(true);
  });

  it("classifies read-only commands and action spellings", () => {
    for (const args of [
      { command: "probe" },
      { command: "list_windows" },
      { command: "find_window" },
      { command: "inspect_window" },
      { command: "snapshot" },
      { command: "wait_ready" },
      { action: "list_windows" },
    ]) {
      expect(isReadOnlyDesktopUiCall(args)).toBe(true);
    }
    for (const args of [
      { command: "open" },
      { command: "action" },
      { command: "close" },
      { command: "launch_app" },
      { command: "close_app" },
      { command: "restart_app" },
      { command: "plan_package_change" },
      { command: "apply_package_change" },
      { command: "live_stop" },
      { action: "click" },
      {},
      null,
    ]) {
      expect(isReadOnlyDesktopUiCall(args)).toBe(false);
    }
    expect(resolveDesktopUiCommand({ action: "scroll" })).toBe("action");
  });

  it("relaxes only read-only calls and only with the operator opt-in", () => {
    const strict = { version: 1 as const, discoveryRequiresDangerousTool: true };
    const relaxed = { version: 1 as const, discoveryRequiresDangerousTool: false };

    expect(desktopUiRequiresDangerousExecution({ command: "list_windows" }, strict)).toBe(true);
    expect(desktopUiRequiresDangerousExecution({ command: "list_windows" }, relaxed)).toBe(false);
    expect(desktopUiRequiresDangerousExecution({ command: "wait_ready" }, relaxed)).toBe(false);
    expect(desktopUiRequiresDangerousExecution({ command: "open" }, relaxed)).toBe(true);
    expect(desktopUiRequiresDangerousExecution({ command: "action", action: "click" }, relaxed)).toBe(true);
    expect(desktopUiRequiresDangerousExecution({ command: "launch_app" }, relaxed)).toBe(true);
  });
});
