/**
 * Browser Launch Flags Builder (Milestones M0 + M1)
 *
 * Constructs secure, normalized command-line flags for Chromium/Chrome instances.
 * Enforces strict loopback CDP binding, isolated profiles, headless mode flags,
 * and sandbox security boundaries.
 */

import { type ResolvedBrowserMode } from "./types.js";

export interface BuildBrowserFlagsOptions {
  mode: ResolvedBrowserMode;
  port: number;
  host?: string;
  userDataDir: string;
  profileName?: string;
  url?: string;
  autoSelectDesktopCaptureSource?: string;
  useFakeMediaUi?: boolean;
  additionalFlags?: string[];
}

/**
 * Flags strictly prohibited for security, sandbox, or multi-tenant boundary integrity.
 */
const BANNED_FLAGS = [
  "--no-sandbox",
  "--disable-web-security",
  "--disable-setuid-sandbox",
  "--allow-file-access-from-files",
];

/**
 * Builds normalized, security-vetted arguments for Chrome/Chromium launch.
 */
export function buildBrowserLaunchFlags(options: BuildBrowserFlagsOptions): string[] {
  const {
    mode,
    port,
    userDataDir,
    profileName,
    url,
    autoSelectDesktopCaptureSource,
    useFakeMediaUi,
    additionalFlags = [],
  } = options;

  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`Invalid CDP remote debugging port: ${port}. Must be between 1024 and 65535.`);
  }

  const flags: string[] = [
    `--remote-debugging-port=${port}`,
    `--remote-debugging-address=127.0.0.1`,
    `--user-data-dir=${userDataDir}`,
    `--no-first-run`,
    `--no-default-browser-check`,
  ];

  // Headless mode flags
  if (mode === "headless") {
    flags.push("--headless=new", "--disable-gpu");
  }

  // Profile directory
  if (profileName && profileName !== "Default") {
    const safeProfile = profileName.replace(/["'\\]/g, "");
    flags.push(`--profile-directory=${safeProfile}`);
  }

  // Media bypass flags (for automated tests or unattended captures)
  if (useFakeMediaUi) {
    const captureSource = autoSelectDesktopCaptureSource
      ? autoSelectDesktopCaptureSource.replace(/["'\\]/g, "")
      : "Entire screen";
    flags.push(
      `--auto-select-desktop-capture-source=${captureSource}`,
      "--use-fake-ui-for-media-stream",
      "--enable-usermedia-screen-capturing"
    );
  }

  // Sanitize and append caller-supplied additionalFlags
  for (const rawFlag of additionalFlags) {
    const trimmed = rawFlag.trim();
    if (!trimmed) continue;

    // Reject banned dangerous flags
    const flagKey = trimmed.split("=")[0].toLowerCase();
    if (BANNED_FLAGS.includes(flagKey)) {
      continue; // Silently drop prohibited flags to maintain sandbox integrity
    }

    // Prohibit external remote-debugging-address overrides
    if (flagKey === "--remote-debugging-address") {
      continue;
    }

    // Avoid duplicate port or userDataDir flags
    if (flagKey === "--remote-debugging-port" || flagKey === "--user-data-dir") {
      continue;
    }

    flags.push(trimmed);
  }

  // Target URL (appended last)
  if (url && url.trim().length > 0) {
    flags.push(url.trim());
  }

  return flags;
}
