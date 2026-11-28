#!/usr/bin/env bun
/** Prepare the Windows-only self-contained Tauri distribution before bundling.
 * Ships pinned Bun + Core + the complete production dependency tree.
 * Never modifies the developer's global Bun or installation.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { verifyWindowsWgcArtifactPair } from "../src/core/desktopUi/adapters/windowsWgcArtifact.js";
import { attestWindowsStandaloneCoreBuild } from "../src/core/runtime/coreBuildIdentity.js";
import { stageVisionStandaloneAsset } from "./vision-standalone-asset.js";
import {
  WINDOWS_UIA_RELATIVE_DIR, WINDOWS_UIA_SOURCE_RELATIVE,
  verifyWindowsDesktopHostPackaging, verifyWindowsRemoteNativePackaging, windowsNativeCiContext,
} from "./verify-standalone-windows.js";

const root = path.resolve(import.meta.dir, "..");
const tauri = path.join(root, "apps", "superagent-tray", "src-tauri");
const stage = path.join(tauri, "resources", "standalone");
const sidecars = path.join(tauri, "binaries");
const triple = "x86_64-pc-windows-msvc";
const pinnedBun = "1.4.2";
const sourceCli = path.join(root, "dist", "cli.js");
const sourceLauncher = path.join(tauri, "target", "release", "superagent.exe");
const marker = ".superagent-generated-standalone";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error("[standalone] " + message);
}
function copy(source: string, destination: string): void {
  assert(fs.existsSync(source), "Required path does not exist: " + source);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, { recursive: true, force: true });
}
assert(process.platform === "win32" && process.arch === "x64", "Windows x64 required; other platforms retain normal Tray build.");
const nativeContext = windowsNativeCiContext();
assert(Bun.version === pinnedBun, `Expected Bun ${pinnedBun}; actual ${Bun.version}. Use oven-sh/setup-bun@v2 pinned for CI.`);
assert(fs.existsSync(sourceCli), "Build Core first: bun run build");
assert(fs.existsSync(sourceLauncher), "Build launcher first: cargo build --release --bin superagent --manifest-path apps/superagent-tray/src-tauri/Cargo.toml");
const wgcRelative = path.join("native", "desktop-live-wgc");
const wgcInput = path.join(root, "dist", wgcRelative);
assert(verifyWindowsWgcArtifactPair(path.join(wgcInput, "wgc.exe"),
  path.join(wgcInput, "wgc.sha256")) !== null,
  "Missing verified WGC helper; run scripts/build-desktop-live-wgc.ps1 before installer preparation.");

// The native Desktop UI host is one fixed, checksum-pinned pair. It is built
// offline from native/desktop-host/*.cs into dist/native/desktop-host and must
// reach the standalone stage at the exact path resolved by
// desktopHostArtifact.ts (<stage>/dist/native/desktop-host). Rebuild it only
// through the offline PowerShell toolchain when the build output is missing or
// older than its sources; never accept a caller-supplied executable or digest.
const desktopHostSourceDir = path.join(root, "native", "desktop-host");
const desktopHostBuildDir = path.join(root, "dist", "native", "desktop-host");
assert(fs.existsSync(desktopHostSourceDir), "Missing Desktop UI host sources: " + desktopHostSourceDir);
function newestDesktopHostSourceMtime(): number {
  let newest = 0;
  for (const name of fs.readdirSync(desktopHostSourceDir)) {
    if (!name.endsWith(".cs")) continue;
    const source = path.join(desktopHostSourceDir, name);
    const info = fs.lstatSync(source);
    assert(info.isFile() && !info.isSymbolicLink(), "Desktop UI host source must be a regular file: " + source);
    newest = Math.max(newest, info.mtimeMs);
  }
  assert(newest > 0, "Desktop UI host source set is empty: " + desktopHostSourceDir);
  return newest;
}
function ensureDesktopHostBuilt(): void {
  const exe = path.join(desktopHostBuildDir, "desktop-host.exe");
  const digest = path.join(desktopHostBuildDir, "desktop-host.sha256");
  const exeInfo = fs.existsSync(exe) ? fs.lstatSync(exe) : null;
  const digestInfo = fs.existsSync(digest) ? fs.lstatSync(digest) : null;
  if (exeInfo?.isFile() && digestInfo?.isFile() && exeInfo.mtimeMs >= newestDesktopHostSourceMtime()) return;
  const buildScript = path.join(root, "scripts", "build-desktop-host.ps1");
  assert(fs.existsSync(buildScript), "Missing Desktop UI host builder: " + buildScript);
  console.log("[standalone] Building the native Desktop UI host from source (offline .NET Framework compiler)...");
  const build = spawnSync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", buildScript,
  ], { cwd: root, stdio: "inherit", timeout: 120_000, windowsHide: true });
  assert(!build.error && build.status === 0,
    `Desktop UI host build failed (code ${build.status}, error ${build.error ?? "none"}).`);
}
ensureDesktopHostBuilt();
const desktopHostHash = verifyWindowsDesktopHostPackaging(root);
console.log("[standalone] Verified native Desktop UI host: " + desktopHostHash);

// The checkout-local native/*.obj, *.dll, *.lib, *.exp and SHA are never inputs.
// Only the new, checksum-pinned build under dist is allowed, when stamped by
// this exact CI commit and run on a trusted hosted Windows x64 runner.
const uiaSource = path.join(root, WINDOWS_UIA_SOURCE_RELATIVE);
const uiaBuildDir = path.join(root, "dist", WINDOWS_UIA_RELATIVE_DIR);
const uiaHash = verifyWindowsRemoteNativePackaging(uiaBuildDir, uiaSource, nativeContext);

const launcher = fs.readFileSync(sourceLauncher);
assert(launcher[0] === 0x4d && launcher[1] === 0x5a, "Launcher is not a Windows PE executable.");
const existing = fs.existsSync(stage);
if (existing) assert(fs.existsSync(path.join(stage, marker)), "Refusing to replace an unrecognized staging directory.");
if (existing) fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
fs.writeFileSync(path.join(stage, marker), "Generated by scripts/prepare-standalone-windows.ts\n");
copy(path.join(root, "package.json"), path.join(stage, "package.json"));
if (fs.existsSync(path.join(root, "tsconfig.json"))) copy(path.join(root, "tsconfig.json"), path.join(stage, "tsconfig.json"));
copy(path.join(root, "bun.lock"), path.join(stage, "bun.lock"));
copy(path.join(root, "patches"), path.join(stage, "patches"));
copy(path.join(root, "dist"), path.join(stage, "dist"));

// The fixed loader's module location in the installer is
// <install>/standalone/dist/core/desktopUi/adapters/... and ../../../../native
// resolves to <install>/standalone/native/desktop-live-windows-input.
// Remove the dist-native intermediate copy only in disposable staging.
fs.rmSync(path.join(stage, "dist", WINDOWS_UIA_RELATIVE_DIR), { recursive: true, force: true });
const uiaStage = path.join(stage, WINDOWS_UIA_RELATIVE_DIR);
for (const name of ["winremote.dll", "winremote.sha256", "winremote.provenance.json"]) {
  copy(path.join(uiaBuildDir, name), path.join(uiaStage, name));
}
assert(verifyWindowsRemoteNativePackaging(uiaStage, uiaSource, nativeContext) === uiaHash,
  "Native UIA staging must match fresh source-built Windows x64 DLL and CI receipt.");

const stagedWgc = path.join(stage, "dist", wgcRelative);
assert(verifyWindowsWgcArtifactPair(path.join(stagedWgc, "wgc.exe"),
  path.join(stagedWgc, "wgc.sha256")) !== null, "Verified WGC helper missing from standalone stage.");
const stagedDesktopHostHash = verifyWindowsDesktopHostPackaging(stage);
assert(stagedDesktopHostHash === desktopHostHash,
  "Staged native Desktop UI host must match the source-built fixed artifact pair.");
console.log("[standalone] Verified staged native Desktop UI host: " + stagedDesktopHostHash);
// Re-attest the exact trusted relocation, not a general rebuild or bypass.
// The source tree must have a valid pre-staging manifest; no other JS/JSON
// bytes (including package.json) may change during installer preparation.
const stageBuild = attestWindowsStandaloneCoreBuild(root, stage);
console.log("[standalone] Verified relocated Core digest: " + stageBuild.digest);
copy(path.join(root, "scripts", "media_backend.py"), path.join(stage, "scripts", "media_backend.py"));
copy(path.join(root, "scripts", "setup_media_backends.py"), path.join(stage, "scripts", "setup_media_backends.py"));
const visionScriptSha256 = stageVisionStandaloneAsset(root, stage);
const androidApkDir = path.join(root, "apps", "superagent-lan-android", "app", "build", "outputs", "apk", "debug");
if (fs.existsSync(path.join(androidApkDir, "app-debug.apk")) && fs.existsSync(path.join(androidApkDir, "output-metadata.json"))) {
  copy(androidApkDir, path.join(stage, "apps", "superagent-lan-android", "app", "build", "outputs", "apk", "debug"));
}
fs.mkdirSync(sidecars, { recursive: true });
const runtimeExe = path.join(sidecars, `bun-${triple}.exe`);
const coreExe = path.join(sidecars, `superagent-${triple}.exe`);
const runningBun = process.execPath;
const bunBytes = fs.readFileSync(runningBun);
assert(bunBytes[0] === 0x4d && bunBytes[1] === 0x5a, "Current Bun binary is not a Windows executable.");
copy(runningBun, runtimeExe);
copy(sourceLauncher, coreExe);
console.log("[standalone] Installing frozen production dependencies into isolated package...");
const install = spawnSync(runtimeExe, ["install", "--production", "--frozen-lockfile", "--no-progress"], {
  cwd: stage, env: { ...process.env, CI: "true" }, stdio: "inherit", timeout: 600_000,
  windowsHide: true,
});
assert(install.status === 0, `Production dependency install failed (code ${install.status}, signal ${install.signal}).`);
assert(fs.existsSync(path.join(stage, "node_modules", "ink")), "Production dependency ink missing.");
assert(fs.existsSync(path.join(stage, "node_modules", "sharp")), "Production dependency sharp missing.");
assert(fs.existsSync(path.join(stage, "node_modules", "r-memory")), "Production dependency r-memory missing.");
assert(fs.existsSync(path.join(stage, "node_modules", "typescript")), "Production dependency typescript missing.");
const stat = fs.statSync(runtimeExe);
assert(stat.size > 10_000_000, "Bundled Bun binary is unexpectedly small.");
const metadata = {
  package: "superagent", version: JSON.parse(fs.readFileSync(path.join(stage, "package.json"), "utf8")).version,
  platform: "win32", arch: "x64", bunVersion: pinnedBun, binary: "bun.exe",
  cli: "superagent.exe", entrypoint: "standalone/dist/cli.js",
  requiresGlobalBun: false, requiresGlobalNode: false,
  optionalVisionScript: { path: "standalone/scripts/vision_server.py", sha256: visionScriptSha256 },
  desktopUiHostArtifact: {
    installedRelativePath: "standalone/dist/native/desktop-host/desktop-host.exe",
    sha256: desktopHostHash,
  },
  optionalWindowsRemoteSemanticInput: {
    installedRelativeDirectory: "standalone/native/desktop-live-windows-input",
    sha256: uiaHash, activated: false,
  },
};
fs.writeFileSync(path.join(stage, "standalone-manifest.json"), JSON.stringify(metadata, null, 2) + "\n");
console.log("[standalone] Prepared " + stage);
console.log("[standalone] Runtime sidecar: " + runtimeExe);
console.log("[standalone] CLI sidecar: " + coreExe);
console.log("[standalone] Manifest: " + JSON.stringify(metadata));
console.log("[standalone] Optional UIA input helper staged but not activated: " + uiaHash);
