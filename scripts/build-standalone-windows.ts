#!/usr/bin/env bun
/** Windows packaging wrapper which normalizes GitHub/terminal CI env to a Tauri boolean. */
import path from "node:path";
import { spawnSync } from "node:child_process";
const root = path.resolve(import.meta.dir, "..");
// Force Tauri to resolve the primary Tray, not another app in apps/.
const trayRoot = path.join(root, "apps", "superagent-tray");
if (process.platform !== "win32") throw new Error("Use the normal tray build on non-Windows platforms");
const cli = process.execPath;
const run = spawnSync(cli, ["x", "@tauri-apps/cli@2.12.4", "build", "--config",
  "src-tauri/tauri.conf.json", "--config",
  "src-tauri/tauri.standalone.conf.json", "--ci",
  "--bundles", "nsis"], {
  cwd: trayRoot, stdio: "inherit", env: { ...process.env, CI: "true" },
  timeout: 1_200_000, windowsHide: false,
});
if (run.error || run.status !== 0) {
  console.error("Installer build failed:", run.error ?? `exit ${run.status}`);
  process.exit(1);
}
