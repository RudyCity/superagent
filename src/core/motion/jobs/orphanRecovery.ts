import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { getMotionJob, motionJobDir, type MotionJob } from "./motionJobs.js";

const JOB = /^(?:studiojob|motionjob)-[a-f0-9]{24}$/;
const PROJECT = /^(?:studio|motion)-[a-f0-9]{20}$/;
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function regularBytes(file: string, limit = 4096): Promise<Buffer> {
  const st = await fs.lstat(file);
  if (!st.isFile() || st.isSymbolicLink() || st.size < 1 || st.size > limit)
    throw new Error("Unsafe stale-worker claim or source file");
  return fs.readFile(file);
}
async function missing(file: string): Promise<boolean> {
  try { await fs.lstat(file); return false; }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw e;
  }
}
async function assertOwnerAbsent(pid: number): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Stale worker PID is missing or unsafe");
  try { process.kill(pid, 0); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    throw new Error("Worker process identity is present or cannot be verified");
  }
  throw new Error("Worker process still exists; no lock reclamation permitted");
}
function verifiedClaim(raw: Buffer, job: MotionJob, slot: boolean): void {
  let data: unknown;
  try { data = JSON.parse(raw.toString("utf8")); }
  catch { throw new Error("Worker claim is not valid JSON"); }
  if (!data || typeof data !== "object") throw new Error("Worker claim is not an object");
  const claim = data as { pid?: unknown; startedAt?: unknown; jobId?: unknown };
  if (claim.pid !== job.ownerPid || (slot && claim.jobId !== job.id))
    throw new Error("Worker claim PID or job ID does not match stale owner");
  const claimedAt = Date.parse(String(claim.startedAt ?? ""));
  const ownerAt = Date.parse(String(job.ownerStartedAt ?? ""));
  if (!Number.isFinite(claimedAt) || !Number.isFinite(ownerAt) || Math.abs(claimedAt - ownerAt) > 120_000)
    throw new Error("Worker claim creation time does not match stale owner");
}

/**
 * Explicit, operator-only reconciliation of a worker whose exact PID is absent.
 * Never guesses an owner from elapsed time, never kills processes, and archives
 * verified original claims so migration and later forensics preserve evidence.
 */
