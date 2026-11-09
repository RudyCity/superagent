import { access } from "node:fs/promises";
import path from "node:path";
import { DesktopUiError } from "../desktopUi/errors.js";
import { createRestrictedProcessRunner, type DesktopProcessRunner } from "../desktopUi/processRunner.js";
import type {
  DesktopPackageManager,
  DesktopPackageProvider,
  InstalledPackage,
  PackageApplyResult,
  PackageChangePlan,
  PackageChangeStep,
} from "./types.js";

const WINDOWS_ROOT = process.env.SystemRoot || process.env.windir || "C:\\Windows";
const WINDOWS_POWERSHELL = path.win32.join(WINDOWS_ROOT, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const BREW_CANDIDATES = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"] as const;
const APT = "/usr/bin/apt";
const DNF = "/usr/bin/dnf";

const WINGET_SCRIPT = String.raw`
$ErrorActionPreference = "Stop"
$payload = ConvertFrom-Json $env:SUPERAGENT_DESKTOP_PACKAGE_PAYLOAD
$app = Get-AppxPackage -Name Microsoft.DesktopAppInstaller -ErrorAction Stop | Sort-Object Version -Descending | Select-Object -First 1
if (-not $app.InstallLocation) { throw "DEPENDENCY_REQUIRED: Windows App Installer is unavailable" }
$winget = [IO.Path]::GetFullPath((Join-Path $app.InstallLocation "winget.exe"))
$windowsApps = [IO.Path]::GetFullPath((Join-Path $env:ProgramFiles "WindowsApps"))
if (-not $winget.StartsWith($windowsApps, [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $winget -PathType Leaf)) {
  throw "DEPENDENCY_REQUIRED: resolved winget executable is outside the trusted WindowsApps package directory"
}
$argsList = @($payload.args | ForEach-Object { [string]$_ })
$output = & $winget @argsList 2>&1 | Out-String
$code = $LASTEXITCODE
[pscustomobject]@{ exitCode=$code; output=$output } | ConvertTo-Json -Depth 4 -Compress
`;

function encodePowerShell(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

function cleanTerminal(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\r/g, "");
}

function boundedLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new DesktopUiError("INVALID_ACTION", "Installed package limit must be an integer between 1 and 200.");
  }
  return limit;
}

function parseWingetList(output: string, limit: number): { packages: InstalledPackage[]; truncated: boolean } {
  const lines = cleanTerminal(output).split("\n").map((line) => line.trimEnd()).filter(Boolean);
  const divider = lines.findIndex((line) => /^-{3,}(?:\s+-{3,})*$/.test(line.trim()));
  const rows = divider >= 0 ? lines.slice(divider + 1) : [];
  const packages: InstalledPackage[] = [];
  for (const row of rows) {
    const columns = row.trim().split(/\s{2,}/).filter(Boolean);
    if (columns.length < 3) continue;
    const [name, id, version] = columns;
    if (!id || !/^[A-Za-z0-9][A-Za-z0-9._+\-]{0,127}$/.test(id)) continue;
    packages.push({
      id,
      name: (name || id).slice(0, 256),
      version: version?.slice(0, 128),
      manager: "winget",
      source: columns.length >= 5 ? columns.at(-1)?.slice(0, 64) : undefined,
    });
    if (packages.length > limit) break;
  }
  return { packages: packages.slice(0, limit), truncated: packages.length > limit };
}

function parseBrewList(output: string, manager: "brew", limit: number): InstalledPackage[] {
  const items: InstalledPackage[] = [];
  for (const line of cleanTerminal(output).split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [id, ...versions] = trimmed.split(/\s+/);
    if (!/^[A-Za-z0-9][A-Za-z0-9@._+\-]{0,127}$/.test(id)) continue;
    items.push({ id, name: id, version: versions.join(",").slice(0, 128) || undefined, manager });
    if (items.length >= limit) break;
  }
  return items;
}

