/**
 * Version-addressed, immutable-by-contract MCP backend candidates.
 *
 * The live owner/tunnel is never restarted or pointed at an arbitrary path.
 * Release tooling must stage a complete standalone tree into the configured
 * private release directory before an operator requests a rollout.
 */
import fs from "node:fs";
import path from "node:path";
import { getRootConfigDir } from "../config/paths.js";
import { inspectCoreBuild } from "./coreBuildIdentity.js";

const DIGEST = /^[a-f0-9]{64}$/;

function assertDirectory(file: string): void {
  const stat = fs.lstatSync(file);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("MCP_BACKEND_RELEASE_UNSAFE_DIRECTORY");
}
function assertFile(file: string): void {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
    throw new Error("MCP_BACKEND_RELEASE_UNSAFE_FILE");
}
export function backendReleaseDirectory(digest: string, configDir = getRootConfigDir()): string {
  if (!DIGEST.test(digest)) throw new Error("MCP_BACKEND_RELEASE_INVALID_DIGEST");
  return path.join(path.resolve(configDir), "mcp-backend-releases", digest);
}
export type VerifiedMcpBackendRelease = {
  digest: string; entry: string; fileCount: number;
};
/**
 * Validate a *previously staged* full distribution. This function does not
 * download, install, overwrite or mutate the current running release.
 */
export function verifyMcpBackendRelease(
  digest: string, configDir = getRootConfigDir(),
): VerifiedMcpBackendRelease {
  const base = path.resolve(configDir);
  const releases = path.join(base, "mcp-backend-releases");
  const directory = backendReleaseDirectory(digest, base);
  try {
    assertDirectory(base);
    assertDirectory(releases);
    assertDirectory(directory);
    assertDirectory(path.join(directory, "dist"));
    assertFile(path.join(directory, "package.json"));
    const entry = path.join(directory, "dist", "cli.js");
    assertFile(entry);
    const build = inspectCoreBuild(entry, {requireFreshCompiled:true});
    if (build.mode !== "compiled" || build.digest !== digest ||
        !Number.isSafeInteger(build.fileCount) || build.fileCount < 1)
      throw new Error("MCP_BACKEND_RELEASE_DIGEST_MISMATCH");
    return {digest, entry, fileCount:build.fileCount};
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("MCP_BACKEND_RELEASE_"))
      throw error;
    throw new Error("MCP_BACKEND_RELEASE_UNVERIFIED");
  }
}
