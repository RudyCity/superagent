/**
 * Publish verified CLI Bridge output from session root or task-local agent
 * scratch. Do not trust the caller's agent ID or file name as authorization:
 * the persisted job cwd must canonically reside beneath this owner's scratch.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { inspectBrainSession } from "./brainWorkspace.js";
import { assertNoSymlink, validateDestination, brainStorageUsage } from "./brainStorageManager.js";
import { withBrainSessionLock } from "./brainSessionLock.js";
import { getDelegateJob } from "../tools/cliBridgeDelegateJobs.js";

function under(root: string, file: string): boolean {
  const normal = (v: string) => process.platform === "win32" ? v.toLowerCase() : v;
  const r = normal(root), f = normal(file);
  return f === r || f.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}
export async function promoteBrainDelegation(owner: string, sessionId: string, jobId: string, outputName?: string, sourcePath?: string) {
  if (typeof jobId !== "string" || !/^clj_\d+_[a-f0-9]{8,32}$/.test(jobId)) throw new Error("Invalid delegation job ID.");
  const dir = inspectBrainSession(owner, sessionId).path;
  const scratch = fs.realpathSync.native(path.join(dir, "scratch"));
  const job = await getDelegateJob(jobId);
  if (!job || typeof job.cwd !== "string" || !fs.existsSync(job.cwd)) throw new Error("Delegation unavailable for requested Brain session.");
  const jobCwd = fs.realpathSync.native(job.cwd);
  if (!under(scratch, jobCwd)) throw new Error("Delegation is not owned by the requested Brain scratch.");
  assertNoSymlink(scratch, jobCwd);
  if (job.status !== "succeeded" || job.completionState !== "artifacts_verified" ||
      !Array.isArray(job.artifactEvidence) || !job.artifactEvidence.length || job.artifactEvidence.length > 10) {
    throw new Error("Only succeeded delegations with bounded verified artifacts can be promoted.");
  }
  if(job.artifactEvidence.length>1 && !sourcePath)throw new Error("Select a source artifact path for multi-file promotion.");
  const evidence = sourcePath ? job.artifactEvidence.find((entry:any)=>entry.path===sourcePath) : job.artifactEvidence[0];
  if(!evidence)throw new Error("Selected source artifact is not verified for this delegation.");
  if (!["created","updated"].includes(evidence.state) || !/^[a-f0-9]{64}$/.test(evidence.sha256 || "")) {
    throw new Error("Delegated artifact evidence is not verified.");
  }
  const relative = String(evidence.path).replace(/\\/g, "/");
  if (!relative || relative.startsWith("/") || /^[a-z]:/i.test(relative) ||
      relative.split("/").some(segment => segment === ".." || segment === "." || !segment)) {
    throw new Error("Delegated artifact path escapes job scratch.");
  }
  const source = path.resolve(jobCwd, relative);
  if (!under(jobCwd, source)) throw new Error("Delegated artifact escaped job scratch.");
  assertNoSymlink(jobCwd, source);
  const filename = outputName ?? path.basename(source);
  if (!filename || filename.includes("/") || filename.includes("\\") || filename === "." || filename === "..") {
    throw new Error("Invalid output filename.");
  }
  return withBrainSessionLock(dir, () => {
    const stat = fs.lstatSync(source);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 10 * 1024 * 1024) throw new Error("Unsupported verified artifact.");
    const bytes = fs.readFileSync(source);
    const digest = crypto.createHash("sha256").update(bytes).digest("hex");
    if (bytes.length !== evidence.bytes || digest !== evidence.sha256) throw new Error("Delegated artifact changed after verification.");
    let reserved = 0;
    const transfers = path.join(dir, ".transfers");
    assertNoSymlink(dir, transfers);
    if (fs.existsSync(transfers)) {
      for (const name of fs.readdirSync(transfers)) {
        if (!/^btx_[a-f0-9]{32}\.json$/.test(name)) continue;
        const meta = path.join(transfers, name);
        assertNoSymlink(dir, meta);
        const data = JSON.parse(fs.readFileSync(meta, "utf8"));
        if (!Number.isSafeInteger(data.totalBytes) || data.totalBytes < 1 || data.totalBytes > 20 * 1024 * 1024) {
          throw new Error("Invalid pending Brain transfer reservation.");
        }
        reserved += data.totalBytes;
      }
    }
    if (brainStorageUsage(dir).totalBytes + reserved + bytes.length > 50 * 1024 * 1024) {
      throw new Error("Brain storage quota exceeded before promotion.");
    }
    const filePath = "artifacts/" + filename;
    const target = path.join(dir, validateDestination(filePath));
    assertNoSymlink(dir, target);
    const fd = fs.openSync(target, "wx", 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); }
    catch (error) { fs.closeSync(fd); try { fs.unlinkSync(target); } catch {} throw error; }
    fs.closeSync(fd);
    return { sessionId, jobId, filePath, sha256: digest, bytes: bytes.length, sourceVerified: true };
  });
}
