/**
 * Explicitly promote CLI Bridge-verified scratch output to Brain artifacts.
 * Never infer success from stdout/exit code; require persisted artifact evidence.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { inspectBrainSession } from "./brainWorkspace.js";
import { assertNoSymlink, validateDestination } from "./brainStorageManager.js";
import { getDelegateJob } from "../tools/cliBridgeDelegateJobs.js";

export async function promoteBrainDelegation(
  owner: string, sessionId: string, jobId: string, outputName?: string,
) {
  if (typeof jobId !== "string" || !/^clj_\d+_[a-f0-9]{8,32}$/.test(jobId)) {
    throw new Error("Invalid delegation job ID.");
  }
  const dir = inspectBrainSession(owner, sessionId).path;
  const scratch = path.join(dir, "scratch");
  const cwd = fs.realpathSync.native(scratch);
  const job = await getDelegateJob(jobId);
  if (!job || fs.realpathSync.native(job.cwd) !== cwd) throw new Error("Delegation is not owned by the requested Brain scratch.");
  if (job.status !== "succeeded" || job.completionState !== "artifacts_verified" ||
      !Array.isArray(job.artifactEvidence) || !job.artifactEvidence.length) {
    throw new Error("Only succeeded delegations with verified artifact evidence can be promoted.");
  }
  if (job.artifactEvidence.length !== 1) {
    throw new Error("Specify a delegation with exactly one verified artifact for automatic promotion.");
  }
  const evidence = job.artifactEvidence[0];
  if (!["created", "updated"].includes(evidence.state) || !/^[a-f0-9]{64}$/.test(evidence.sha256 || "")) {
    throw new Error("Delegated artifact evidence is not verified.");
  }
  const relativePath = String(evidence.path).replace(/\\/g, "/");
  if (relativePath.startsWith("/") || relativePath.includes("..") || relativePath.includes(":")) {
    throw new Error("Artifact path escapes scratch.");
  }
  const source = path.resolve(scratch, relativePath);
  assertNoSymlink(scratch, source);
  const stat = fs.lstatSync(source);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 10 * 1024 * 1024) {
    throw new Error("Delegated artifact is not a supported regular file.");
  }
  const buffer = fs.readFileSync(source);
  const digest = crypto.createHash("sha256").update(buffer).digest("hex");
  if (digest !== evidence.sha256 || buffer.length !== evidence.bytes) throw new Error("Delegated artifact changed after verification.");
  const filename = outputName || path.basename(relativePath);
  if (!filename || filename.includes("/") || filename.includes("\\")) throw new Error("Invalid output filename.");
  const target = path.join(dir, validateDestination("artifacts/" + filename));
  assertNoSymlink(dir, target);
  const fd = fs.openSync(target, "wx", 0o600);
  try { fs.writeFileSync(fd, buffer); fs.fsyncSync(fd); }
  catch (error) { fs.closeSync(fd); try { fs.unlinkSync(target); } catch {} throw error; }
  fs.closeSync(fd);
  return { sessionId, jobId, filePath: "artifacts/" + filename, sha256: digest, bytes: buffer.length, sourceVerified: true };
}
