/**
 * Owner-initiated managed CDP launch preflight.
 *
 * A debug Chrome is a distinct user-data directory and session. Never "upgrade"
 * an already-open personal Chrome profile or silently substitute Delegate-CDP.
 */
import path from "node:path";
import os from "node:os";

export interface ManagedChromeLaunchRequest {
  port?: number;
  isolated?: boolean;
  userDataDir?: string;
  url?: string;
  profileName?: string;
}

export interface ManagedChromeLaunchPlan {
  port: number;
  userDataDir: string;
  profileName: string;
  url: string;
  host: "127.0.0.1";
}

/** Validate before launching or creating a profile directory. */
export function planManagedChromeLaunch(
  request: ManagedChromeLaunchRequest,
  defaultUserDataDir: (port: number) => string,
): ManagedChromeLaunchPlan {
  const port = request.port ?? 9222;
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
    throw new Error("MANAGED_CDP_INVALID_PORT: select a local TCP port between 1024 and 65535.");
  }
  if (request.isolated === false) {
    throw new Error("MANAGED_CDP_ISOLATION_REQUIRED: debug Chrome must use an isolated profile; use Delegate-CDP for an existing login.");
  }
  const profileName = request.profileName ?? "Default";
  if (!/^(Default|Profile [1-9][0-9]{0,2})$/.test(profileName)) {
    throw new Error("MANAGED_CDP_INVALID_PROFILE: use Default or Profile N inside the isolated data directory.");
  }
  const url = request.url?.trim() || "about:blank";
  if (url.length > 2048) {
    throw new Error("MANAGED_CDP_INVALID_URL: URL exceeds 2048 characters.");
  }
  if (url !== "about:blank") {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error("MANAGED_CDP_INVALID_URL: use an absolute HTTP(S) URL or about:blank.");
    }
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error("MANAGED_CDP_INVALID_URL: only HTTP(S) URLs without embedded credentials are permitted.");
    }
  }
  const dir = request.userDataDir ?? defaultUserDataDir(port);
  if (!path.isAbsolute(dir) || dir.includes("\0") || /[\r\n]/.test(dir)) {
    throw new Error("MANAGED_CDP_INVALID_PROFILE_DIR: supply an absolute user-data directory.");
  }
  // Chrome 136+ ignores remote-debugging flags for its default data dir.
  // Do not accept an explicit default Chrome data dir even if user selected it.
  const normalized = path.normalize(dir).toLowerCase();
  const defaultChromeDir = process.platform === "win32"
    ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
      "Google", "Chrome", "User Data")
    : process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome")
      : path.join(os.homedir(), ".config", "google-chrome");
  if (normalized === path.normalize(defaultChromeDir).toLowerCase()) {
    throw new Error("MANAGED_CDP_PROFILE_CONFLICT: default personal Chrome profile cannot be used for debugging; choose an isolated directory.");
  }
  return { port, userDataDir: dir, profileName, url, host: "127.0.0.1" };
}
