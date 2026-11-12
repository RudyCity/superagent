#!/usr/bin/env node
/** Validate the exact two Chrome extension artifacts before publishing. */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releases = path.join(root, "build", "releases");
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
for (const [kind, source, label] of [
  ["delegate", "chrome-extension-delegate", "SuperAgent Delegate (ChatGPT)"],
  ["sidepanel", "chrome-extension", "SuperAgent Chrome SidePanel"],
]) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, source, "manifest.json"), "utf8"));
  const stem = `superagent-${kind}-${manifest.version}`;
  const receipt = JSON.parse(fs.readFileSync(path.join(releases, stem + ".receipt.json"), "utf8"));
  const archive = fs.readFileSync(path.join(releases, stem + ".zip"));
  if (receipt.component !== label || receipt.version !== manifest.version ||
      receipt.archive !== stem + ".zip" || receipt.sha256 !== hash(archive)) {
    throw new Error(`Release receipt mismatch: ${stem}`);
  }
  const zip = await JSZip.loadAsync(archive);
  const names = Object.keys(zip.files).sort();
  if (JSON.stringify(names) !== JSON.stringify(Object.keys(receipt.packagedFiles).sort())) {
    throw new Error(`Unexpected archive entries: ${stem}`);
  }
  for (const name of names) {
    if (name.includes("..") || name.startsWith("/") || zip.files[name].dir) {
      throw new Error(`Unexpected ZIP path: ${name}`);
    }
    const bytes = await zip.files[name].async("nodebuffer");
    if (hash(bytes) !== receipt.packagedFiles[name] ||
        !fs.existsSync(path.join(root, source, name)) ||
        hash(fs.readFileSync(path.join(root, source, name))) !== hash(bytes)) {
      throw new Error(`Extension source or checksum mismatch: ${stem}/${name}`);
    }
  }
  const inside = JSON.parse(await zip.file("manifest.json")?.async("string") ?? "null");
  if (inside.manifest_version !== 3 || inside.version !== manifest.version) {
    throw new Error(`Malformed packaged MV3 manifest: ${stem}`);
  }
  console.log("EXTENSION_RELEASE_VERIFIED", stem, names.length, "files", archive.length, "bytes");
}
