/**
 * Copy the reviewed native SuperAgent Tray executable into a stable per-user
 * path so global SuperAgent CLI installations can auto-start the same tray.
 *
 * This is an explicit operator install step; it never starts the executable
 * and does not register Windows startup tasks/services.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const root = path.resolve(import.meta.dir, "..");
const configRoot = process.env.SUPERAGENT_CONFIG_DIR?.trim()
  ? path.resolve(process.env.SUPERAGENT_CONFIG_DIR)
  : path.join(os.homedir(), ".superagent-r");
const binDir = path.join(configRoot, "bin");
const sourcePaths = [
  path.join(root, "apps", "superagent-tray", "src-tauri", "target", "release", "superagent-tray.exe"),
  path.join(root, "apps", "superagent-tray", "src-tauri", "target", "debug", "superagent-tray.exe"),
];

if (process.platform !== "win32") {
  console.error("SuperAgent Tray installation currently supports Windows executables.");
  process.exit(2);
}
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
  console.error("No locally built Tray executable found. For ordinary Windows PCs without Rust/MSVC, run: bun run tray:prebuilt:check");
  console.error("Then use the verified prebuilt installer via: bun run tray:prebuilt:install (see README for version compatibility).");
  console.error("Developers who need a custom build can use: bun run tray:build");
  process.exit(1);
}

const destination = path.join(binDir, "superagent-tray.exe");
const binary = fs.readFileSync(source);
if (binary.subarray(0, 2).toString("ascii") !== "MZ") {
  throw new Error("Refusing to install a file without the expected Windows PE header");
}
const hash = crypto.createHash("sha256").update(binary).digest("hex");
fs.mkdirSync(binDir, { recursive: true });
const temporary = destination + "." + process.pid + ".tmp";
try {
  fs.writeFileSync(temporary, binary, { flag: "wx" });
  // An existing running executable may be locked on Windows. Do NOT delete
  // or kill it: ask the user to quit Tray before replacing the binary.
  fs.renameSync(temporary, destination);
} finally {
  try { fs.rmSync(temporary, { force: true }); } catch {}
}
console.log("[SuperAgent Tray] Installed to " + destination);
console.log("[SuperAgent Tray] SHA-256: " + hash);
console.log("SuperAgent CLI/server will launch this per-user tray automatically on their next startup.");
