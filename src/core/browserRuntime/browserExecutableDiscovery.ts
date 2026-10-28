/**
 * Browser Executable Discovery & Environment Probing (Milestones M0 + M1)
 *
 * Implements deterministic executable discovery across Linux, Windows, and macOS,
 * probing candidate names, display server availability (X11 / Wayland), and
 * resolving effective browser launch modes.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  type BrowserRuntimeMode,
  type ResolvedBrowserMode,
  type DisplayEnvironment,
  type ExecutableDiscoveryResult,
} from "./types.js";

/**
 * Standard candidate executable names for Linux distributions.
 * Probed in descending priority order.
 */
export const LINUX_EXECUTABLE_CANDIDATES = [
  "google-chrome",
  "google-chrome-stable",
  "chromium",
  "chromium-browser",
] as const;

/**
 * Standard filesystem locations on Debian/Ubuntu/Fedora/Arch/Snap Linux systems.
 */
export const LINUX_STANDARD_DIRS = [
  "/usr/bin",
  "/usr/local/bin",
  "/snap/bin",
  "/bin",
  "/opt/google/chrome",
] as const;

/**
 * Probes the operating system environment to determine whether an active
 * display server (X11 or Wayland) is accessible.
 */
export function probeLinuxDisplayEnvironment(env: NodeJS.ProcessEnv = process.env): DisplayEnvironment {
  const displayVar = env.DISPLAY ? env.DISPLAY.trim() : null;
  const waylandVar = env.WAYLAND_DISPLAY ? env.WAYLAND_DISPLAY.trim() : null;

  if (displayVar && displayVar.length > 0) {
    return {
      hasDisplay: true,
      displayType: "x11",
      displayVar,
      waylandVar,
    };
  }

  if (waylandVar && waylandVar.length > 0) {
    return {
      hasDisplay: true,
      displayType: "wayland",
      displayVar: null,
      waylandVar,
    };
  }

  return {
    hasDisplay: false,
    displayType: "none",
    displayVar: null,
    waylandVar: null,
  };
}

/**
 * Resolves the requested mode ("auto", "headless", "headed", "virtual-display")
 * into the concrete execution mode ("headless" | "headed" | "virtual-display")
 * based on OS platform and display server availability.
 *
 * Safety Invariants:
 * 1. "virtual-display" is supported on Linux (Xvfb + minimal WM); on Windows/macOS, it fails fast.
 * 2. "headed" on Linux without DISPLAY or WAYLAND_DISPLAY fails fast with a clear error.
 * 3. "auto" on Linux without display selects "headless" (or "virtual-display" if preferVirtualDisplay is set).
 * 4. "auto" on Windows/macOS preserves default headed desktop behavior.
 */
export function resolveEffectiveBrowserMode(
  requestedMode: BrowserRuntimeMode = "auto",
  platform: NodeJS.Platform = os.platform(),
  env: NodeJS.ProcessEnv = process.env,
  options?: { preferVirtualDisplay?: boolean }
): { mode: ResolvedBrowserMode; requested: BrowserRuntimeMode } {
  if (requestedMode === "virtual-display") {
    if (platform !== "linux") {
      throw new Error(
        `Virtual display mode (Xvfb/minimal WM) is only supported on Linux. Current platform is '${platform}'. ` +
        `Please use 'headed' or 'headless' mode.`
      );
    }
    return { mode: "virtual-display", requested: "virtual-display" };
  }

  if (requestedMode === "headless") {
    return { mode: "headless", requested: "headless" };
  }

  if (requestedMode === "headed") {
    if (platform === "linux") {
      const display = probeLinuxDisplayEnvironment(env);
      if (!display.hasDisplay) {
        throw new Error(
          "Cannot launch Chrome in 'headed' mode on Linux because neither DISPLAY nor WAYLAND_DISPLAY is set. " +
          "Use 'headless' mode, 'virtual-display' mode, or provide an active display server."
        );
      }
    }
    return { mode: "headed", requested: "headed" };
  }

  // requestedMode === "auto"
  if (platform === "linux") {
    const display = probeLinuxDisplayEnvironment(env);
    if (!display.hasDisplay) {
      if (options?.preferVirtualDisplay) {
        return { mode: "virtual-display", requested: "auto" };
      }
      return { mode: "headless", requested: "auto" };
    }
    return { mode: "headed", requested: "auto" };
  }

  // Windows, macOS, and other desktop platforms default to headed in auto mode
  return { mode: "headed", requested: "auto" };
}

