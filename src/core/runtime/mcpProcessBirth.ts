/**
 * R1 Windows process-birth attestation. A recorded PID may be reused by the OS;
 * only a matching kernel process creation timestamp and authenticated owner
 * nonce together qualify for managed staging shutdown.
 *
 * This function never sends signals or spawns/starts target services.
 */
import { execFileSync } from "node:child_process";

export type ProcessBirthVerdict = "matched" | "mismatch" | "unverified";

export function compareProcessBirth(
  recordedOwnerStartedAt: number,
  kernelCreatedAt: number | null,
): ProcessBirthVerdict {
  if (!Number.isSafeInteger(recordedOwnerStartedAt) || recordedOwnerStartedAt <= 0 ||
      kernelCreatedAt === null || !Number.isSafeInteger(kernelCreatedAt) ||
      kernelCreatedAt <= 0) return "unverified";
  // The lease is created *by* the running owner after the process was born.
  // A short startup/import gap is acceptable; future or stale birth is not.
  const startupGap = recordedOwnerStartedAt - kernelCreatedAt;
  return startupGap >= 0 && startupGap <= 30_000 ? "matched" : "mismatch";
}

export function verifyWindowsProcessBirth(
  pid: number,
  recordedOwnerStartedAt: number,
): ProcessBirthVerdict {
  if (process.platform !== "win32" || !Number.isSafeInteger(pid) || pid <= 0)
    return "unverified";
  try {
    const cmd = "$p=Get-Process -Id " + pid +
      " -ErrorAction Stop; ([DateTimeOffset]$p.StartTime).ToUnixTimeMilliseconds()";
    const output = execFileSync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command", cmd,
    ], {encoding:"utf8",timeout:4000,maxBuffer:1024,windowsHide:true}).trim();
    if (!/^\d{13}$/.test(output)) return "unverified";
    return compareProcessBirth(recordedOwnerStartedAt, Number(output));
  } catch {
    return "unverified";
  }
}
