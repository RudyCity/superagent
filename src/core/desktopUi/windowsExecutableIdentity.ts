/**
 * Resolve running Windows process to OS executable and SHA-256.
 * No agent-supplied executable path or digest is trusted.
 */
import path from "node:path";
import { createRestrictedProcessRunner, type DesktopProcessRunner } from "./processRunner.js";
import type { ExecutableIdentity } from "./persistentAccessPolicy.js";

const POWERSHELL = path.win32.join(
  process.env.SystemRoot || process.env.windir || "C:\\Windows",
  "System32", "WindowsPowerShell", "v1.0", "powershell.exe",
);
const SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$requested = [int]$env:SUPERAGENT_DESKTOP_ACCESS_PID",
  "if ($requested -le 0) { throw 'Invalid process identity' }",
  "$before = Get-Process -Id $requested -ErrorAction Stop",
  "$exe = $before.Path",
  "$started = $before.StartTime.ToFileTimeUtc()",
  "if (-not $exe) { throw 'Process executable is inaccessible' }",
  "$canonical = (Resolve-Path -LiteralPath $exe -ErrorAction Stop).ProviderPath",
  "$sha = (Get-FileHash -LiteralPath $canonical -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()",
  "$after = Get-Process -Id $requested -ErrorAction Stop",
  "if ($after.StartTime.ToFileTimeUtc() -ne $started -or $after.Path -ne $exe) { throw 'Process changed' }",
  "[pscustomobject]@{ executablePath = $canonical; sha256 = $sha } | ConvertTo-Json -Compress",
].join("\n");

export async function resolveWindowsDesktopExecutable(
  pid: number,
  runner: DesktopProcessRunner = createRestrictedProcessRunner([POWERSHELL]),
): Promise<ExecutableIdentity | null> {
  if (process.platform !== "win32" || !Number.isSafeInteger(pid) || pid <= 0 || pid > 0xffffffff) return null;
  try {
    const result = await runner.run({
      executable: POWERSHELL,
      args: ["-NoProfile", "-NonInteractive", "-EncodedCommand",
        Buffer.from(SCRIPT, "utf16le").toString("base64")],
      env: { SUPERAGENT_DESKTOP_ACCESS_PID: String(pid) },
      timeoutMs: 20_000,
    });
    const parsed: unknown = JSON.parse(result.stdout.trim());
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const v = parsed as Record<string, unknown>;
    if (Object.keys(v).sort().join(",") !== "executablePath,sha256"
      || typeof v.executablePath !== "string" || typeof v.sha256 !== "string"
      || !/^[a-z]:\\/i.test(v.executablePath)
      || v.executablePath.includes("/") || v.executablePath.includes("..")
      || !/^[a-f0-9]{64}$/i.test(v.sha256)) return null;
    return { platform: "win32", executablePath: v.executablePath, sha256: v.sha256.toLowerCase() };
  } catch {
    return null;
  }
}
