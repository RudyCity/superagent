#!/usr/bin/env node
/**
 * Stage only the current, manifest-pinned Chrome extension archives for a release.
 * Historical artifacts in build/releases must never leak into the published ZIP set.
 * No source files are changed, and existing output is never silently overwritten.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "build", "releases");
const destination = path.join(root, "build", "release-extension-upload");
fs.mkdirSync(destination, { recursive: true });
if (fs.readdirSync(destination).length) {
  throw new Error("Release staging directory must be empty; refusing to mix old artifacts");
}
const expected = [];
for (const [kind, dir] of [
  ["delegate", "chrome-extension-delegate"],
  ["sidepanel", "chrome-extension"],
]) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, dir, "manifest.json"), "utf8"));
  if (manifest.manifest_version !== 3 || !/^\d+\.\d+\.\d+$/.test(manifest.version)) {
    throw new Error("Invalid Chrome extension version: " + kind);
  }
  for (const suffix of ["zip", "receipt.json"]) {
    const name = `superagent-${kind}-${manifest.version}.${suffix}`;
    const input = path.join(source, name);
    if (!fs.statSync(input).isFile()) throw new Error("Not a release file: " + input);
    fs.copyFileSync(input, path.join(destination, name), fs.constants.COPYFILE_EXCL);
    expected.push(name);
  }
}
if (JSON.stringify(fs.readdirSync(destination).sort()) !== JSON.stringify(expected.sort())) {
  throw new Error("Extension release staging mismatch");
}
console.log("EXTENSION_RELEASE_STAGE_OK", expected.join(", "));
