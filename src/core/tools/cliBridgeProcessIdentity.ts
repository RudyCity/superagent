/**
 * Best-effort, read-only process start identity for CLI Bridge crash diagnostics.
 * No PID observation proves that descendants exited, and no result authorizes
 * cancellation, automatic job reattachment or stale artifact claim removal.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const WINDOWS_PROBE_TIMEOUT_MS = 4000;

/**
 * Fingerprints are host-local process creation metadata. They are not secret
 * or cryptographic attestations. Cross-machine portability is not intended.
 * Null means unavailable, not that the process is absent.
 */
export async function readProcessStartIdentity(pid: number | null | undefined): Promise<string | null> {
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === "linux") {
      const [stat, bootId] = await Promise.all([
        readFile("/proc/" + pid + "/stat", "utf8"),
        readFile("/proc/sys/kernel/random/boot_id", "utf8"),
      ]);
      // comm may contain spaces and ')'; fields after the final ") " start at
      // Linux /proc stat field 3. starttime is field 22, hence index 19.
      const close = stat.lastIndexOf(")");
      if (close < 0 || stat[close + 1] !== " ") return null;
      const fields = stat.slice(close + 2).trim().split(/\s+/);
      const startTicks = fields[19];
      if (!/^\d+$/.test(startTicks) || !/^[a-f0-9-]{36}$/i.test(bootId.trim())) return null;
      return "linux:" + bootId.trim().toLowerCase() + ":" + startTicks;
    }
    if (process.platform === "win32") {
      // ProcessId is integer-validated above, never interpolated user text.
      // CreationDate is a UTC .NET tick value from Win32_Process.
      const command = "$p=Get-CimInstance Win32_Process -Filter 'ProcessId = " + pid
        + "' -ErrorAction Stop; if ($null -ne $p) { [string]$p.CreationDate.ToUniversalTime().Ticks }";
      const { stdout } = await execFileAsync("powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", command],
        { timeout: WINDOWS_PROBE_TIMEOUT_MS, maxBuffer: 2048, windowsHide: true });
      const ticks = stdout.trim();
      if (!/^\d{15,20}$/.test(ticks)) return null;
      return "win:" + ticks;
    }
    return null;
  } catch {
    // Permission denied, process exited, missing PowerShell, timeouts or
    // unsupported /proc are all inconclusive; never equate with "dead".
    return null;
  }
}

export type ProcessIdentityComparison = "matched_unverified" | "mismatch" | "unknown";

/** The saved fingerprint must match current process start identity exactly. */
export function compareProcessStartIdentity(
  persisted: string | null | undefined,
  observed: string | null | undefined,
): ProcessIdentityComparison {
  if (!persisted || !observed) return "unknown";
  return persisted === observed ? "matched_unverified" : "mismatch";
}
