import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { dispatchTrayLanAction, parseTrayLanAction } from "../src/core/runtime/trayLanBridge.js";
import { getYoloModeState } from "../src/core/permissions.js";

const ui = path.resolve("apps/superagent-tray/ui");
const html = fs.readFileSync(path.join(ui, "index.html"), "utf8");
const js = fs.readFileSync(path.join(ui, "lan-devices.js"), "utf8");
const rust = fs.readFileSync(path.resolve("apps/superagent-tray/src-tauri/src/main.rs"), "utf8");

describe("LAN Client Tray request boundary", () => {
  it("enforces an exact action allowlist and disallows unrequested fields", () => {
    expect(parseTrayLanAction({ action: "list" })).toEqual({ action: "list", args: { action: "list" } });
    for (const input of [
      null, {}, [], { action: "shell" }, { action: "list", token: "abc" },
      { action: "open", host: "10.0.0.4" },
      { action: "exec", deviceId: "x", command: "echo X" },
      { action: "pair", host: "8.8.8.8", code: "12345678", fingerprint: "0".repeat(63) },
      { action: "pair", host: "10.0.0.4", code: "12345678", fingerprint: "f".repeat(64), extra: "token" },
      { action: "exec", deviceId: "a".repeat(36), command: "" },
      { action: "exec", deviceId: "a".repeat(36), command: "x".repeat(2001) },
    ]) expect(() => parseTrayLanAction(input)).toThrow();
  });

  it("accepts only defined pairing and bounded command shapes", () => {
    expect(parseTrayLanAction({
      action: "pair", host: "192.168.10.23", port: 17845, code: "00112233",
      fingerprint: "a".repeat(64), controller: "SuperAgent Tray",
    }).action).toBe("pair");
    expect(parseTrayLanAction({
      action: "exec", deviceId: "85d1e5ab-42d1-4ed0-b71f-74a3f16523fe",
      command: "Get-ComputerInfo",
    }).action).toBe("exec");
  });

  it("read-only list works independently; mutations fail closed in YOLO OFF", async () => {
    const response = await dispatchTrayLanAction({ action: "list" });
    expect(response).toMatchObject({ success: true, devices: expect.any(Array) });
    if (getYoloModeState() === "off") {
      await expect(dispatchTrayLanAction({ action: "open", deviceId: "85d1e5ab-42d1-4ed0-b71f-74a3f16523fe" }))
        .rejects.toThrow(/Full YOLO/);
    }
  });
});

describe("SuperAgent Tray LAN Devices wiring", () => {
  it("provides all action panels, native script and LAN-only verification", () => {
    for (const id of [
      "nav-lan-devices", "page-lan-devices", "actions-lan-devices", "lan-discovery-scan",
      "lan-discovered", "lan-pair-form", "lan-pair-ip", "lan-pair-port", "lan-pair-code",
      "lan-pair-fingerprint", "lan-verified", "lan-pair-submit", "lan-paired", "lan-paired-count",
      "lan-paired-refresh", "lan-command", "lan-command-run", "lan-output", "lan-output-clear",
    ]) expect(html).toContain('id="' + id + '"');
    expect(html).toContain('src="./lan-devices.js"');
    expect(html).toContain('href="./lan-devices.css"');
    expect(html).toContain('value="lan-devices"');
    expect(js).toContain('native("lan_support_action"');
    expect(js).toContain('"lan-verified").checked = false');
    expect(js).not.toMatch(/\bfetch\s*\(/);
    expect(js).not.toMatch(/\blocalStorage\b/);
  });
  it("native Tray has an allowlisted command and a context-menu shortcut", () => {
    expect(rust).toContain("async fn lan_support_action");
    expect(rust).toContain('"/api/desktop/lan-support"');
    expect(rust).toContain("lan_support_action,");
    expect(rust).toContain('MenuItem::with_id(app, "lan_devices"');
    expect(rust).toContain('"desktop-open-lan-devices"');
    expect(fs.readFileSync(path.resolve("src/serverRoutes.ts"),"utf8"))
      .toContain('pathname === "/api/desktop/lan-support"');
  });
});
