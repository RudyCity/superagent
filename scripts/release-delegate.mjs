#!/usr/bin/env node
/**
 * Deterministic, source-only Chrome Delegate release bundle.
 * No credentials, private Chrome profile data, docs, tests or workspaces.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = path.join(root, "chrome-extension-delegate");
const manifest = JSON.parse(fs.readFileSync(path.join(sourceDir, "manifest.json"), "utf8"));
const version = manifest.version;
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error("Delegate extension version is not semver");
}
if (manifest.manifest_version !== 3 ||
    manifest.background?.service_worker !== "background.js" ||
    manifest.action?.default_popup !== "popup.html") {
  throw new Error("Unexpected Delegate extension manifest structure");
}
if (!Array.isArray(manifest.content_scripts) ||
    manifest.content_scripts.length !== 1 ||
    JSON.stringify(manifest.content_scripts[0].matches) !== JSON.stringify(["https://chatgpt.com/*"])) {
  throw new Error("Release must only inject into chatgpt.com");
}

const files = [
  "manifest.json", "background.js", "tabSingleton.js", "content.js",
  "cdpPolicy.js", "cdpBridge.js", "popup.html", "popup.css", "popup.js",
].sort();
const checksum = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const zip = new JSZip();
const fileHashes = {};
for (const name of files) {
  const bytes = fs.readFileSync(path.join(sourceDir, name));
  if (!bytes.length) throw new Error("Empty extension file: " + name);
  fileHashes[name] = checksum(bytes);
  zip.file(name, bytes, {
    date: new Date("1980-01-01T00:00:00.000Z"),
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
    createFolders: false,
    unixPermissions: 0o644,
  });
}
const archiveBytes = await zip.generateAsync({
  type: "nodebuffer",
  compression: "DEFLATE",
  compressionOptions: { level: 9 },
  platform: "UNIX",
  streamFiles: false,
});
const loaded = await JSZip.loadAsync(archiveBytes);
const archiveNames = Object.keys(loaded.files).sort();
if (JSON.stringify(archiveNames) !== JSON.stringify(files)) {
  throw new Error("Unexpected packaged entries");
}
for (const name of files) {
  const extracted = await loaded.file(name)?.async("nodebuffer");
  if (!extracted || checksum(extracted) !== fileHashes[name]) {
    throw new Error("Zip roundtrip integrity failed: " + name);
  }
}
const releaseDir = path.join(root, "build", "releases");
fs.mkdirSync(releaseDir, { recursive: true });
const archivePath = path.join(releaseDir, `superagent-delegate-${version}.zip`);
fs.writeFileSync(archivePath, archiveBytes);
const receiptPath = path.join(releaseDir, `superagent-delegate-${version}.receipt.json`);
fs.writeFileSync(receiptPath, JSON.stringify({
  component: "SuperAgent Delegate (ChatGPT)",
  version,
  archive: path.basename(archivePath),
  sha256: checksum(archiveBytes),
  packagedFiles: fileHashes,
  scope: "chrome-extension-delegate only; no secrets or user data",
  note: "Package integrity does not itself certify a production deployment.",
}, null, 2) + "\n");
console.log(JSON.stringify({
  version,
  archivePath,
  receiptPath,
  sha256: checksum(archiveBytes),
  files: archiveNames,
  byteCount: archiveBytes.length,
  integrity: "PASS",
}, null, 2));