export async function reconcileAbandonedMotionWorker(
  workspace: string, id: string, expectedPid: number,
): Promise<{ job: MotionJob; evidence: string; archivedClaims: string[] }> {
  if (!JOB.test(id)) throw new Error("Invalid Studio job ID");
  if (!Number.isSafeInteger(expectedPid) || expectedPid <= 0)
    throw new Error("Expected worker PID must be a positive integer");
  const dir = await motionJobDir(workspace, "jobs");
  const recoveryLock = path.join(dir, id + ".recovery.lock");
  const recoveryToken = crypto.randomBytes(16).toString("hex");
  const guard = await fs.open(recoveryLock, "wx", 0o600).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EEXIST") throw new Error("Worker recovery already locked");
    throw error;
  });
  try {
    await guard.writeFile(JSON.stringify({ token: recoveryToken, pid: process.pid }) + "\n");
    await guard.sync();
    const job = await getMotionJob(workspace, id);
    if (job.ownerPid !== expectedPid || !PROJECT.test(job.projectId))
      throw new Error("Job owner PID or project identity changed");
    if (!["preparing", "rendering", "validating", "interrupted"].includes(job.status))
      throw new Error("Worker recovery requires an active or previously interrupted owner");
    if (Date.now() - Date.parse(job.updatedAt) < 120_000)
      throw new Error("Worker state is too recent for safe reconciliation");
    const expected = new Map<string, Buffer>();
    const projectName = job.projectId + ".render.lock";
    const projectData = await regularBytes(path.join(dir, projectName), 1000);
    if (projectData.toString("utf8").trim() !== id)
      throw new Error("Project claim belongs to another job");
    expected.set(projectName, projectData);

    for (const suffix of [".runner.lock", ".waiting.lock"]) {
      const name = id + suffix;
      const data = await regularBytes(path.join(dir, name), 1000);
      verifiedClaim(data, job, false);
      expected.set(name, data);
    }
    let matchedSlot = 0;
    for (let slot = 0; slot < 4; slot++) {
      const name = ".render-slot-" + slot + ".lock";
      const file = path.join(dir, name);
      if (await missing(file)) continue;
      const data = await regularBytes(file, 1000);
      let owner: unknown;
      try { owner = JSON.parse(data.toString("utf8")); }
      catch { throw new Error("Unverifiable render-slot claim"); }
      if (!owner || typeof owner !== "object" ||
          typeof (owner as {jobId?: unknown}).jobId !== "string" ||
          !JOB.test(String((owner as {jobId: string}).jobId)))
        throw new Error("Unsafe render-slot ownership");
      if ((owner as {jobId: string}).jobId !== id) continue;
      verifiedClaim(data, job, true);
      expected.set(name, data);
      matchedSlot++;
    }
    if (matchedSlot !== 1) throw new Error("Expected exactly one owned render slot");
    for (const suffix of [".cancel", ".dispatch.lock"]) {
      if (!await missing(path.join(dir, id + suffix)))
        throw new Error("Unexpected cancellation or dispatch claim");
    }
    const rendersDir = await motionJobDir(workspace, "renders");
    for (const suffix of [".mp4", ".partial.mp4"]) {
      if (!await missing(path.join(rendersDir, id + suffix)))
        throw new Error("Worker output exists; inspect before recovery");
    }
    // Preserve the immutable source snapshot untouched, but verify integrity.
    const source = await regularBytes(path.join(dir, id + ".source.json"), 4_000_000);
    if (crypto.createHash("sha256").update(source).digest("hex") !== job.sourceSha256)
      throw new Error("Source snapshot changed; unsafe to reconcile");

    await assertOwnerAbsent(expectedPid);
    await sleep(150);
    await assertOwnerAbsent(expectedPid);
    const refreshed = await getMotionJob(workspace, id);
    if (refreshed.updatedAt !== job.updatedAt || refreshed.status !== job.status ||
        refreshed.ownerPid !== job.ownerPid || refreshed.sourceSha256 !== job.sourceSha256)
      throw new Error("Worker metadata changed during recovery");
    for (const [name, bytes] of expected) {
      if (!(await regularBytes(path.join(dir, name), 1000)).equals(bytes))
        throw new Error("Worker claim changed during recovery: " + name);
    }
    const evidenceDir = path.join(dir, "recovery-history");
    await fs.mkdir(evidenceDir, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(evidenceDir);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("Unsafe recovery-history directory");

    const token = crypto.randomBytes(8).toString("hex");
    const evidence = path.join(evidenceDir, id + "-" + token + ".json");
    const record = {
      schemaVersion: 1, jobId: id, recoveredAt: new Date().toISOString(),
      expectedPid, previousJob: job,
      claimHashes: Object.fromEntries([...expected].map(([name, bytes]) =>
        [name, crypto.createHash("sha256").update(bytes).digest("hex")])),
      note: "Owner PID absent at two independent checks; no processes terminated",
    };
    const h = await fs.open(evidence, "wx", 0o600);
    try { await h.writeFile(JSON.stringify(record, null, 2) + "\n"); await h.sync(); }
    finally { await h.close(); }

    // Transition to terminal before moving claims. An interrupted recovery
    // remains blocked by existing claims until a later operator retry.
    const revised: MotionJob = { ...job, status: "interrupted", updatedAt: new Date().toISOString(),
      error: "Operator-reconciled abandoned worker; original claims archived" };
    const manifest = path.join(dir, id + ".json");
    const tmp = manifest + "." + token + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(revised, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    try { await fs.rename(tmp, manifest); }
    finally { await fs.rm(tmp, { force: true }); }

    const archivedClaims: string[] = [];
    for (const [name, bytes] of expected) {
      const file = path.join(dir, name);
      if (!(await regularBytes(file, 1000)).equals(bytes))
        throw new Error("Claim changed before archival: " + name);
      await assertOwnerAbsent(expectedPid);
      const target = path.join(evidenceDir, id + "-" + token + "-" + name + ".recovered");
      await fs.rename(file, target);
      archivedClaims.push(path.basename(target));
    }
    return { job: revised, evidence: path.relative(dir, evidence), archivedClaims };
  } finally {
    await guard.close();
    // Never erase a replacement recovery owner's lock.
    const current = await regularBytes(recoveryLock, 1000);
    let claim: unknown;
    try { claim = JSON.parse(current.toString("utf8")); }
    catch { throw new Error("Recovery lock is unreadable; left in place"); }
    if (!claim || typeof claim !== "object" ||
        (claim as { token?: unknown }).token !== recoveryToken)
      throw new Error("Recovery lock ownership changed; left in place");
    await fs.rm(recoveryLock);
  }
}
