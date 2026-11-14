/**
 * Verify Desktop Live WGC using the bundled Bun and the installed compiled
 * Core module. Run by verify-installed-wgc.ps1 only on a disposable CI runner.
 * No capture, no Core/Tray start, no arbitrary JS execution from CLI input.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { lstatSync } from "node:fs";

const [root, ...extra] = process.argv.slice(2);
if (!root || extra.length || !path.isAbsolute(root)) {
  throw new Error("Expected one absolute installed application root.");
}
const coreModule = path.join(root, "standalone", "dist", "core", "desktopUi",
  "adapters", "windowsWgcArtifact.js");
const moduleStat = lstatSync(coreModule);
if (!moduleStat.isFile() || moduleStat.isSymbolicLink()) {
  throw new Error("Installed Core WGC module is not a regular file.");
}
const expected = path.join(root, "standalone", "dist", "native", "desktop-live-wgc", "wgc.exe");
const installed = await import(pathToFileURL(coreModule).href);
const verified = installed.locateVerifiedWindowsWgcHelper();
if (!verified || verified !== expected) {
  throw new Error("Installed WGC path or integrity mismatch.");
}
console.log("INSTALLED_WGC_INTEGRITY_PASS");
