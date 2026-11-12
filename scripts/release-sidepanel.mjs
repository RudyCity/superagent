#!/usr/bin/env node
/**
 * Build a deterministic, source-only Chrome SidePanel extension ZIP for releases.
 * The source CSS is not included; only the precompiled sidepanel.css is shipped.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(root, "chrome-extension");
const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
if (manifest.manifest_version !== 3 ||
    manifest.background?.service_worker !== "background.js" ||
    manifest.side_panel?.default_path !== "sidepanel.html" ||
    !/^\d+\.\d+\.\d+$/.test(manifest.version)) {
  throw new Error("Unexpected Chrome SidePanel manifest or version");
}
const files = fs.readdirSync(dir, { withFileTypes: true })
  .filter(entry => entry.isFile() && /\.(?:js|html|css|json)$/.test(entry.name))
  .map(entry => entry.name)
  .filter(name => name !== "sidepanel.src.css")
  .concat(["icons/icon16.png", "icons/icon48.png", "icons/icon128.png"])
  .sort();
const required = ["manifest.json", "background.js", "content.js", "main-world.js",
  "sidepanel.html", "sidepanel.js", "sidepanel.css", "icons/icon16.png",
  "icons/icon48.png", "icons/icon128.png"];
for (const name of required) if (!files.includes(name)) throw new Error("Missing SidePanel runtime asset " + name);
if (files.some(name => /secret|token|\.env|\.map$|readme/i.test(name))) throw new Error("Unapproved SidePanel asset");

const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const zip = new JSZip();
const hashes = {};
for (const name of files) {
  const bytes = fs.readFileSync(path.join(dir, name));
  if (!bytes.length) throw new Error("Empty SidePanel asset: " + name);
  hashes[name] = digest(bytes);
  zip.file(name, bytes, { date: new Date("1980-01-01T00:00:00.000Z"),
    compression: "DEFLATE", compressionOptions: { level: 9 },
    createFolders: false, unixPermissions: 0o644 });
}
const html = fs.readFileSync(path.join(dir, "sidepanel.html"), "utf8");
for (const match of html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)) {
  const name = match[1];
  if (/^https?:\/\//.test(name)) continue;
  if (!files.includes(name)) throw new Error("HTML asset missing from extension ZIP: " + name);
}
const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE",
  compressionOptions: { level: 9 }, platform: "UNIX", streamFiles: false });
const loaded = await JSZip.loadAsync(bytes);
if (JSON.stringify(Object.keys(loaded.files).sort()) !== JSON.stringify(files)) {
  throw new Error("SidePanel ZIP includes unexpected or missing files");
}
for (const name of files) {
  const extracted = await loaded.file(name)?.async("nodebuffer");
  if (!extracted || digest(extracted) !== hashes[name]) throw new Error("SidePanel ZIP integrity failure: " + name);
}
const out = path.join(root, "build", "releases");
fs.mkdirSync(out, { recursive: true });
const filename = `superagent-sidepanel-${manifest.version}.zip`;
fs.writeFileSync(path.join(out, filename), bytes);
fs.writeFileSync(path.join(out, `superagent-sidepanel-${manifest.version}.receipt.json`),
  JSON.stringify({ component: "SuperAgent Chrome SidePanel", version: manifest.version,
    archive: filename, sha256: digest(bytes), packagedFiles: hashes,
    scope: "Chrome SidePanel extension; no personal data or secrets",
    note: "Source ZIP for developer-mode installation; not a Chrome Web Store publication." }, null, 2) + "\n");
console.log(JSON.stringify({ component: "sidepanel", version: manifest.version,
  archive: filename, bytes: bytes.length, sha256: digest(bytes), files: files.length,
  integrity: "PASS" }));
