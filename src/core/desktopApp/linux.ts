import type { Dirent } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DesktopUiError } from "../desktopUi/errors.js";
import { createRestrictedProcessRunner, type DesktopProcessRunner } from "../desktopUi/processRunner.js";
import type { DesktopAppLifecycleProvider, InstalledApplication } from "./types.js";
import { createLinuxWindowLifecycle } from "./linuxWindow.js";

const GTK_LAUNCH = "/usr/bin/gtk-launch";
const APP_DIRECTORIES = [
  "/usr/share/applications",
  "/usr/local/share/applications",
  path.join(os.homedir(), ".local", "share", "applications"),
];
const DESKTOP_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

export interface LinuxAppProviderOptions {
  runner?: DesktopProcessRunner;
  scanEntries?: () => Promise<Array<{ fileName: string; contents: string }>>;
}

async function systemEntries(): Promise<Array<{ fileName: string; contents: string }>> {
  const result: Array<{ fileName: string; contents: string }> = [];
  for (const root of APP_DIRECTORIES) {
    let entries: Dirent<string>[];
    try {
      entries = await readdir(root, { withFileTypes: true, encoding: "utf8" });
    } catch {
      continue;
    }
    for (const entry of entries.slice(0, 300)) {
      if (!entry.isFile() || !entry.name.endsWith(".desktop")) continue;
      const file = path.join(root, entry.name);
      try {
        if ((await stat(file)).size > 64 * 1024) continue;
        result.push({ fileName: entry.name, contents: await readFile(file, "utf8") });
      } catch {
        continue;
      }
    }
  }
  return result;
}

function desktopEntryName(contents: string): string | null {
  let inEntry = false;
  const properties = new Map<string, string>();
  for (const line of contents.split(/\r?\n/).slice(0, 1000)) {
    const text = line.trim();
    if (text.startsWith("[") && text.endsWith("]")) {
      inEntry = text === "[Desktop Entry]";
      continue;
    }
    if (!inEntry || !text || text.startsWith("#")) continue;
    const pivot = text.indexOf("=");
    if (pivot <= 0) continue;
    properties.set(text.slice(0, pivot).trim(), text.slice(pivot + 1).trim());
  }
  if (properties.get("Type") !== "Application" ||
    properties.get("NoDisplay") === "true" ||
    properties.get("Hidden") === "true") return null;
  const name = properties.get("Name");
  if (!name || name.length > 256 || /[\u0000-\u001f\u007f]/.test(name)) return null;
  return name;
}

export function createLinuxDesktopAppProvider(options: LinuxAppProviderOptions = {}): DesktopAppLifecycleProvider {
  const runner = options.runner ?? createRestrictedProcessRunner([GTK_LAUNCH]);
  const scan = options.scanEntries ?? systemEntries;
  const lifecycle = createLinuxWindowLifecycle({ runner: options.runner });

  const listApplications = async (limit: number) => {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new DesktopUiError("INVALID_ACTION", "Application inventory limit must be an integer from 1 to 100.");
    }
    const found = new Map<string, InstalledApplication>();
    const duplicate = new Set<string>();
    for (const entry of (await scan()).slice(0, 900)) {
      if (!entry.fileName.endsWith(".desktop")) continue;
      const id = entry.fileName.slice(0, -8);
      if (!DESKTOP_ID.test(id)) continue;
      const name = desktopEntryName(entry.contents);
      if (!name) continue;
      if (found.has(id)) {
        duplicate.add(id);
        continue;
      }
      found.set(id, { id, name, platform: "linux", launchKind: "linux-desktop-entry" });
    }
    for (const id of duplicate) found.delete(id);
    const applications = [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
    return { applications: applications.slice(0, limit), truncated: applications.length > limit };
  };

  return {
    listApplications,
    async launchVerified(appId) {
      if (typeof appId !== "string" || !DESKTOP_ID.test(appId)) {
        throw new DesktopUiError("INVALID_ACTION", "Linux appId must be an exact desktop entry ID.");
      }
      const inventory = await listApplications(100);
      if (!inventory.applications.some((app) => app.id === appId)) {
        throw new DesktopUiError("TARGET_NOT_FOUND", "Desktop entry absent or ambiguous in fresh inventory.");
      }
      await runner.run({ executable: GTK_LAUNCH, args: [appId], timeoutMs: 10_000 });
      return { launched: true, appId };
    },
    focusExact: lifecycle.focusExact,
    closeExact: lifecycle.closeExact,
    waitUntilClosed: lifecycle.waitUntilClosed,
  };
}
