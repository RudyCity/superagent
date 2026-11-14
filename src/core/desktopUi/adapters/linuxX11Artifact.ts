/**
 * Linux X11 active-window worker is a fixed, checksum-verified Python source
 * bundled with Core. No user-supplied script path and no X11/Wayland fallback.
 */
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DesktopUiError } from "../errors.js";

export const X11_HELPER_BACKEND = "linux-x11-verified-active-window";

export function resolveLinuxX11ArtifactDirectory(modulePath: string): string {
  const adapter = path.dirname(modulePath);
  if (path.basename(adapter) !== "adapters" ||
      path.basename(path.dirname(adapter)) !== "desktopUi" ||
      path.basename(path.dirname(path.dirname(adapter))) !== "core") {
    throw new DesktopUiError("SCREENSHOT_UNAVAILABLE", "Unknown X11 worker module layout.");
  }
  const parent = path.resolve(adapter, "../../..");
  if (path.basename(parent) === "dist") return path.join(parent,"native","desktop-live-x11");
  if (path.basename(parent) === "src")
    return path.join(path.dirname(parent),"dist","native","desktop-live-x11");
  throw new DesktopUiError("SCREENSHOT_UNAVAILABLE", "Unsupported Linux X11 bundle layout.");
}

export function verifyLinuxX11ArtifactPair(script: string, receipt: string): string | null {
  // Read through an opened file descriptor, never through a pathname after
  // lstat: a local rename must not turn a checked regular file into a symlink.
  const regular = (name: string): Buffer | null => {
    try {
      const stat = lstatSync(name);
      if (!stat.isFile() || stat.isSymbolicLink())
        throw new DesktopUiError("SCREENSHOT_UNAVAILABLE", "Linux X11 worker must be a regular file.");
      const fd = openSync(name, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const opened = fstatSync(fd);
        if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino)
          throw new DesktopUiError("SCREENSHOT_UNAVAILABLE", "Linux X11 worker changed during verification.");
        return readFileSync(fd);
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  };
  const file = regular(script);
  const hash = regular(receipt);
  if (!file && !hash) return null;
  if (!file || !hash || file.length < 2000 || file.length > 120_000 ||
      hash.length < 64 || hash.length > 80) {
    throw new DesktopUiError("SCREENSHOT_UNAVAILABLE", "Incomplete Linux X11 worker bundle.");
  }
  const expected = hash.toString("ascii").trim();
  if (!/^[a-f0-9]{64}$/.test(expected)) {
    throw new DesktopUiError("SCREENSHOT_UNAVAILABLE", "Invalid Linux X11 checksum receipt.");
  }
  if (!file.toString("utf8",0,35).startsWith("#!/usr/bin/env python3\n")) {
    throw new DesktopUiError("SCREENSHOT_UNAVAILABLE", "Linux X11 worker header invalid.");
  }
  if (createHash("sha256").update(file).digest("hex") !== expected) {
    throw new DesktopUiError("SCREENSHOT_UNAVAILABLE", "Linux X11 worker checksum mismatch.");
  }
  return script;
}

export function locateVerifiedLinuxX11Helper(): string | null {
  if (process.platform !== "linux" || process.arch !== "x64") return null;
  const dir = resolveLinuxX11ArtifactDirectory(fileURLToPath(import.meta.url));
  return verifyLinuxX11ArtifactPair(
    path.join(dir,"linuxCapture.py"),
    path.join(dir,"linuxCapture.sha256"),
  );
}