function parseAptList(output: string, limit: number): InstalledPackage[] {
  const items: InstalledPackage[] = [];
  for (const line of cleanTerminal(output).split("\n")) {
    const match = /^([^/\s]+)\/\S+\s+([^\s]+)\s+\S+\s+\[installed/i.exec(line.trim());
    if (!match) continue;
    items.push({ id: match[1], name: match[1], version: match[2], manager: "apt" });
    if (items.length >= limit) break;
  }
  return items;
}

function parseDnfList(output: string, limit: number): InstalledPackage[] {
  const items: InstalledPackage[] = [];
  for (const line of cleanTerminal(output).split("\n")) {
    const match = /^([^\s.]+)(?:\.[^\s]+)?\s+([^\s]+)\s+([^\s]+)/.exec(line.trim());
    if (!match || /^installed$/i.test(match[1])) continue;
    items.push({ id: match[1], name: match[1], version: match[2], manager: "dnf", source: match[3] });
    if (items.length >= limit) break;
  }
  return items;
}

async function firstExisting(
  paths: readonly string[],
  pathExists: (candidate: string) => Promise<boolean>,
): Promise<string | null> {
  for (const candidate of paths) {
    if (await pathExists(candidate)) return candidate;
  }
  return null;
}

function exactArgs(step: PackageChangeStep): string[] {
  const versioned = step.version ? `${step.packageId}@${step.version}` : step.packageId;
  switch (step.manager) {
    case "winget": {
      const args = [
        step.operation === "upgrade" ? "upgrade" : step.operation,
        "--id", step.packageId, "--exact", "--disable-interactivity",
      ];
      if (step.version && step.operation !== "uninstall") args.push("--version", step.version);
      if (step.source) args.push("--source", step.source);
      return args;
    }
    case "brew":
      if (step.operation === "upgrade") return ["upgrade", versioned];
      return [step.operation, versioned];
    case "apt":
    case "dnf":
      throw new DesktopUiError(
        "OS_PERMISSION_REQUIRED",
        "Linux package mutation is fail-closed until a separate operator-owned privileged terminal integration exists; sudo/pkexec is never invoked automatically.",
      );
  }
}

export function createDesktopPackageProvider(options: {
  platform?: NodeJS.Platform;
  runner?: DesktopProcessRunner;
  pathExists?: (candidate: string) => Promise<boolean>;
  allowPotentialNetworkInventory?: boolean;
} = {}): DesktopPackageProvider {
  const platform = options.platform ?? process.platform;
  const pathExists = options.pathExists ?? (async (candidate: string) => {
    try {
      await access(candidate);
      return true;
    } catch {
      return false;
    }
  });

  if (platform === "win32") {
    const runner = options.runner ?? createRestrictedProcessRunner([WINDOWS_POWERSHELL]);
    const runWinget = async (args: string[]) => {
      if (args.some((arg) => /^--accept-/i.test(arg) || arg === "--silent")) {
        throw new DesktopUiError("INVALID_ACTION", "Broad agreement acceptance and silent package mutation flags are forbidden.");
      }
      const result = await runner.run({
        executable: WINDOWS_POWERSHELL,
        args: ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShell(WINGET_SCRIPT)],
        env: { SUPERAGENT_DESKTOP_PACKAGE_PAYLOAD: JSON.stringify({ args }) },
        timeoutMs: 120_000,
      });
      const parsed = JSON.parse(result.stdout || "{}") as { exitCode?: number; output?: string };
      if (parsed.exitCode !== 0) {
        throw new DesktopUiError("PROCESS_FAILED", `winget exited with code ${String(parsed.exitCode)}.`);
      }
      return String(parsed.output || "");
    };
    return {
      manager: "winget",
      async listInstalled(limit) {
        const bounded = boundedLimit(limit);
        if (options.allowPotentialNetworkInventory !== true) {
          throw new DesktopUiError(
            "DEPENDENCY_REQUIRED",
            "Strict-offline WinGet installed-package inventory is unavailable through the CLI; enumeration is disabled rather than allowing implicit source access.",
          );
        }
        return parseWingetList(await runWinget(["list", "--disable-interactivity", "--count", String(bounded + 1)]), bounded);
      },
      async apply(plan): Promise<PackageApplyResult> {
        let completed = 0;
        for (const step of plan.steps) {
          await runWinget(exactArgs(step));
          completed += 1;
        }
        return { manager: "winget", packageId: plan.packageId, action: plan.action, applied: true, stepsCompleted: completed };
      },
    };
  }

  if (platform === "darwin") {
    let selectedBrew: string | null = null;
    const runner = options.runner ?? createRestrictedProcessRunner(BREW_CANDIDATES);
    const getBrew = async () => {
      selectedBrew ??= await firstExisting(BREW_CANDIDATES, pathExists);
      if (!selectedBrew) throw new DesktopUiError("DEPENDENCY_REQUIRED", "Homebrew is not installed in a trusted standard location.");
      return selectedBrew;
    };
    return {
      manager: "brew",
      async listInstalled(limit) {
        const bounded = boundedLimit(limit);
        const brew = await getBrew();
        const [formulae, casks] = await Promise.all([
          runner.run({ executable: brew, args: ["list", "--versions", "--formula"], timeoutMs: 15_000 }),
          runner.run({ executable: brew, args: ["list", "--versions", "--cask"], timeoutMs: 15_000 }),
        ]);
        const combined = [...parseBrewList(formulae.stdout, "brew", bounded + 1), ...parseBrewList(casks.stdout, "brew", bounded + 1)];
        const unique = Array.from(new Map(combined.map((item) => [item.id, item])).values());
        return { packages: unique.slice(0, bounded), truncated: unique.length > bounded };
      },
      async apply(plan) {
        const brew = await getBrew();
        let completed = 0;
        for (const step of plan.steps) {
          await runner.run({ executable: brew, args: exactArgs(step), timeoutMs: 120_000 });
          completed += 1;
        }
        return { manager: "brew", packageId: plan.packageId, action: plan.action, applied: true, stepsCompleted: completed };
      },
    };
  }

  if (platform === "linux") {
    const runner = options.runner ?? createRestrictedProcessRunner([APT, DNF]);
    let manager: "apt" | "dnf" | null = null;
    const resolveManager = async (): Promise<"apt" | "dnf"> => {
      if (manager) return manager;
      if (await firstExisting([APT], pathExists)) return manager = "apt";
      if (await firstExisting([DNF], pathExists)) return manager = "dnf";
      throw new DesktopUiError("DEPENDENCY_REQUIRED", "Neither apt nor dnf is available at a trusted system path.");
    };
    return {
      get manager(): DesktopPackageManager {
        return manager ?? "apt";
      },
      async listInstalled(limit) {
        const bounded = boundedLimit(limit);
        const selected = await resolveManager();
        const executable = selected === "apt" ? APT : DNF;
        const args = selected === "apt" ? ["list", "--installed"] : ["list", "--installed", "--cacheonly"];
        const result = await runner.run({ executable, args, timeoutMs: 20_000 });
        const packages = selected === "apt" ? parseAptList(result.stdout, bounded + 1) : parseDnfList(result.stdout, bounded + 1);
        return { packages: packages.slice(0, bounded), truncated: packages.length > bounded };
      },
      async apply() {
        throw new DesktopUiError(
          "OS_PERMISSION_REQUIRED",
          "Linux package mutation is fail-closed: SuperAgent will not invoke sudo/pkexec or auto-answer an administrator prompt.",
        );
      },
    };
  }

  throw new DesktopUiError("PLATFORM_UNSUPPORTED", `Package management is unsupported on platform '${platform}'.`);
}
