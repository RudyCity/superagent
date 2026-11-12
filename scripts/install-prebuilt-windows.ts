/**
 * Acquire an official, checksummed prebuilt Windows SuperAgent Tray + Core installer.
 * No Rust/MSVC toolchain or local native build is performed.
 *
 * bun scripts/install-prebuilt-windows.ts --check
 * bun scripts/install-prebuilt-windows.ts --download [--allow-version-mismatch]
 * bun scripts/install-prebuilt-windows.ts --install [--allow-version-mismatch]
 */
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { finished } from "node:stream/promises";

const REPOSITORY = "RudyCity/superagent";
const RELEASES_API = "https://api.github.com/repos/RudyCity/superagent/releases?per_page=30";
const MAX_SETUP_SIZE = 650 * 1024 * 1024;
const MAX_CHECKSUM_SIZE = 32 * 1024;

export interface ReleaseAsset {
  name: string;
  size: number;
  browser_download_url: string;
}
export interface ReleaseInfo {
  tag_name: string;
  draft: boolean;
  assets?: ReleaseAsset[];
}
export interface InstallerCandidate {
  release: ReleaseInfo;
  version: string;
  installer: ReleaseAsset;
  checksums: ReleaseAsset;
}

export function selectInstaller(releases: ReleaseInfo[], requestedTag?: string): InstallerCandidate {
  if (!Array.isArray(releases)) throw new Error("GitHub Releases response was not a list");
  if (requestedTag && !/^v\d+\.\d+\.\d+-(?:rc|windows)\.\d+$/.test(requestedTag)) {
    throw new Error("Invalid release tag. Expected vX.Y.Z-rc.N or vX.Y.Z-windows.N");
  }
  for (const release of releases) {
    if (release.draft || typeof release.tag_name !== "string") continue;
    if (requestedTag && release.tag_name !== requestedTag) continue;
    const match = /^v(\d+\.\d+\.\d+)-(?:rc|windows)\.\d+$/.exec(release.tag_name);
    if (!match || !Array.isArray(release.assets)) continue;
    const name = `SuperAgent_${match[1]}_x64-setup.exe`;
    const installer = release.assets.find(asset => asset.name === name);
    const checksums = release.assets.find(asset => asset.name === "SHA256SUMS.txt");
    if (!installer || !checksums || !Number.isSafeInteger(installer.size) ||
        installer.size < 20_000_000 || installer.size > MAX_SETUP_SIZE) continue;
    return { release, version: match[1], installer, checksums };
  }
  throw new Error(requestedTag
    ? `No published, checksummed Windows standalone installer for ${requestedTag}`
    : "No published, checksummed Windows standalone installer exists in the latest 30 releases");
}

export function validateAssetUrl(candidate: InstallerCandidate, asset: ReleaseAsset): string {
  const expected = `/${REPOSITORY}/releases/download/${candidate.release.tag_name}/${asset.name}`;
  const url = new URL(asset.browser_download_url);
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port ||
      url.pathname !== expected || url.search || url.hash) {
    throw new Error(`Rejected unexpected release asset URL for ${asset.name}`);
  }
  return url.href;
}

