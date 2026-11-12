#!/usr/bin/env bun
import path from "node:path";
import { spawnSync } from "node:child_process";
const root = path.resolve(import.meta.dir, "..");
// Always package the primary Tray, not the sibling LAN Windows GUI.
const trayRoot = path.join(root, "apps", "superagent-tray");
if (process.platform !== "darwin" && process.platform !== "linux") throw new Error("Unix package requires macOS or Linux");
const bundles = process.platform === "darwin" ? "dmg" : "deb,appimage";
const p = spawnSync(process.execPath, ["x","@tauri-apps/cli@2.12.4","build",
  "--config","src-tauri/tauri.conf.json",
  "--config","src-tauri/tauri.standalone.unix.conf.json",
  "--ci","--bundles",bundles], {
  cwd: trayRoot, env: {...process.env, CI:"true"}, stdio: "inherit", timeout: 1_200_000,
});
if (p.error || p.status !== 0) { console.error("Tauri package failed:",p.error ?? p.status); process.exit(1); }
