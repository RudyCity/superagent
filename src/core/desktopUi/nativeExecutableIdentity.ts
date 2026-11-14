/**
 * Resolve OS-owned executable identity for the exact process PID.
 * Only the OS process table/path and disk bytes are used. MCP callers do not
 * provide or influence executable paths or hashes. Fail closed if unverifiable.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRestrictedProcessRunner, type DesktopProcessRunner } from "./processRunner.js";
import { resolveWindowsDesktopExecutable } from "./windowsExecutableIdentity.js";
import type { ExecutableIdentity } from "./persistentAccessPolicy.js";

const PS = "/bin/ps";
const PID_LIMIT = 0xffffffff;
const DIGEST = /^[a-f0-9]{64}$/;
const supported = (p: NodeJS.Platform): p is "win32" | "darwin" | "linux" =>
  p === "win32" || p === "darwin" || p === "linux";

/** Never accept symlinked canonical app binary paths as arbitrary aliases. */
function hashExecutable(file: string): string | null {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size <= 0 || stat.size > 2 * 1024 * 1024 * 1024) return null;
    const data = fs.readFileSync(file);
    return crypto.createHash("sha256").update(data).digest("hex");
  } catch { return null; }
}
function linuxStartTime(pid: number): string | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    // comm may contain spaces/parentheses; parse after LAST ')'.
    const at = stat.lastIndexOf(")");
    if (at < 0) return null;
    const fields = stat.slice(at + 2).trim().split(/\s+/);
    // fields[0] is state (field 3); starttime is field 22.
    return fields[19] || null;
  } catch { return null; }
}
export function resolveLinuxExecutable(pid: number): ExecutableIdentity | null {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > PID_LIMIT) return null;
  try {
    const start = linuxStartTime(pid);
    if (!start) return null;
    const procExe = `/proc/${pid}/exe`;
    const osPath = fs.readlinkSync(procExe);
    if (!path.posix.isAbsolute(osPath) || osPath.includes(" (deleted)")) return null;
    const canonical = fs.realpathSync.native(osPath);
    if (!path.posix.isAbsolute(canonical) || canonical.includes("\0")) return null;
    const hash = hashExecutable(procExe);
    if (!hash || !DIGEST.test(hash)) return null;
    if (linuxStartTime(pid) !== start ||
        fs.realpathSync.native(procExe) !== canonical) return null;
    return { platform:"linux", executablePath:canonical, sha256:hash };
  } catch { return null; }
}
const cleanMacPath = (value: string): string | null => {
  const v = value.trim();
  if (v.length < 2 || v.length > 2048 || !v.startsWith("/") ||
      /[\u0000-\u001f\u007f]/.test(v) || v.includes("\\")) return null;
  return v;
};
const macCommand = (pid: number, field: "comm" | "lstart") => [
  "-p", String(pid), "-o", `${field}=`,
];

/**
 * macOS ps comm returns an executable path on supported Darwin versions.
 * Reject non-absolute names, inconsistent birth data or changed path.
 */
export async function resolveMacExecutable(
  pid: number,
  runner: DesktopProcessRunner = createRestrictedProcessRunner([PS]),
): Promise<ExecutableIdentity | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > PID_LIMIT) return null;
  try {
    const run = async(field: "comm" | "lstart") =>
      (await runner.run({ executable:PS, args:macCommand(pid,field),timeoutMs:4000 })).stdout.trim();
    const birth = await run("lstart");
    const reported = cleanMacPath(await run("comm"));
    if (!birth || !reported) return null;
    const canonical = fs.realpathSync.native(reported);
    if (!canonical.startsWith("/")) return null;
    const hash = hashExecutable(canonical);
    if (!hash || !DIGEST.test(hash)) return null;
    const afterPath = cleanMacPath(await run("comm"));
    if (afterPath !== reported || await run("lstart") !== birth) return null;
    return { platform:"darwin", executablePath:canonical, sha256:hash };
  } catch { return null; }
}
export async function resolveNativeDesktopExecutable(
  pid:number,
  options: { platform?:NodeJS.Platform; runner?:DesktopProcessRunner } = {},
): Promise<ExecutableIdentity | null> {
  const platform = options.platform ?? process.platform;
  if (!supported(platform)) return null;
  if (platform === "win32") return resolveWindowsDesktopExecutable(pid, options.runner);
  if (platform === "linux") return resolveLinuxExecutable(pid);
  return resolveMacExecutable(pid, options.runner);
}
