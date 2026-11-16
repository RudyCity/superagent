/**
 * R1 Windows process-birth attestation. A recorded PID may be reused by the OS;
 * only a matching kernel process creation timestamp and authenticated owner
 * nonce together qualify for managed staging shutdown.
 *
 * This function never sends signals or spawns/starts target services.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export type ProcessBirthVerdict = "matched" | "mismatch" | "unverified";

function resolveWindowsPowerShell(): string {
  const sysRoot = process.env.SystemRoot || process.env.windir || "C:\\Windows";
  const candidates = [
    path.win32.join(sysRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    path.win32.join(sysRoot, "System32", "powershell.exe"),
    path.win32.join(sysRoot, "SysWOW64", "WindowsPowerShell", "v1.0", "powershell.exe"),
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {}
  }
  return "powershell.exe";
}

export function compareProcessBirth(
  recordedOwnerStartedAt: number,
  kernelCreatedAt: number | null,
): ProcessBirthVerdict {
  if (!Number.isSafeInteger(recordedOwnerStartedAt) || recordedOwnerStartedAt <= 0 ||
      kernelCreatedAt === null || !Number.isSafeInteger(kernelCreatedAt) ||
      kernelCreatedAt <= 0) return "unverified";
  // The lease is created *by* the running owner after the process was born.
  // A short startup/import gap is acceptable; future or stale birth is not.
  // Allow a small clock skew (up to 5s) for Windows kernel timer jitter vs user-space Date.now().
  const startupGap = recordedOwnerStartedAt - kernelCreatedAt;
  return startupGap >= -5_000 && startupGap <= 30_000 ? "matched" : "mismatch";
}

export function verifyWindowsProcessBirth(
  pid: number,
  recordedOwnerStartedAt: number,
): ProcessBirthVerdict {
  if (process.platform !== "win32" || !Number.isSafeInteger(pid) || pid <= 0)
    return "unverified";
  try {
    const psBin = resolveWindowsPowerShell();
    const sysRoot = process.env.SystemRoot || process.env.windir || "C:\\Windows";
    const system32 = path.win32.join(sysRoot, "System32");
    const sysPowerShell = path.win32.join(system32, "WindowsPowerShell", "v1.0");
    const pathVar = process.env.PATH || process.env.Path || "";
    const augmentedPath = `${system32};${sysPowerShell};${pathVar}`;
    const execEnv = { ...process.env, PATH: augmentedPath, Path: augmentedPath };

    const cmd = "$p=Get-Process -Id " + pid +
      " -ErrorAction Stop; ([DateTimeOffset]$p.StartTime).ToUnixTimeMilliseconds()";
    const output = execFileSync(psBin, [
      "-NoProfile", "-NonInteractive", "-Command", cmd,
    ], {encoding:"utf8",timeout:4000,maxBuffer:1024,windowsHide:true,env:execEnv}).trim();
    if (!/^\d{13}$/.test(output)) return "unverified";
    return compareProcessBirth(recordedOwnerStartedAt, Number(output));
  } catch {
    return "unverified";
  }
}
