/**
 * Windows logon startup provisioning for Core Boot. DEFAULT IS PREVIEW.
 *
 * bun scripts/setup-core-windows-startup.ts --port 7888
 * bun scripts/setup-core-windows-startup.ts --port 7888 --apply
 *
 * --apply modifies the current user's Windows Task Scheduler, never starts
 * the task immediately. It will not overwrite an existing task or launcher.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createCoreWindowsStartupPlan } from "../src/core/runtime/coreWindowsStartup.js";

const args = process.argv.slice(2);
const index = args.indexOf("--port");
const port = index < 0 ? 7888 : Number(args[index + 1]);
const modeIndex = args.indexOf("--client-mode");
const clientMode = modeIndex < 0 ? "tline" : args[modeIndex + 1];
const apply = args.includes("--apply");
for (const value of args) {
  if (!["--port", "--client-mode", "--apply", "7888", String(port), clientMode].includes(value)) {
    throw new Error("Unknown option: " + value);
  }
}
if (clientMode !== "tline" && clientMode !== "chrome-extension") {
  throw new Error("Invalid client mode");
}
const bunExecutable = process.execPath;
const cliFile = path.resolve(import.meta.dir, "..", "dist", "cli.js");
if (!fs.existsSync(cliFile)) throw new Error("Run bun run build first; compiled Core CLI unavailable");
const userHome = process.env.USERPROFILE || os.homedir();
const root = path.join(userHome, ".superagent-r", "windows-startup");
const launcherFile = path.join(root, "core-boot-" + port + ".ps1");
const plan = createCoreWindowsStartupPlan({
  port, clientMode, bunExecutable, cliFile, launcherFile,
});
console.log(JSON.stringify({
  type: "core-windows-logon-startup",
  mode: apply ? "APPLY" : "PREVIEW_ONLY",
  taskName: plan.taskName, trigger: "current user logon",
  launcherFile: plan.launcherFile, cliFile, bunExecutable,
  registerCommand: plan.registerCommand,
  inspectCommand: plan.inspectCommand,
  removeCommand: plan.removeCommand,
  note: "No existing processes/tunnels touched. Existing Core checkpoint may require manual recovery. This is not a Windows Service.",
}, null, 2));
if (!apply) process.exit(0);
if (process.platform !== "win32") throw new Error("Cannot install Windows task on non-Windows");
const stat = fs.existsSync(root) ? fs.lstatSync(root) : null;
if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error("Unsafe startup plan directory");
fs.mkdirSync(root, { recursive: true, mode: 0o700 });
if (fs.existsSync(launcherFile)) throw new Error("Startup launcher already exists; no overwrite. Inspect before manual removal.");
const handle = fs.openSync(launcherFile, "wx", 0o600);
try {
  fs.writeFileSync(handle, plan.launcherContent);
  fs.fsyncSync(handle);
} finally { fs.closeSync(handle); }
const encoded = Buffer.from(plan.registerCommand, "utf16le").toString("base64");
const proc = spawnSync("powershell.exe", [
  "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded,
], { encoding: "utf8", timeout: 20_000, windowsHide: true, maxBuffer: 12_000 });
if (proc.status !== 0) {
  throw new Error("Task registration failed without starting Core. " +
    "Launcher retained for inspection. " + (proc.stderr || "").slice(0, 400));
}
console.log("Windows per-user logon task registered (not started). Verify with: " + plan.inspectCommand);
