/**
 * Copy the reviewed native SuperAgent Tray executable into a stable per-user
 * path and stage/promote it to tray-release-state.json so global SuperAgent CLI
 * and background daemons immediately launch the latest Tray build.
 *
 * Usage:
 *   bun scripts/install-superagent-tray.ts           # install & promote existing build
 *   bun scripts/install-superagent-tray.ts --build   # build via cargo then install & promote
 *   bun scripts/install-superagent-tray.ts --auto    # install if build exists, silent skip if absent
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dir, "..");
const configRoot = process.env.SUPERAGENT_CONFIG_DIR?.trim()
  ? path.resolve(process.env.SUPERAGENT_CONFIG_DIR)
  : path.join(os.homedir(), ".superagent-r");
const binDir = path.join(configRoot, "bin");

const isAuto = process.argv.includes("--auto");
const shouldBuild = process.argv.includes("--build");

if (process.platform !== "win32") {
  if (isAuto) {
    // postbuild runs on every supported host. Tray auto-promotion is Windows-only,
    // so non-Windows builds must skip it without failing TypeScript/package CI.
    process.exit(0);
  }
  console.error("SuperAgent Tray installation currently supports Windows executables.");
  process.exit(2);
}

if (shouldBuild) {
  const cargoBin = path.join(os.homedir(), ".cargo", "bin");
  const env = { ...process.env };
  const currentPath = env.PATH || "";
  if (!currentPath.includes(cargoBin)) {
    env.PATH = `${cargoBin};${currentPath}`;
  }
  const cargoExe = fs.existsSync(path.join(cargoBin, "cargo.exe"))
    ? path.join(cargoBin, "cargo.exe")
    : "cargo";

  console.log("[SuperAgent Tray] Building native release binary with Cargo...");
  const manifest = path.join(root, "apps", "superagent-tray", "src-tauri", "Cargo.toml");
  const res = spawnSync(cargoExe, [
    "build", "--release", "--bin", "superagent-tray",
    "--manifest-path", manifest,
  ], { stdio: "inherit", env });

  if (res.status !== 0) {
    console.error("[SuperAgent Tray] Cargo build failed with exit code: " + (res.status ?? 1));
    process.exit(res.status ?? 1);
  }
}

const sourcePaths = [
  path.join(root, "apps", "superagent-tray", "src-tauri", "target", "release", "superagent-tray.exe"),
  path.join(root, "apps", "superagent-tray", "src-tauri", "target", "debug", "superagent-tray.exe"),
];

const explicitIndex = process.argv.indexOf("--from");
const explicitSource = explicitIndex < 0 ? undefined : process.argv[explicitIndex + 1];
if (explicitIndex >= 0 && (!explicitSource || !path.isAbsolute(explicitSource))) {
  console.error("--from requires an absolute path to a verified .exe file.");
  process.exit(2);
}

const source = (explicitSource ? [explicitSource] : sourcePaths).find(candidate => {
  try {
    const stat = fs.lstatSync(candidate);
    return stat.isFile() && !stat.isSymbolicLink() && stat.size > 100_000 &&
      path.extname(candidate).toLowerCase() === ".exe";
  } catch { return false; }
});

if (!source) {
  if (isAuto) {
    // In postbuild automation, if no compiled tray binary exists, exit cleanly
    process.exit(0);
  }
  console.error("No locally built Tray executable found. For ordinary Windows PCs without Rust/MSVC, run: bun run tray:prebuilt:check");
  console.error("Then use the verified prebuilt installer via: bun run tray:prebuilt:install (see README for version compatibility).");
  console.error("Developers who need a custom build can use: bun run tray:build or bun run tray:release");
  process.exit(1);
}

const destination = path.join(binDir, "superagent-tray.exe");
const binary = fs.readFileSync(source);
if (binary.subarray(0, 2).toString("ascii") !== "MZ") {
  throw new Error("Refusing to install a file without the expected Windows PE header");
}
const hash = crypto.createHash("sha256").update(binary).digest("hex");
fs.mkdirSync(binDir, { recursive: true });

// 1. Install to ~/.superagent-r/bin/superagent-tray.exe (or warn if process is locking the file)
const temporary = destination + "." + process.pid + ".tmp";
try {
  fs.writeFileSync(temporary, binary, { flag: "w" });
  fs.renameSync(temporary, destination);
  console.log("[SuperAgent Tray] Installed to " + destination);
} catch (err: any) {
  try { fs.rmSync(temporary, { force: true }); } catch {}
  console.warn("[SuperAgent Tray] Active binary is locked by a running process: " + destination);
}

// 2. Stage into immutable slot and promote activeDigest in tray-release-state.json
try {
  const { stageTrustedTrayRelease, promoteTrayRelease, readTrayReleaseState } =
    await import("../src/core/runtime/trayReleaseStore.js");
  const state = readTrayReleaseState(configRoot);
  stageTrustedTrayRelease(source, hash, configRoot);
  promoteTrayRelease(hash, state.revision, configRoot);
  console.log("[SuperAgent Tray] Promoted active global release: " + hash);
} catch (err: any) {
  console.warn("[SuperAgent Tray] Release state promotion notice: " + (err?.message || err));
}

console.log("[SuperAgent Tray] SHA-256: " + hash);
console.log("[SuperAgent Tray] Global update complete. CLI and background services will launch this build.");
