/**
 * Virtual Display Package Discovery & Actionable Diagnostics (Milestone M2)
 *
 * Probes the host system for Xvfb, minimal window manager candidates, and opt-in
 * VNC/noVNC binaries. Produces distro-aware actionable installation commands
 * and enforces fail-fast error reporting when mandatory components are missing.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export interface PackageDiscoveryResult {
  xvfb: { found: boolean; path?: string };
  windowManager: { found: boolean; name?: string; path?: string };
  x11vnc: { found: boolean; path?: string };
  websockify: { found: boolean; path?: string };
  novncWebDir: { found: boolean; path?: string };
  missingRequired: string[];
  missingOptional: string[];
  actionableInstallCommand: string;
}

/**
 * Candidate window manager binaries in descending preference order.
 */
export const WINDOW_MANAGER_CANDIDATES = [
  "openbox",
  "fluxbox",
  "matchbox-window-manager",
  "twm",
] as const;

/**
 * Standard Linux filesystem search directories for system binaries.
 */
const SYSTEM_BIN_DIRS = [
  "/usr/bin",
  "/usr/local/bin",
  "/bin",
  "/snap/bin",
  "/usr/games",
];

/**
 * Standard Linux filesystem locations for noVNC web assets.
 */
const NOVNC_STANDARD_DIRS = [
  "/usr/share/novnc",
  "/usr/local/share/novnc",
  "/snap/novnc/current",
  "/opt/novnc",
];

/**
 * Finds a binary by name across standard PATH directories.
 */
export function findSystemBinary(
  binaryName: string,
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const pathDirs = (env.PATH || "").split(path.delimiter).filter(Boolean);
  const searchDirs = Array.from(new Set([...pathDirs, ...SYSTEM_BIN_DIRS]));

  for (const dir of searchDirs) {
    const fullPath = path.join(dir, binaryName);
    try {
      if (fs.existsSync(fullPath)) {
        const stat = fs.statSync(fullPath);
        if (stat.isFile() && (stat.mode & 0o111)) {
          return fullPath;
        }
      }
    } catch {
      // Continue search on filesystem error
    }
  }

  return null;
}

/**
 * Probes for an available lightweight window manager.
 */
export function discoverWindowManager(
  env: NodeJS.ProcessEnv = process.env
): { found: boolean; name?: string; path?: string } {
  for (const candidate of WINDOW_MANAGER_CANDIDATES) {
    const binPath = findSystemBinary(candidate, env);
    if (binPath) {
      return { found: true, name: candidate, path: binPath };
    }
  }
  return { found: false };
}

/**
 * Detects the Linux distribution family to provide tailored package manager commands.
 */
export function detectLinuxDistributionFamily(): "debian" | "fedora" | "arch" | "alpine" | "unknown" {
  try {
    if (fs.existsSync("/etc/os-release")) {
      const osRelease = fs.readFileSync("/etc/os-release", "utf8").toLowerCase();
      if (osRelease.includes("debian") || osRelease.includes("ubuntu")) return "debian";
      if (osRelease.includes("fedora") || osRelease.includes("rhel") || osRelease.includes("centos")) return "fedora";
      if (osRelease.includes("arch") || osRelease.includes("manjaro")) return "arch";
      if (osRelease.includes("alpine")) return "alpine";
    }
  } catch {}

  // Fallback to binary check
  if (findSystemBinary("apt-get")) return "debian";
  if (findSystemBinary("dnf")) return "fedora";
  if (findSystemBinary("pacman")) return "arch";
  if (findSystemBinary("apk")) return "alpine";

  return "unknown";
}

/**
 * Generates an actionable installation command based on detected distro.
 */
export function generateInstallCommand(
  distro: "debian" | "fedora" | "arch" | "alpine" | "unknown" = detectLinuxDistributionFamily()
): string {
  switch (distro) {
    case "debian":
      return "sudo apt-get update && sudo apt-get install -y xvfb openbox x11vnc websockify novnc";
    case "fedora":
      return "sudo dnf install -y xorg-x11-server-Xvfb openbox x11vnc python3-websockify novnc";
    case "arch":
      return "sudo pacman -S --noconfirm xorg-server-xvfb openbox x11vnc python-websockify novnc";
    case "alpine":
      return "sudo apk add xvfb openbox x11vnc websockify novnc";
    default:
      return "Install Xvfb, openbox (or fluxbox), x11vnc, websockify, and novnc using your system package manager.";
  }
}

/**
 * Inspects system prerequisites for virtual-display execution.
 */
export function probeVirtualDisplayPrerequisites(
  options: { requireVnc?: boolean; requireNoVnc?: boolean; env?: NodeJS.ProcessEnv } = {}
): PackageDiscoveryResult {
  const env = options.env ?? process.env;

  const xvfbPath = findSystemBinary("Xvfb", env);
  const wm = discoverWindowManager(env);
  const x11vncPath = findSystemBinary("x11vnc", env);
  const websockifyPath = findSystemBinary("websockify", env);

  let novncPath: string | null = null;
  for (const dir of NOVNC_STANDARD_DIRS) {
    if (fs.existsSync(dir)) {
      novncPath = dir;
      break;
    }
  }

  const missingRequired: string[] = [];
  const missingOptional: string[] = [];

  if (!xvfbPath) missingRequired.push("Xvfb");
  if (!wm.found) missingRequired.push("Window Manager (openbox/fluxbox/matchbox/twm)");

  if (options.requireVnc && !x11vncPath) {
    missingRequired.push("x11vnc");
  } else if (!x11vncPath) {
    missingOptional.push("x11vnc");
  }

  if (options.requireNoVnc && !websockifyPath) {
    missingRequired.push("websockify");
  } else if (!websockifyPath) {
    missingOptional.push("websockify");
  }

  if (options.requireNoVnc && !novncPath) {
    missingRequired.push("noVNC web directory");
  } else if (!novncPath) {
    missingOptional.push("noVNC web directory");
  }

  const installCmd = generateInstallCommand();

  return {
    xvfb: { found: Boolean(xvfbPath), path: xvfbPath ?? undefined },
    windowManager: wm,
    x11vnc: { found: Boolean(x11vncPath), path: x11vncPath ?? undefined },
    websockify: { found: Boolean(websockifyPath), path: websockifyPath ?? undefined },
    novncWebDir: { found: Boolean(novncPath), path: novncPath ?? undefined },
    missingRequired,
    missingOptional,
    actionableInstallCommand: installCmd,
  };
}

/**
 * Asserts that all required virtual display packages are present.
 * Fails fast with an actionable error if any mandatory package is missing.
 */
export function assertVirtualDisplayPrerequisites(
  options: { requireVnc?: boolean; requireNoVnc?: boolean; env?: NodeJS.ProcessEnv } = {}
): PackageDiscoveryResult {
  if (os.platform() !== "linux") {
    throw new Error(
      `Virtual display mode is only supported on Linux. Current platform: '${os.platform()}'. ` +
      `On Windows or macOS, please use 'headed' or 'headless' mode.`
    );
  }

  const discovery = probeVirtualDisplayPrerequisites(options);
  if (discovery.missingRequired.length > 0) {
    throw new Error(
      `Virtual display mode cannot start because required system packages are missing: ` +
      `[${discovery.missingRequired.join(", ")}].\n` +
      `To install them, run:\n  ${discovery.actionableInstallCommand}`
    );
  }

  return discovery;
}
