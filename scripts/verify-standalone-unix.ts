#!/usr/bin/env bun
/** Portable Mac/Linux CLI test, with global Bun and Node removed from PATH. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { verifyMacSckArtifactPair } from "../src/core/desktopUi/adapters/macSckArtifact.js";
import { verifyLinuxX11ArtifactPair } from "../src/core/desktopUi/adapters/linuxX11Artifact.js";
import { verifyUnixDesktopLiveTree } from "./verify-desktop-live-unix-artifacts.js";
const root = path.resolve(import.meta.dir, "..");
const tauri = path.join(root, "apps/superagent-tray/src-tauri");
const triple = process.platform === "darwin" && process.arch === "arm64" ? "aarch64-apple-darwin" :
 process.platform === "linux" && process.arch === "x64" ? "x86_64-unknown-linux-gnu" : null;
function check(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error("[standalone-unix-verify] " + message);
}
check(triple !== null, "Platform must be macOS ARM64 or Linux x64");
const stage = path.join(tauri, "resources", "standalone");
const runtime = path.join(tauri, "binaries", "bun-" + triple);
const cli = path.join(tauri, "target", "release", "superagent");
const manifest = JSON.parse(fs.readFileSync(path.join(stage, "standalone-manifest.json"), "utf8"));
check(fs.existsSync(runtime) && fs.existsSync(cli) && fs.existsSync(path.join(stage, "node_modules", "ink")), "Stage incomplete");
check(manifest.target === triple && manifest.bunVersion === "1.4.2", "Staged manifest mismatch");
verifyUnixDesktopLiveTree(root, stage, process.platform as "darwin" | "linux");
if (process.platform === "linux") {
  const x11Dir = path.join(stage, "dist", "native", "desktop-live-x11");
  check(verifyLinuxX11ArtifactPair(path.join(x11Dir, "linuxCapture.py"), path.join(x11Dir, "linuxCapture.sha256")) !== null,
    "Linux exact-active-window worker missing from standalone bundle");
}
if (process.platform === "darwin") {
  const sckDir = path.join(stage, "dist", "native", "desktop-live-sck");
  check(verifyMacSckArtifactPair(path.join(sckDir, "sck"), path.join(sckDir, "sck.sha256")) !== null,
    "macOS ScreenCaptureKit helper must be included in the standalone bundle");
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sa-unix-smoke-"));
try {
  const execDir = process.platform === "darwin" ? path.join(dir, "SuperAgent.app/Contents/MacOS") : path.join(dir, "usr/bin");
  const resourceDir = process.platform === "darwin" ? path.join(dir, "SuperAgent.app/Contents/Resources") : path.join(dir, "usr/lib/superagent");
  fs.mkdirSync(execDir, { recursive: true }); fs.mkdirSync(resourceDir, { recursive: true });
  fs.copyFileSync(runtime, path.join(execDir, "bun"));
  fs.copyFileSync(cli, path.join(execDir, "superagent"));
  fs.chmodSync(path.join(execDir, "bun"), 0o755); fs.chmodSync(path.join(execDir, "superagent"), 0o755);
  fs.symlinkSync(stage, path.join(resourceDir, "standalone"), "dir");
  const env = { ...process.env, PATH: "/usr/bin:/bin", CI: "true" };
  for (const key of ["BUN_EXECUTABLE", "SUPERAGENT_EXECUTABLE", "SUPERAGENT_CLI_PATH", "NODE_PATH"]) delete env[key];
  const proc = spawnSync(path.join(execDir, "superagent"), ["--version"], {
    cwd: dir, env, encoding: "utf8", timeout: 60000, maxBuffer: 1024*1024,
  });
  check(!proc.error && proc.status === 0, "CLI failed: " + String(proc.error ?? proc.stderr ?? proc.status));
  check((proc.stdout + proc.stderr).includes(manifest.version), "Wrong version: " + (proc.stdout + proc.stderr).slice(0,256));
  console.log("[standalone-unix-verify] Portable CLI passed:", manifest.version, triple);
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
