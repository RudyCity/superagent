import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DesktopUiError } from "../desktopUi/errors.js";
import { createRestrictedProcessRunner, type DesktopProcessRunner } from "../desktopUi/processRunner.js";
import type { DesktopAppLifecycleProvider, InstalledApplication } from "./types.js";
import { createMacWindowLifecycle } from "./macWindow.js";

const PLUTIL = "/usr/bin/plutil";
const OPEN = "/usr/bin/open";
const APP_DIRECTORIES = ["/Applications", "/System/Applications", path.join(os.homedir(), "Applications")];
const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9.-]{1,199}$/;

export interface MacAppProviderOptions {
  runner?: DesktopProcessRunner;
  scanBundles?: () => Promise<Array<{ bundlePath: string; name: string }>>;
}

async function systemBundles(): Promise<Array<{ bundlePath: string; name: string }>> {
  const result: Array<{ bundlePath: string; name: string }> = [];
  for (const root of APP_DIRECTORIES) {
    let entries: Dirent<string>[];
    try {
      entries = await readdir(root, { withFileTypes: true, encoding: "utf8" });
    } catch {
      continue;
    }
    for (const entry of entries.slice(0, 300)) {
      if (!entry.isDirectory() || !entry.name.endsWith(".app")) continue;
      result.push({ bundlePath: path.join(root, entry.name), name: entry.name.slice(0, -4) });
    }
  }
  return result;
}

export function createMacDesktopAppProvider(options: MacAppProviderOptions = {}): DesktopAppLifecycleProvider {
  const runner = options.runner ?? createRestrictedProcessRunner([PLUTIL, OPEN]);
  const scan = options.scanBundles ?? systemBundles;
  const lifecycle = createMacWindowLifecycle({ runner: options.runner });

  const listApplications = async (limit: number) => {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new DesktopUiError("INVALID_ACTION", "Application inventory limit must be an integer from 1 to 100.");
    }
    const found = new Map<string, InstalledApplication>();
    const duplicate = new Set<string>();
    const bundles = await scan();
    for (const entry of bundles.slice(0, 600)) {
      if (!entry.bundlePath.endsWith(".app") || !entry.name || entry.name.length > 256) continue;
      const plist = path.join(entry.bundlePath, "Contents", "Info.plist");
      try {
        const metadata = await runner.run({
          executable: PLUTIL,
          args: ["-extract", "CFBundleIdentifier", "raw", "-o", "-", plist],
          timeoutMs: 3_000,
        });
        const id = metadata.stdout.trim();
        if (!BUNDLE_ID.test(id)) continue;
        if (found.has(id)) {
          duplicate.add(id);
          continue;
        }
        found.set(id, { id, name: entry.name, platform: "darwin", launchKind: "macos-bundle-id" });
      } catch {
        continue;
      }
    }
    for (const id of duplicate) found.delete(id);
    const applications = [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
    return { applications: applications.slice(0, limit), truncated: applications.length > limit };
  };

  return {
    listApplications,
    async launchVerified(appId) {
      if (typeof appId !== "string" || !BUNDLE_ID.test(appId)) {
        throw new DesktopUiError("INVALID_ACTION", "macOS appId must be an exact installed bundle identifier.");
      }
      const inventory = await listApplications(100);
      if (!inventory.applications.some((app) => app.id === appId)) {
        throw new DesktopUiError("TARGET_NOT_FOUND", "Bundle identifier was not found exactly once in fresh installed application discovery.");
      }
      await runner.run({ executable: OPEN, args: ["-b", appId], timeoutMs: 10_000 });
      return { launched: true, appId };
    },
    focusExact: lifecycle.focusExact,
    closeExact: lifecycle.closeExact,
    waitUntilClosed: lifecycle.waitUntilClosed,
  };
}
