/**
 * One-way, best-effort launch of the companion SuperAgent Tray utility.
 *
 * Only long-lived verified hosts call this. Tray never starts/controls an
 * agent/server; the native single-instance plugin owns the one-tray invariant.
 * A missing/old binary must not block CLI/server startup or run a shell.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { getPackageRootDir, getRootConfigDir } from "../config/paths.js";
import {getActiveReleaseBinary} from "./trayReleaseStore.js";

type Environment = NodeJS.ProcessEnv;

export function shouldAutoLaunchTray(
  environment: Environment = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === "win32" &&
    environment.SUPERAGENT_TRAY_AUTOSTART !== "0" &&
    environment.SUPERAGENT_TRAY_CHILD !== "1" &&
    environment.SUPERAGENT_CORE_WORKER !== "1" &&
    environment.NODE_ENV !== "test" &&
    environment.VITEST !== "true" &&
    !environment.VITEST &&
    !environment.BUN_TEST &&
    // The connected SuperAgent host may set CI=1 even on the user's desktop.
    // Only a specifically identified headless CI runner suppresses GUI launch.
    !environment.GITHUB_ACTIONS &&
    !environment.TF_BUILD;
}

/**
 * The Settings toggle controls *future* CLI/server-triggered launches.
 * Environment SUPERAGENT_TRAY_AUTOSTART=0/1 has higher priority.
 * Only a small, strict local file is read; we never load Core secrets here.
 * Invalid, oversize or symlinked preferences fail closed (manual Tray works).
 */
export function trayPreferencesAllowAutoLaunch(
  configDir: string,
  environment: Environment = process.env,
): boolean {
  if (environment.SUPERAGENT_TRAY_AUTOSTART === "0") return false;
  if (environment.SUPERAGENT_TRAY_AUTOSTART === "1") return true;
  const file = path.join(configDir, "tray-settings.json");
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) return false;
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    const keys = [
      "version", "autoLaunchWithSuperagent", "notificationsEnabled",
      "closeToTray", "runtimeScanSeconds", "jobsRefreshSeconds",
      "notificationPollSeconds", "startupPage",
    ];
    if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== keys.sort().join(",") ||
      value.version !== 1 ||
      typeof value.autoLaunchWithSuperagent !== "boolean" ||
      typeof value.notificationsEnabled !== "boolean" ||
      typeof value.closeToTray !== "boolean" ||
      ![10, 20, 30, 60, 120].includes(value.runtimeScanSeconds as number) ||
      ![15, 30, 60, 120].includes(value.jobsRefreshSeconds as number) ||
      ![15, 30, 60, 120].includes(value.notificationPollSeconds as number) ||
      !["jobs", "runtime", "history"].includes(value.startupPage as string)) return false;
    return value.autoLaunchWithSuperagent === true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return true;
    return false;
  }
}

/** Ordered, absolute and predictable candidates. No PATH command lookup. */
export function trayExecutableCandidates(
  projectRoot: string,
  configDir: string,
  explicitPath?: string,
): string[] {
  // A verified immutable release is always preferred to the legacy
  // installed filename and build-tree debug executable.
  let activeRelease:string|null=null;
  try{activeRelease=getActiveReleaseBinary(configDir);}
  catch{return [];} // A corrupted manifest must never launch a fallback.
  const candidates = [
    activeRelease,
    explicitPath,
    path.join(configDir, "bin", "superagent-tray.exe"),
    path.join(projectRoot, "apps", "superagent-tray", "src-tauri", "target", "release", "superagent-tray.exe"),
    path.join(projectRoot, "apps", "superagent-tray", "src-tauri", "target", "debug", "superagent-tray.exe"),
  ];
  return [...new Set(candidates.filter((candidate): candidate is string => Boolean(candidate))
    .filter(candidate => path.isAbsolute(candidate)))];
}

function hasSafeExecutable(candidate: string): boolean {
  try {
    const stat = fs.lstatSync(candidate);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch { return false; }
}

export function autoLaunchSuperAgentTray(): boolean {
  if (!shouldAutoLaunchTray()) return false;
  const configDir = getRootConfigDir();
  if (!trayPreferencesAllowAutoLaunch(configDir)) return false;
  const executable = trayExecutableCandidates(
    getPackageRootDir(),
    configDir,
    process.env.SUPERAGENT_TRAY_EXECUTABLE,
  ).find(hasSafeExecutable);
  if (!executable) {
    if (process.env.SUPERAGENT_TRAY_DEBUG === "1") {
      console.warn("[SuperAgent Tray] Executable not installed; run bun scripts/install-superagent-tray.ts");
    }
    return false;
  }
  try {
    const child = spawn(executable, ["--background"], {
      cwd: path.dirname(executable),
      detached: true,
      windowsHide: true,
      stdio: "ignore",
      env: { ...process.env, SUPERAGENT_TRAY_CHILD: "1" },
    });
    // Spawn can fail asynchronously after returning a ChildProcess.
    child.on("error", (error) => {
      if (process.env.SUPERAGENT_TRAY_DEBUG === "1") {
        console.warn("[SuperAgent Tray] Launch failed:", error.message);
      }
    });
    child.unref();
    return true; // Launched/requested, not verified by the OS.
  } catch (error) {
    if (process.env.SUPERAGENT_TRAY_DEBUG === "1") {
      console.warn("[SuperAgent Tray] Launch failed:", error);
    }
    return false;
  }
}
