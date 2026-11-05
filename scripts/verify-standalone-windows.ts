#!/usr/bin/env bun
/** Fail closed if the Windows installer payload needs globally installed Bun/Node. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
const root = path.resolve(import.meta.dir, "..");
const tauri = path.join(root, "apps", "superagent-tray", "src-tauri");
const stage = path.join(tauri, "resources", "standalone");
const bins = path.join(tauri, "binaries");
const triple = "x86_64-pc-windows-msvc";
const portableBun = path.join(bins, `bun-${triple}.exe`);
const portableCli = path.join(bins, `superagent-${triple}.exe`);
function check(ok: unknown, text: string): asserts ok { if (!ok) throw new Error("[standalone-verify] " + text); }
check(process.platform === "win32", "Requires Windows.");
for (const item of [portableBun, portableCli, path.join(stage, "node_modules", "ink"),
  path.join(stage, "node_modules", "sharp"), path.join(stage, "node_modules", "r-memory"),
  path.join(stage, "dist", "cli.js"), path.join(stage, "standalone-manifest.json")]) {
  check(fs.existsSync(item), "Missing bundle input: " + item);
}
const app = JSON.parse(fs.readFileSync(path.join(stage, "standalone-manifest.json"), "utf8"));
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
check(app.version === pkg.version && app.bunVersion === "1.4.2", "Runtime version manifest mismatch");
const portableEnv = { ...process.env };
for (const key of ["BUN_EXECUTABLE", "SUPERAGENT_CLI_PATH", "SUPERAGENT_EXECUTABLE", "NODE_PATH"]) delete portableEnv[key];
portableEnv.PATH = [process.env.SystemRoot ?? "C:\\Windows", "C:\\Windows\\System32"].join(path.delimiter);
portableEnv.CI = "true";
function command(exe: string, args: string[], cwd: string) {
  const run = spawnSync(exe, args, { cwd, env: portableEnv, encoding: "utf8",
    timeout: 50_000, windowsHide: true, maxBuffer: 1024 * 1024 * 2 });
  check(!run.error && run.status === 0, `Failed ${path.basename(exe)} ${args.join(" ")}: ${run.error ?? run.stderr ?? run.stdout ?? run.status}`);
  return [run.stdout ?? "", run.stderr ?? ""].join(" ");
}
check(command(portableBun, ["--version"], stage).includes("1.4.2"), "Bundled Bun reported the wrong version");
console.log("[standalone-verify] Portable Bun works without Bun/Node in PATH.");
const smoke = fs.mkdtempSync(path.join(os.tmpdir(), "superagent-portable-smoke-"));
try {
  fs.copyFileSync(portableBun, path.join(smoke, "bun.exe"));
  fs.copyFileSync(portableCli, path.join(smoke, "superagent.exe"));
  // Exact NSIS layout: $INSTDIR/standalone, not $INSTDIR/resources/standalone.
  fs.symlinkSync(stage, path.join(smoke, "standalone"), "junction");
  const output = command(path.join(smoke, "superagent.exe"), ["--version"], smoke);
  check(output.includes(pkg.version), "Portable CLI did not report release version " + pkg.version + ": " + output.slice(0, 300));
  console.log("[standalone-verify] Isolated CLI --version PASS: " + pkg.version);
} finally {
  fs.rmSync(smoke, { recursive: true, force: true });
}