/**
 * Inspects system PATH and standard directories to locate a valid Chrome or Chromium executable.
 */
export function discoverBrowserExecutable(
  overridePath?: string,
  platform: NodeJS.Platform = os.platform(),
  env: NodeJS.ProcessEnv = process.env
): ExecutableDiscoveryResult {
  const probed: string[] = [];

  // 1. Explicit override check
  if (overridePath) {
    probed.push(overridePath);
    if (fs.existsSync(overridePath)) {
      return {
        executable: overridePath,
        found: true,
        candidatesProbed: probed,
        platform,
      };
    }
  }

  // 2. Windows discovery
  if (platform === "win32") {
    const candidates = [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      path.join(env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
      path.join(env.PROGRAMFILES || "", "Google", "Chrome", "Application", "chrome.exe"),
      path.join(env["PROGRAMFILES(X86)"] || "", "Google", "Chrome", "Application", "chrome.exe"),
    ];

    for (const c of candidates) {
      if (c && c.length > 0) {
        probed.push(c);
        if (fs.existsSync(c)) {
          return {
            executable: c,
            found: true,
            candidatesProbed: probed,
            platform,
          };
        }
      }
    }

    // Fallback to chrome.exe in PATH
    probed.push("chrome.exe");
    return {
      executable: "chrome.exe",
      found: false,
      candidatesProbed: probed,
      platform,
    };
  }

  // 3. macOS discovery
  if (platform === "darwin") {
    const macCandidates = [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      path.join(os.homedir(), "Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome"),
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ];

    for (const c of macCandidates) {
      probed.push(c);
      if (fs.existsSync(c)) {
        return {
          executable: c,
          found: true,
          candidatesProbed: probed,
          platform,
        };
      }
    }

    probed.push("google-chrome");
    return {
      executable: "google-chrome",
      found: false,
      candidatesProbed: probed,
      platform,
    };
  }

  // 4. Linux discovery
  // Step 4a: Check standard filesystem directories directly
  for (const dir of LINUX_STANDARD_DIRS) {
    for (const name of LINUX_EXECUTABLE_CANDIDATES) {
      const fullPath = path.join(dir, name);
      probed.push(fullPath);
      try {
        if (fs.existsSync(fullPath)) {
          return {
            executable: fullPath,
            found: true,
            candidatesProbed: probed,
            platform,
          };
        }
      } catch {
        // Skip inaccessible paths
      }
    }
  }

  // Step 4b: Check PATH environment variable directories
  const pathEnv = env.PATH || "";
  const pathDirs = pathEnv.split(path.delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    for (const name of LINUX_EXECUTABLE_CANDIDATES) {
      const fullPath = path.join(dir, name);
      if (!probed.includes(fullPath)) {
        probed.push(fullPath);
        try {
          if (fs.existsSync(fullPath)) {
            return {
              executable: fullPath,
              found: true,
              candidatesProbed: probed,
              platform,
            };
          }
        } catch {
          // Skip inaccessible paths
        }
      }
    }
  }

  // If none found on Linux, return the canonical default with detailed error guidance
  return {
    executable: LINUX_EXECUTABLE_CANDIDATES[0],
    found: false,
    candidatesProbed: probed,
    platform,
    error:
      `No Chrome or Chromium executable found. Probed candidate binaries: [${LINUX_EXECUTABLE_CANDIDATES.join(", ")}]. ` +
      `Ensure Chromium or Google Chrome is installed (e.g. 'sudo apt-get install -y chromium-browser' or 'google-chrome-stable').`,
  };
}
