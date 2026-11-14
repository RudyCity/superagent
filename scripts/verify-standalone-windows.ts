#!/usr/bin/env bun
/**
 * Integrity gate shared by Windows standalone preparation, verification and
 * extracted NSIS audits. Importing this module never installs or launches.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { verifyWindowsWgcArtifactPair } from "../src/core/desktopUi/adapters/windowsWgcArtifact.js";

export const WINDOWS_UIA_RELATIVE_DIR = path.join("native", "desktop-live-windows-input");
export const WINDOWS_UIA_SOURCE_RELATIVE = path.join(WINDOWS_UIA_RELATIVE_DIR, "windowsRemoteSemantic.cpp");

export interface WindowsNativeBuildContext {
  readonly commitSha: string;
  readonly workflowRunId: string;
}

function check(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error("[standalone-verify] " + message);
}

function regularFile(file: string): fs.Stats {
  const stat = fs.lstatSync(file);
  check(stat.isFile() && !stat.isSymbolicLink(), "Native UIA artifact is not a regular file: " + file);
  return stat;
}

function digest(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** A digest receipt alone cannot establish CI provenance. Both are mandatory. */
export function verifyWindowsRemoteNativePackaging(
  directory: string, sourcePath: string, context: WindowsNativeBuildContext,
): string {
  check(/^[a-f0-9]{40}$/.test(context.commitSha), "Expected exact 40-character commit SHA");
  check(/^[0-9]+$/.test(context.workflowRunId), "Expected GitHub Actions run ID");
  const folder = fs.lstatSync(directory);
  check(folder.isDirectory() && !folder.isSymbolicLink(), "Native UIA directory must be real");
  const dllPath = path.join(directory, "winremote.dll");
  const receiptPath = path.join(directory, "winremote.sha256");
  const provenancePath = path.join(directory, "winremote.provenance.json");
  const stat = regularFile(dllPath);
  const receiptStat = regularFile(receiptPath);
  const provenanceStat = regularFile(provenancePath);
  check(stat.size >= 8_192 && stat.size <= 4 * 1024 * 1024, "UIA DLL size out of range");
  check(receiptStat.size >= 64 && receiptStat.size <= 66, "UIA SHA-256 receipt length invalid");
  check(provenanceStat.size > 60 && provenanceStat.size <= 2048, "UIA provenance size invalid");
  const bytes = fs.readFileSync(dllPath);
  const peOffset = bytes.length >= 0x40 ? bytes.readUInt32LE(0x3c) : 0;
  check(bytes.toString("ascii", 0, 2) === "MZ" &&
    peOffset >= 0x40 && peOffset + 26 <= bytes.length &&
    bytes.toString("ascii", peOffset, peOffset + 4) === "PE\u0000\u0000" &&
    bytes.readUInt16LE(peOffset + 4) === 0x8664 && // AMD64
    bytes.readUInt16LE(peOffset + 6) >= 1 && bytes.readUInt16LE(peOffset + 6) <= 96 &&
    (bytes.readUInt16LE(peOffset + 22) & 0x2000) !== 0 && // IMAGE_FILE_DLL
    bytes.readUInt16LE(peOffset + 24) === 0x20b, // PE32+
    "UIA payload is not a Windows PE x64 DLL");
  const hash = digest(bytes);
  check(fs.readFileSync(receiptPath, "ascii").match(/^[a-f0-9]{64}\r?\n?$/) !== null,
    "UIA SHA-256 receipt syntax invalid");
  check(fs.readFileSync(receiptPath, "ascii").trim() === hash,
    "UIA checksum mismatch");
  const sourceStat = regularFile(sourcePath);
  check(sourceStat.size > 1000 && sourceStat.size < 1024 * 1024,
    "UIA source missing or invalid");
  let raw: unknown;
  try { raw = JSON.parse(fs.readFileSync(provenancePath, "utf8")); }
  catch { throw new Error("[standalone-verify] Invalid native UIA provenance JSON"); }
  check(raw !== null && typeof raw === "object" && !Array.isArray(raw),
    "Invalid native UIA provenance record");
  const record = raw as Record<string, unknown>;
  const keys = ["schemaVersion", "binary", "source", "sourceSha256", "dllSha256",
    "commitSha", "workflowRunId", "runnerOS", "runnerEnvironment"];
  check(Object.keys(record).sort().join(",") === [...keys].sort().join(","),
    "Unexpected native UIA provenance fields");
  check(record.schemaVersion === 1 && record.binary === "winremote.dll" &&
    record.source === "native/desktop-live-windows-input/windowsRemoteSemantic.cpp" &&
    record.sourceSha256 === digest(fs.readFileSync(sourcePath)) &&
    record.dllSha256 === hash &&
    record.commitSha === context.commitSha &&
    record.workflowRunId === context.workflowRunId &&
    record.runnerOS === "Windows" && record.runnerEnvironment === "github-hosted",
    "UIA native provenance does not match trusted source, SHA-256 or CI identity");
  return hash;
}

