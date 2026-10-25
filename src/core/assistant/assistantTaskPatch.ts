/** Human-reviewable coding proposals only. The model has READ tools, never
 * direct write/shell privileges. A strictly validated unified diff is applied
 * to a fresh detached Git worktree, never to the user's current checkout.
 */
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import path from "node:path";
import { getRootConfigDir } from "../config/paths.js";
import type { AssistantTaskRecord } from "./assistantTaskStore.js";
import { generateDetachedReadOnlyText } from "./assistantTaskRuntime.js";
import { saveDetachedTaskResult } from "./assistantTaskResults.js";

const execFileAsync = promisify(execFile);
const MAX_PATCH_BYTES = 32_768;
const MAX_CHANGED_FILES = 8;
const MAX_PATCH_LINES = 1500;

function artifactKey(task: AssistantTaskRecord): string {
  return createHash("sha256").update(task.ownerId + "\0" +
    task.workspaceId + "\0" + task.taskId).digest("hex");
}
function patchFile(task: AssistantTaskRecord): string {
  return path.join(getRootConfigDir(), "assistant-task-patches", artifactKey(task) + ".diff");
}
async function git(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd, windowsHide: true, timeout: 25_000,
    maxBuffer: 128 * 1024, signal,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
  });
  return stdout;
}
const samePath = (a: string, b: string) =>
  path.resolve(a).replace(/\\/g, "/").toLowerCase() ===
  path.resolve(b).replace(/\\/g, "/").toLowerCase();

export function extractAndValidatePatch(text: string): { patch: string; paths: string[] } {
  if (typeof text !== "string" || Buffer.byteLength(text) > MAX_PATCH_BYTES + 2000) {
    throw new Error("Patch proposal exceeds size limit");
  }
  const fenced = text.trim().match(/^\x60\x60\x60(?:diff|patch)?\r?\n([\s\S]*?)\r?\n?\x60\x60\x60$/);
  const patch = (fenced ? fenced[1] : text).replace(/\r\n/g, "\n").trimEnd() + "\n";
  if (Buffer.byteLength(patch) > MAX_PATCH_BYTES ||
      patch.split("\n").length > MAX_PATCH_LINES ||
      /^(?:GIT binary patch|Binary files |rename (?:from|to) |copy (?:from|to) |new file mode |deleted file mode |old mode |new mode )/m.test(patch)) {
    throw new Error("Unsupported or oversized patch");
  }
  if (!patch.startsWith("diff --git a/")) throw new Error("Expected a Git unified diff");
  const files = new Map<string, { from: boolean; to: boolean; hunks: boolean }>();
  let current = "";
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const match = /^diff --git a\/([^\s]+) b\/([^\s]+)$/.exec(line);
      if (!match || match[1] !== match[2]) throw new Error("Renames and untrusted paths are forbidden");
      const name = match[1];
      if (!/^[A-Za-z0-9][A-Za-z0-9._/+-]*$/.test(name) ||
          name.includes("\\") || name.startsWith("/") ||
          name.split("/").some(part => part === "." || part === ".." || part === ".git") ||
          !/^(?:src|tests|test|apps|packages|frontend|backend)\//.test(name) ||
          /(?:^|\/)(?:\.env(?:\..*)?|\.npmrc|\.pypirc|id_rsa|\.gitignore|\.gitmodules)(?:$|\/)/i.test(name)) {
        throw new Error("Patch path is outside the source/test allowlist");
      }
      if (files.has(name) || files.size >= MAX_CHANGED_FILES) throw new Error("Patch file budget exceeded");
      current = name;
      files.set(name, { from: false, to: false, hunks: false });
      continue;
    }
    if (line.startsWith("--- ")) {
      if (line !== "--- a/" + current) throw new Error("Source path mismatch");
      files.get(current)!.from = true;
    }
    if (line.startsWith("+++ ")) {
      if (line !== "+++ b/" + current) throw new Error("Destination path mismatch");
      files.get(current)!.to = true;
    }
    if (line.startsWith("@@ ")) files.get(current)!.hunks = true;
    if (line.startsWith("diff --git") && !current) throw new Error("Invalid patch");
  }
  if (!files.size || [...files.values()].some(f => !f.from || !f.to || !f.hunks)) {
    throw new Error("Patch requires tracked modifications with valid hunks");
  }
  return { patch, paths: [...files.keys()] };
}
async function verifyWorkspace(repo: string, signal: AbortSignal) {
  if (!path.isAbsolute(repo)) throw new Error("Git workspace must be an absolute local directory");
  let segment = path.parse(repo).root;
  for (const part of path.relative(segment, repo).split(path.sep).filter(Boolean)) {
    segment = path.join(segment, part);
    const stat = await fs.lstat(segment);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Workspace symlink/reparse traversal forbidden");
  }
  const top = (await git(repo, ["rev-parse", "--show-toplevel"], signal)).trim();
  if (!samePath(top, repo)) throw new Error("Select the Git repository root for patch preparation");
  await git(repo, ["rev-parse", "--verify", "HEAD"], signal);
}
async function validateTrackedPatchTargets(worktree: string, paths: string[], signal: AbortSignal) {
  for (const file of paths) {
    await git(worktree, ["ls-files", "--error-unmatch", "--", file], signal);
    let segment = worktree;
    for (const part of file.split("/")) {
      segment = path.join(segment, part);
      const stat = await fs.lstat(segment);
      if (stat.isSymbolicLink()) throw Error("Symlink patch target forbidden");
    }
  }
}
export type PatchTextGenerator = (task: AssistantTaskRecord,
  workspace: string, signal: AbortSignal) => Promise<string>;