export function checksumForFilename(manifest: string, filename: string): string {
  const matches: string[] = [];
  for (const line of manifest.split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line.trim());
    if (match && match[2].trim() === filename) matches.push(match[1].toLowerCase());
  }
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one SHA-256 checksum for ${filename}; got ${matches.length}`);
  }
  return matches[0];
}

async function getResponse(url: string, timeoutMs: number): Promise<Response> {
  const response = await fetch(url, {
    headers: { "User-Agent": "SuperAgent-verified-installer", "Accept": "application/vnd.github+json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok || !response.body) throw new Error(`Download failed (HTTP ${response.status})`);
  return response;
}

async function getSmallText(url: string, maxBytes: number): Promise<string> {
  const response = await getResponse(url, 20_000);
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.byteLength;
    if (length > maxBytes) throw new Error("Release metadata exceeds permitted size");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function downloadVerified(url: string, destination: string, expectedHash: string, expectedSize: number): Promise<void> {
  const folder = path.dirname(destination);
  mkdirSync(folder, { recursive: true });
  if (existsSync(destination)) {
    const existingHash = createHash("sha256");
    for await (const chunk of createReadStream(destination)) existingHash.update(chunk);
    const digest = existingHash.digest("hex");
    if (digest !== expectedHash || statSync(destination).size !== expectedSize) {
      throw new Error(`An existing file has a mismatched checksum: ${destination}. Move it aside manually before retrying.`);
    }
    console.log("Existing installer checksum verified:", destination);
    return;
  }
  const temporary = destination + "." + randomBytes(8).toString("hex") + ".partial";
  const hash = createHash("sha256");
  let size = 0;
  let lastProgress = 0;
  const output = createWriteStream(temporary, { flags: "wx", mode: 0o600 });
  try {
    const response = await getResponse(url, 300_000);
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > MAX_SETUP_SIZE || size > expectedSize) throw new Error("Installer download size exceeded verified release metadata");
      hash.update(chunk);
      if (!output.write(chunk)) await once(output, "drain");
      if (size - lastProgress >= 10 * 1024 * 1024) {
        console.log(`Downloading verified installer: ${Math.floor((size / expectedSize) * 100)}%`);
        lastProgress = size;
      }
    }
    output.end();
    await finished(output);
    if (size !== expectedSize || hash.digest("hex") !== expectedHash) {
      throw new Error("Installer SHA-256 / size mismatch. Refusing to install.");
    }
    renameSync(temporary, destination);
  } finally {
    output.destroy();
    if (existsSync(temporary)) rmSync(temporary, { force: true });
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const allowed = new Set(["--check", "--download", "--install", "--allow-version-mismatch"]);
  if (args.some(arg => !allowed.has(arg) && !arg.startsWith("--tag="))) {
    throw new Error("Usage: --check | --download | --install [--tag=vX.Y.Z-rc.N|vX.Y.Z-windows.N] [--allow-version-mismatch]");
  }
  const actions = ["--check", "--download", "--install"].filter(arg => args.includes(arg));
  if (actions.length !== 1) throw new Error("Specify exactly one: --check, --download, or --install");
  const requestedTag = args.find(arg => arg.startsWith("--tag="))?.slice(6);
  if (args.filter(arg => arg.startsWith("--tag=")).length > 1) throw new Error("Specify --tag only once");
  if (!args.includes("--check") && process.platform !== "win32") {
    throw new Error("Windows installer downloads and installation require a Windows x64 host");
  }
  if (process.platform === "win32" && process.arch !== "x64") throw new Error("The released installer supports Windows x64 only");

  const sourceVersion = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version as string;
  const list = JSON.parse(await getSmallText(RELEASES_API, 3_000_000)) as ReleaseInfo[];
  const chosen = selectInstaller(list, requestedTag);
  const assetUrl = validateAssetUrl(chosen, chosen.installer);
  const sumUrl = validateAssetUrl(chosen, chosen.checksums);
  if (chosen.checksums.size > MAX_CHECKSUM_SIZE) throw new Error("Checksum manifest exceeds size limit");
  const expectedHash = checksumForFilename(await getSmallText(sumUrl, MAX_CHECKSUM_SIZE), chosen.installer.name);
  const isMatch = chosen.version === sourceVersion;
  console.log(`Published standalone Windows: ${chosen.release.tag_name}`);
  console.log(`Checked-out source version: ${sourceVersion}`);
  console.log(`SHA-256: ${expectedHash}`);
  console.log("Source/release version:", isMatch ? "MATCH" : "DIFFERENT");
  if (args.includes("--check")) {
    console.log("No downloads or installations performed. This distribution runs without MSVC or Rust on the target PC.");
    return;
  }
  if (!isMatch && !args.includes("--allow-version-mismatch")) {
    throw new Error("The latest published installer does not match this source checkout. Refusing an implicit downgrade. Use --allow-version-mismatch only if an older prebuilt release is acceptable.");
  }
  const destination = path.join(homedir(), "Downloads", "SuperAgent", chosen.installer.name);
  await downloadVerified(assetUrl, destination, expectedHash, chosen.installer.size);
  console.log("Verified Windows installer:", destination);
  if (args.includes("--install")) {
    console.log("Launching reviewed installer on operator request. No compiler or development toolchain is used.");
    const result = spawnSync(destination, [], { stdio: "inherit", windowsHide: false, timeout: 15 * 60_000 });
    if (result.error || (result.status !== 0 && result.status !== 3010)) {
      throw new Error(`Installer failed: ${result.error?.message ?? `exit ${result.status}, signal ${result.signal}`}`);
    }
    console.log("Installer exited:", result.status);
  }
}

if (import.meta.main) {
  main().catch(error => {
    console.error("SuperAgent prebuilt install blocked:", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
