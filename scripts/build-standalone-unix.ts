#!/usr/bin/env bun
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dir, "..");
// Always package the main Tray, not the separate LAN Windows GUI.
const trayRoot = path.join(root, "apps", "superagent-tray");
if (process.platform !== "darwin" && process.platform !== "linux") {
  throw new Error("Unix package requires macOS or Linux");
}
const bundles = process.platform === "darwin" ? "dmg" : "deb,appimage";
// Linux-only DEB channel to bypass linuxdeploy/AppImage failures without changing the normal multi-OS contract.
const override = process.env.SUPERAGENT_UNIX_BUNDLE_OVERRIDE;
if (override && !(process.platform === "linux" && override === "deb")) {
  throw new Error("Only the Linux DEB override is supported");
}
const p = spawnSync(process.execPath, [
  "x", "@tauri-apps/cli@2.12.4", "build",
  "--config", "src-tauri/tauri.conf.json",
  "--config", "src-tauri/tauri.standalone.unix.conf.json",
  "--ci", "--bundles", override || bundles,
], {
  cwd: trayRoot,
  env: { ...process.env, CI: "true" },
  stdio: "inherit",
  timeout: 1_200_000,
});
if (p.error || p.status !== 0) {
  console.error("Tauri package failed:", p.error ?? p.status);
  process.exit(1);
}
