/** Bounded, local evidence for CLI Bridge artifact-producing delegations.
 * An exit code of zero is not a verified task completion.
 * Never follow a symlink outside the registered caller workspace.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { cliArtifactPathVisibleToWorkspace } from "./cliBridgeWorkspaceScope.js";

export const MAX_DELEGATE_ARTIFACTS = 12;
export const MAX_DELEGATE_ARTIFACT_BYTES = 10 * 1024 * 1024;

export type ArtifactEvidenceState = "created" | "updated" | "unchanged" | "missing" | "invalid" | "too_large";
export interface ArtifactEvidence {
  path: string;
  state: ArtifactEvidenceState;
  bytes?: number;
  sha256?: string;
}
export interface ArtifactBaseline {
  path: string;
  /** null indicates that the file did not exist when delegation began. */
  sha256: string | null;
}
function within(base: string, candidate: string): boolean {
  const relative = path.relative(base, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/**
 * Called before process launch.
 *
 * expectedArtifacts remains cwd-relative for backwards compatibility. When the
 * delegated cwd is a descendant of the workspace root, callers may also pass
 * the same artifact using its workspace-prefixed form, e.g.:
 *
 *   cwd:               <workspace>/apps/foo
 *   expectedArtifacts: apps/foo/output.json
 *
 * The workspace-prefixed form is accepted only when it resolves back inside
 * the delegated cwd; it cannot be used to claim sibling workspace files.
 */
export function resolveExpectedArtifacts(cwd: string, workspace: string, paths: string[] | undefined): string[] {
  if (paths === undefined) return [];
  if (!Array.isArray(paths) || paths.length < 1 || paths.length > MAX_DELEGATE_ARTIFACTS) {
    throw new Error(`expectedArtifacts requires 1 to ${MAX_DELEGATE_ARTIFACTS} relative file paths.`);
  }

  const base = fsSync.realpathSync(cwd);
  const workspaceBase = fsSync.realpathSync(workspace);
  if (!within(workspaceBase, base)) {
    throw new Error("Delegated working directory is outside the authorized workspace.");
  }

  const cwdFromWorkspace = path.relative(workspaceBase, base);
  const cwdPrefix = cwdFromWorkspace === "" ? "" : path.normalize(cwdFromWorkspace) + path.sep;
  const seen = new Set<string>();

  return paths.map(request => {
    if (typeof request !== "string" || !request.trim() || request.length > 240 || path.isAbsolute(request) || request.includes("\0")) {
      throw new Error("expectedArtifacts must contain nonempty, relative file paths (max 240 characters).");
    }

    const normalizedRequest = path.normalize(request);
    const workspacePrefixed =
      cwdPrefix !== "" &&
      (normalizedRequest === path.normalize(cwdFromWorkspace) || normalizedRequest.startsWith(cwdPrefix));

    const file = workspacePrefixed
      ? path.resolve(workspaceBase, normalizedRequest)
      : path.resolve(base, normalizedRequest);

    if (!within(base, file) || !cliArtifactPathVisibleToWorkspace(file, workspaceBase)) {
      throw new Error("Expected artifact path is outside the authorized delegated working directory.");
    }
    if (fsSync.existsSync(file) && !fsSync.lstatSync(file).isFile()) {
      throw new Error("Expected artifact must be a regular file, not a directory or symlink.");
    }
    const identity = artifactClaimIdentity(file);
    if (seen.has(identity)) throw new Error("Duplicate expected artifact path (including aliases).");
    seen.add(identity);
    return file;
  });
}

/** Canonical claim key even when two in-workspace symlink parents name one file. */
export function artifactClaimIdentity(file: string): string {
  let ancestor = path.resolve(file);
  while (true) {
    try {
      fsSync.lstatSync(ancestor);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw new Error("Cannot resolve artifact claim parent.");
      ancestor = parent;
    }
  }
  const canonical = path.resolve(fsSync.realpathSync(ancestor), path.relative(ancestor, file));
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

async function fingerprint(file: string, workspace: string): Promise<{ sha256: string; bytes: number } | "missing" | "invalid" | "too_large"> {
  if (!cliArtifactPathVisibleToWorkspace(file, workspace)) return "invalid";
  let stat;
  try {
    // lstat, not stat: a file symlink does not count as a produced artifact.
    stat = await fs.lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    return "invalid";
  }
  if (!stat.isFile()) return "invalid";
  if (stat.size > MAX_DELEGATE_ARTIFACT_BYTES) return "too_large";
  try {
    const buffer = await fs.readFile(file);
    if (buffer.byteLength > MAX_DELEGATE_ARTIFACT_BYTES) return "too_large";
    // Detect a file swapped during hashing, to the extent supported by a local
    // filesystem check (this is not a process sandbox or atomic attestation).
    const afterward = await fs.lstat(file);
    if (!afterward.isFile() || afterward.size !== buffer.byteLength || !cliArtifactPathVisibleToWorkspace(file, workspace)) return "invalid";
    return { sha256: crypto.createHash("sha256").update(buffer).digest("hex"), bytes: buffer.byteLength };
  } catch {
    return "invalid";
  }
}

export async function snapshotExpectedArtifacts(files: string[], workspace: string): Promise<ArtifactBaseline[]> {
  const result: ArtifactBaseline[] = [];
  for (const file of files) {
    const check = await fingerprint(file, workspace);
    if (check === "invalid" || check === "too_large") {
      throw new Error(`Cannot snapshot expected artifact: ${path.basename(file)} (${check}).`);
    }
    result.push({ path: file, sha256: check === "missing" ? null : check.sha256 });
  }
  return result;
}

export async function inspectExpectedArtifacts(baselines: ArtifactBaseline[], cwd: string, workspace: string): Promise<ArtifactEvidence[]> {
  const evidence: ArtifactEvidence[] = [];
  for (const baseline of baselines) {
    const relPath = path.relative(cwd, baseline.path).replace(/\\/g, "/");
    const current = await fingerprint(baseline.path, workspace);
    if (typeof current === "string") {
      evidence.push({ path: relPath, state: current });
      continue;
    }
    evidence.push({
      path: relPath,
      state: baseline.sha256 === null ? "created" : baseline.sha256 === current.sha256 ? "unchanged" : "updated",
      sha256: current.sha256,
      bytes: current.bytes,
    });
  }
  return evidence;
}