/** Never accept local build output as trusted standalone-installer input. */
export function windowsNativeCiContext(env: NodeJS.ProcessEnv = process.env): WindowsNativeBuildContext {
  check(process.platform === "win32" && process.arch === "x64", "Requires Windows x64");
  check(env.GITHUB_ACTIONS === "true" && env.RUNNER_OS === "Windows" &&
    env.RUNNER_ENVIRONMENT === "github-hosted", "Only a trusted hosted Windows Actions runner may package native UIA");
  const context = { commitSha: env.GITHUB_SHA ?? "", workflowRunId: env.GITHUB_RUN_ID ?? "" };
  check(/^[a-f0-9]{40}$/.test(context.commitSha) &&
    /^[0-9]+$/.test(context.workflowRunId), "Missing trusted GitHub workflow identity");
  return context;
}

/** CLI verification is isolated from imports used by preparation and unit tests. */
if (import.meta.main) {
  const root = path.resolve(import.meta.dir, "..");
  const tauri = path.join(root, "apps", "superagent-tray", "src-tauri");
  const stage = path.join(tauri, "resources", "standalone");
  const bins = path.join(tauri, "binaries");
  const triple = "x86_64-pc-windows-msvc";
  const portableBun = path.join(bins, `bun-${triple}.exe`);
  const portableCli = path.join(bins, `superagent-${triple}.exe`);
  const context = windowsNativeCiContext();
  for (const item of [portableBun, portableCli, path.join(stage, "node_modules", "ink"),
    path.join(stage, "node_modules", "sharp"), path.join(stage, "node_modules", "r-memory"),
    path.join(stage, "node_modules", "typescript"),
    path.join(stage, "dist", "cli.js"), path.join(stage, "standalone-manifest.json")]) {
    check(fs.existsSync(item), "Missing bundle input: " + item);
  }
  const bundledWgcDir = path.join(stage, "dist", "native", "desktop-live-wgc");
  check(verifyWindowsWgcArtifactPair(path.join(bundledWgcDir, "wgc.exe"),
    path.join(bundledWgcDir, "wgc.sha256")) !== null,
    "Portable Core must include checksum-verified Windows Graphics Capture helper.");
  const uiaSource = path.join(root, WINDOWS_UIA_SOURCE_RELATIVE);
  const sourceHash = verifyWindowsRemoteNativePackaging(
    path.join(root, "dist", WINDOWS_UIA_RELATIVE_DIR), uiaSource, context);
  const stagedHash = verifyWindowsRemoteNativePackaging(
    path.join(stage, WINDOWS_UIA_RELATIVE_DIR), uiaSource, context);
  check(sourceHash === stagedHash, "Staged UIA helper differs from built native input");
  check(!fs.existsSync(path.join(stage, "dist", WINDOWS_UIA_RELATIVE_DIR)),
    "Unexpected alternate staged native UIA build-output directory");
  check(fs.readdirSync(path.join(stage, WINDOWS_UIA_RELATIVE_DIR)).sort().join(",") ===
    ["winremote.dll", "winremote.provenance.json", "winremote.sha256"].sort().join(","),
    "Native UIA staging includes unapproved compiler or auxiliary files");
  const app = JSON.parse(fs.readFileSync(path.join(stage, "standalone-manifest.json"), "utf8"));
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  check(app.version === pkg.version && app.bunVersion === "1.4.2", "Runtime version manifest mismatch");
  check(app.optionalWindowsRemoteSemanticInput?.installedRelativeDirectory ===
    "standalone/native/desktop-live-windows-input" &&
    app.optionalWindowsRemoteSemanticInput?.sha256 === stagedHash &&
    app.optionalWindowsRemoteSemanticInput?.activated === false,
    "Native UIA helper must remain explicitly inactive by default");
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
    // Tauri NSIS resource mapping: $INSTDIR/standalone, not $INSTDIR/resources/standalone.
    fs.symlinkSync(stage, path.join(smoke, "standalone"), "junction");
    const output = command(path.join(smoke, "superagent.exe"), ["--version"], smoke);
    check(output.includes(pkg.version), "Portable CLI did not report release version " + pkg.version + ": " + output.slice(0, 300));
    console.log("[standalone-verify] Isolated CLI --version PASS: " + pkg.version);
    const helpOutput = command(path.join(smoke, "superagent.exe"), ["--help"], smoke);
    check(helpOutput.includes("--server"), "Portable CLI --help failed: " + helpOutput.slice(0, 300));
    console.log("[standalone-verify] Isolated CLI --help PASS");
    console.log("[standalone-verify] Verified opt-in UIA DLL, SHA-256, provenance and installed path");
  } finally {
    fs.rmSync(smoke, { recursive: true, force: true });
  }
}