export async function prepareDetachedPatch(
  task: AssistantTaskRecord, workspace: string, signal: AbortSignal,
  generate: PatchTextGenerator = async (t, repo, sig) => generateDetachedReadOnlyText(t, repo, sig,
    "Produce ONLY a git unified diff (diff --git a/... b/...) changing existing tracked source " +
    "or test files, no prose. Do not modify files or run commands. Use existing lines exactly. " +
    "This patch will be verified and applied only in a detached Git worktree for review. Task: " + t.title),
): Promise<string[]> {
  await verifyWorkspace(workspace, signal);
  const proposal = await generate(task, workspace, signal);
  if (signal.aborted) throw new Error("Patch preparation cancelled");
  const { patch, paths } = extractAndValidatePatch(proposal);
  const base = path.join(getRootConfigDir(), "assistant-task-worktrees");
  const target = path.join(base, artifactKey(task));
  await fs.mkdir(base, { recursive: true, mode: 0o700 });
  // Fail closed on existing worktrees and unknown owners; never delete work
  // belonging to a previous process or another operator.
  try {
    await fs.lstat(target);
    throw new Error("Worktree already exists; manual reconciliation required");
  } catch (error: any) { if (error?.code !== "ENOENT") throw error; }
  await git(workspace, ["worktree", "add", "--detach", "--", target, "HEAD"], signal);
  await validateTrackedPatchTargets(target, paths, signal);
  const candidate = path.join(base, artifactKey(task) + "." + randomUUID() + ".diff");
  try {
    await fs.writeFile(candidate, patch, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await git(target, ["apply", "--check", "--whitespace=error", "--", candidate], signal);
    if (signal.aborted) throw Error("Patch preparation cancelled");
    await git(target, ["apply", "--whitespace=error", "--", candidate], signal);
    const diff = await git(target, ["diff", "--no-ext-diff", "--no-color", "--", ...paths], signal);
    if (!diff.trim() || Buffer.byteLength(diff) > MAX_PATCH_BYTES) {
      throw Error("Patch review output invalid or exceeds limit");
    }
    const reviewed = extractAndValidatePatch(diff);
    if (reviewed.paths.join("\0") !== paths.join("\0")) throw Error("Patch output path mismatch");
    if (signal.aborted) throw Error("Patch preparation cancelled");
    const result = patchFile(task);
    await fs.mkdir(path.dirname(result), { recursive: true, mode: 0o700 });
    // Once-only result artifact. An operator can review the patch without a
    // write/merge endpoint or exposing arbitrary disk paths.
    await fs.writeFile(result, reviewed.patch, { mode: 0o600, flag: "wx" });
    await saveDetachedTaskResult(task, "Reviewable patch prepared against repository HEAD. " +
      paths.length + " tracked file(s). No changes applied to your active workspace. " +
      "Patch requires manual review and merge. Worktree identity: " + artifactKey(task).slice(0, 12));
    return ["patch_review_ready"];
  } finally {
    await fs.rm(candidate, { force: true }).catch(() => {});
  }
}
export async function readDetachedPatch(task: AssistantTaskRecord): Promise<string | null> {
  if (task.status !== "completed" || !task.evidenceIds.includes("patch_review_ready")) return null;
  try {
    const name = patchFile(task);
    const info = await fs.lstat(name);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_PATCH_BYTES) throw Error("Invalid patch artifact");
    return await fs.readFile(name, "utf8");
  } catch (error: any) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}
