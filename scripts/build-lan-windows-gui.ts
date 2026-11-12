#!/usr/bin/env bun
/** Produce a self-contained Windows Tauri receiver installer. */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

if (process.platform !== "win32") throw Error("Native Windows Tauri build requires Windows.");
const root = path.resolve(import.meta.dir, "..");
const tauri = path.join(root, "apps", "superagent-lan-windows", "src-tauri");
const sidecar = path.join(tauri, "resources", "superagent-lan-client.exe");
const target = path.join(tauri, "target");
const installer = path.join(target, "release", "bundle", "nsis", "SuperAgent LAN Client_0.2.0_x64-setup.exe");
const outputDir = path.join(root, "artifacts", "lan-client");
const output = path.join(outputDir, "SuperAgent-LAN-Client-0.2.0-Windows-x64-setup.exe");

function run(args: string[], extra: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd: root, stdio: "inherit", timeout: 900_000,
    env: { ...process.env, CI: "false", ...extra },
  });
  if (result.error || result.status !== 0) {
    throw Error("Build command failed: " + (result.error?.message || String(result.status)));
  }
}

fs.mkdirSync(path.dirname(sidecar), { recursive: true });
run(["build", "--compile", "--target=bun-windows-x64", "src/lanClientGui.ts", "--outfile", sidecar]);
if (fs.statSync(sidecar).size < 100_000) throw Error("Receiver engine is invalid.");
run(["x", "@tauri-apps/cli", "build", "--config",
  path.relative(root, path.join(tauri, "tauri.conf.json"))], { CARGO_TARGET_DIR: target });
if (!fs.existsSync(installer) || fs.statSync(installer).size < 100_000) {
  throw Error("Windows Tauri installer missing or incomplete.");
}
fs.mkdirSync(outputDir, { recursive: true });
fs.copyFileSync(installer, output);
const hash = crypto.createHash("sha256").update(fs.readFileSync(output)).digest("hex");
console.log("SuperAgent LAN Windows installer: " + output);
console.log("SHA-256: " + hash);
