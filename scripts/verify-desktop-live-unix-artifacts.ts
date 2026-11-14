#!/usr/bin/env bun
/**
 * Read-only Desktop Live release audit. Verifies the built helper, generated
 * standalone staging and (optionally) an extracted DEB/AppImage/DMG payload.
 * An extraction is not sufficient: the packaged helper must be byte-identical
 * to the verified helper built by the current CI job.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { verifyMacSckArtifactPair } from "../src/core/desktopUi/adapters/macSckArtifact.js";
import { verifyLinuxX11ArtifactPair } from "../src/core/desktopUi/adapters/linuxX11Artifact.js";

export type UnixDesktopLivePlatform = "darwin" | "linux";

type ArtifactLayout = {
  directory: string;
  payload: string;
  receipt: string;
  target: string;
  arch: string;
};
const layouts: Record<UnixDesktopLivePlatform, ArtifactLayout> = {
  darwin: {
    directory: "desktop-live-sck", payload: "sck", receipt: "sck.sha256",
    target: "aarch64-apple-darwin", arch: "arm64",
  },
  linux: {
    directory: "desktop-live-x11", payload: "linuxCapture.py", receipt: "linuxCapture.sha256",
    target: "x86_64-unknown-linux-gnu", arch: "x64",
  },
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error("[desktop-live-unix-audit] " + message);
}

function regularDirectory(directory: string): void {
  const stat = fs.lstatSync(directory);
  assert(stat.isDirectory() && !stat.isSymbolicLink(), "Unexpected symlink or non-directory: " + directory);
}

function checksum(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function verifiedPair(directory: string, platform: UnixDesktopLivePlatform): string {
  const { payload, receipt } = layouts[platform];
  const binary = path.join(directory, payload);
  const hashFile = path.join(directory, receipt);
  const verified = platform === "darwin"
    ? verifyMacSckArtifactPair(binary, hashFile)
    : verifyLinuxX11ArtifactPair(binary, hashFile);
  assert(verified === binary, "Missing checksum-pinned " + platform + " Desktop Live helper: " + directory);
  return checksum(binary);
}

/** Verify a helper built from the current repo; never mutate build outputs. */
export function verifyBuiltUnixDesktopLiveHelper(repo: string, platform: UnixDesktopLivePlatform): string {
  const layout = layouts[platform];
  const dist = path.join(repo, "dist");
  const native = path.join(dist, "native");
  const dir = path.join(native, layout.directory);
  for (const directory of [repo, dist, native, dir]) regularDirectory(directory);
  const hash = verifiedPair(dir, platform);
  if (platform === "linux") {
    const source = path.join(repo, "native", "desktop-live-x11", "linuxCapture.py");
    assert(fs.lstatSync(source).isFile() && !fs.lstatSync(source).isSymbolicLink(),
      "Linux source helper is not a regular file");
    assert(checksum(source) === hash, "Linux X11 artifact does not match checkout source");
  }
  return hash;
}

/**
 * Audit one standalone tree, either local staging or discovered in an extracted
 * installer. No extraction, writes, network access or process execution.
 */
export function verifyUnixDesktopLiveTree(
  repo: string, standalone: string, platform: UnixDesktopLivePlatform,
): string {
  const layout = layouts[platform];
  const expectedHash = verifyBuiltUnixDesktopLiveHelper(repo, platform);
  const dist = path.join(standalone, "dist");
  const native = path.join(dist, "native");
  const artifact = path.join(native, layout.directory);
  for (const directory of [standalone, dist, native, artifact]) regularDirectory(directory);
  const manifestPath = path.join(standalone, "standalone-manifest.json");
  const manifestStat = fs.lstatSync(manifestPath);
  assert(manifestStat.isFile() && !manifestStat.isSymbolicLink(), "Standalone manifest is not a regular file");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert(manifest.platform === platform && manifest.arch === layout.arch &&
    manifest.target === layout.target && manifest.bunVersion === "1.4.2" &&
    manifest.entrypoint === "standalone/dist/cli.js",
    "Standalone target / platform / entrypoint manifest mismatch");
  const builtVersion = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8")).version;
  assert(manifest.version === builtVersion, "Packaged version does not match checkout");
  const cli = path.join(dist, "cli.js");
  assert(fs.lstatSync(cli).isFile() && !fs.lstatSync(cli).isSymbolicLink(), "Standalone CLI entrypoint missing");
  const packagedHash = verifiedPair(artifact, platform);
  assert(packagedHash === expectedHash,
    "Packaged Desktop Live helper differs from this CI run's built helper");
  return packagedHash;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const platform = process.argv[2];
  const repo = path.resolve(import.meta.dir, "..");
  const standalone = process.argv[3] ? path.resolve(process.argv[3]) :
    path.join(repo, "apps", "superagent-tray", "src-tauri", "resources", "standalone");
  assert(platform === "darwin" || platform === "linux",
    "Usage: bun scripts/verify-desktop-live-unix-artifacts.ts <darwin|linux> [extracted-standalone-root]");
  assert(process.platform === platform && process.arch === layouts[platform].arch,
    "Run the native artifact audit on the matching macOS arm64 / Linux x64 runner");
  console.log("DESKTOP_LIVE_UNIX_ARTIFACT_PASS", platform,
    verifyUnixDesktopLiveTree(repo, standalone, platform), standalone);
}
