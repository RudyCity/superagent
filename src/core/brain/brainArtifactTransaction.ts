/**
 * Crash-recoverable batch promotion of verified CLI Bridge artifacts.
 * Every output is staged and hashed before any final target is created.
 * The transaction journal lets the next batch operation roll back a partially
 * committed batch (or finish cleaning up a committed one) after process death.
 *
 * This is all-or-none on successful return, NOT a multi-file atomic filesystem
 * snapshot to concurrent observers. The session write lock serializes Brain
 * writers; readers outside Brain may briefly see a partial batch at crash time.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { inspectBrainSession } from "./brainWorkspace.js";
import { assertNoSymlink, validateDestination, brainStorageUsage } from "./brainStorageManager.js";
import { withBrainSessionLock } from "./brainSessionLock.js";
import { getDelegateJob } from "../tools/cliBridgeDelegateJobs.js";

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_BATCH_BYTES = 50 * 1024 * 1024;
const MAX_ITEMS = 10;
type Item = { name: string; staging: string; sha256: string; bytes: number };
type Journal = { schemaVersion: 1; state: "prepared" | "committed"; jobId: string; items: Item[] };
type Receipt = { schemaVersion: 1; jobId: string; files: Array<{filePath:string;sha256:string;bytes:number}> };
function receiptFile(dir:string,jobId:string) {
  if(!/^clj_\d+_[a-f0-9]{8,32}$/.test(jobId))throw new Error("Invalid Brain promotion receipt ID.");
  const file=path.join(dir,".promotion","receipts",jobId+".json");
  assertNoSymlink(dir,file);
  return file;
}
function readReceipt(dir:string,jobId:string):Receipt|null {
  const file=receiptFile(dir,jobId);
  if(!fs.existsSync(file))return null;
  const st=fs.lstatSync(file);
  if(!st.isFile()||st.nlink!==1||st.size>8192)throw new Error("Invalid Brain promotion receipt.");
  const entry=JSON.parse(fs.readFileSync(file,"utf8")) as Receipt;
  if(entry.schemaVersion!==1||entry.jobId!==jobId||!Array.isArray(entry.files)||entry.files.length<1||entry.files.length>10)
    throw new Error("Invalid Brain promotion receipt.");
  for(const item of entry.files) {
    if(!item||typeof item.filePath!=="string"||!item.filePath.startsWith("artifacts/")||
      validateDestination(item.filePath)!==path.join("artifacts",path.basename(item.filePath))||
      !/^[a-f0-9]{64}$/.test(item.sha256)||!Number.isSafeInteger(item.bytes))
      throw new Error("Invalid Brain promotion receipt entry.");
    const filename=path.join(dir,validateDestination(item.filePath));
    assertNoSymlink(dir,filename);
    const data=fs.readFileSync(filename);
    if(data.length!==item.bytes||crypto.createHash("sha256").update(data).digest("hex")!==item.sha256)
      throw new Error("Brain promotion receipt does not match committed artifacts.");
  }
  return entry;
}
function writeReceipt(dir:string,data:Journal) {
  const file=receiptFile(dir,data.jobId);
  const files=data.items.map(item=>({filePath:"artifacts/"+item.name,sha256:item.sha256,bytes:item.bytes}));
  const previous=readReceipt(dir,data.jobId);
  if(previous) {
    if(JSON.stringify(previous.files)!==JSON.stringify(files))throw new Error("Conflicting Brain promotion receipt.");
    return;
  }
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  const value:Receipt={schemaVersion:1,jobId:data.jobId,files};
  fs.writeFileSync(file,JSON.stringify(value),{flag:"wx",mode:0o600});
  readReceipt(dir,data.jobId);
}
export type PromotionOptions = {
  selectedSource?: string;
  outputName?: string;
  /** For fault injection in tests; never exposed to an MCP caller. */
  failAfterLinks?: number;
};
const normalize = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
function within(root: string, target: string) {
  const r = normalize(root), t = normalize(target);
  return t === r || t.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}
function promotionRoot(dir: string) {
  const folder = path.join(dir, ".promotion");
  assertNoSymlink(dir, folder);
  return folder;
}
function journalPath(folder: string) { return path.join(folder, "transaction.json"); }
function validateEntry(value: Item) {
  if (typeof value.name !== "string" || !value.name || path.basename(value.name) !== value.name ||
      value.name.includes("/") || value.name.includes("\\") ||
      typeof value.staging !== "string" || !/^stage-[a-f0-9]{16}\.part$/.test(value.staging) ||
      typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256) ||
      !Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > MAX_FILE_BYTES) {
    throw new Error("Invalid Brain promotion journal item.");
  }
  validateDestination("artifacts/" + value.name);
}
function storeJournal(folder: string, data: Journal, overwrite = false) {
  const file = journalPath(folder);
  const temp = path.join(folder, "journal-" + crypto.randomBytes(8).toString("hex") + ".tmp");
  try {
    fs.writeFileSync(temp, JSON.stringify(data), { flag: "wx", mode: 0o600 });
    if (!overwrite && fs.existsSync(file)) throw new Error("Brain promotion already active.");
    fs.renameSync(temp, file);
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
/** Must be invoked under the session write lock. */
function recoverLocked(dir: string) {
  const folder = promotionRoot(dir), file = journalPath(folder);
  if (!fs.existsSync(file)) return { status: "clean", rolledBack: 0 };
  assertNoSymlink(dir, file);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 8000) throw new Error("Invalid Brain promotion journal.");
  const data = JSON.parse(fs.readFileSync(file, "utf8")) as Journal;
  if (data.schemaVersion !== 1 || !["prepared","committed"].includes(data.state) ||
      !Array.isArray(data.items) || !data.items.length || data.items.length > MAX_ITEMS) {
    throw new Error("Unsafe Brain promotion journal; operator review required.");
  }
  for (const item of data.items) validateEntry(item);
  if(data.state==="committed")writeReceipt(dir,data);
  // Never delete arbitrary files: roll back only hardlinks that can be proven
  // to be the same inode as this journal's staging file.
  for (const item of data.items) {
    const stage = path.join(folder, item.staging);
    const final = path.join(dir, "artifacts", item.name);
    assertNoSymlink(dir, stage); assertNoSymlink(dir, final);
    if (data.state === "prepared" && fs.existsSync(final)) {
      if (!fs.existsSync(stage)) throw new Error("Promotion staging missing; refusing unsafe rollback.");
      const staged = fs.lstatSync(stage), published = fs.lstatSync(final);
      if (!staged.isFile() || !published.isFile() || staged.isSymbolicLink() ||
          published.isSymbolicLink() || staged.ino !== published.ino || staged.dev !== published.dev ||
          staged.size !== item.bytes) throw new Error("Promotion target changed; operator review required.");
      fs.unlinkSync(final);
    }
  }
  for (const item of data.items) {
    const stage = path.join(folder, item.staging);
    if (fs.existsSync(stage)) {
      const stat = fs.lstatSync(stage);
      if (!stat.isFile() || stat.nlink < 1) throw new Error("Promotion staging changed.");
      fs.unlinkSync(stage);
    }
  }
  fs.unlinkSync(file);
  return { status: data.state === "prepared" ? "rolled-back" : "committed-cleanup", rolledBack: data.state === "prepared" ? data.items.length : 0 };
}
export function recoverBrainArtifactPromotion(owner: string, sessionId: string) {
  const dir = inspectBrainSession(owner, sessionId).path;
  return withBrainSessionLock(dir, () => recoverLocked(dir));
}
function reservedBytes(dir: string) {
  const folder = path.join(dir, ".transfers");
  assertNoSymlink(dir, folder);
  if (!fs.existsSync(folder)) return 0;
  let count = 0;
  for (const name of fs.readdirSync(folder)) {
    if (!/^btx_[a-f0-9]{32}\.json$/.test(name)) continue;
    const meta = path.join(folder, name);
    assertNoSymlink(dir, meta);
    const record = JSON.parse(fs.readFileSync(meta, "utf8")) as { totalBytes?: number };
    if (!Number.isSafeInteger(record.totalBytes) || record.totalBytes! < 1 || record.totalBytes! > 20 * 1024 * 1024) throw new Error("Invalid upload reservation.");
    count += record.totalBytes!;
  }
  return count;
}
export async function promoteBrainDelegationBatch(owner: string, sessionId: string, jobId: string, options: PromotionOptions = {}) {
  if (!/^clj_\d+_[a-f0-9]{8,32}$/.test(jobId)) throw new Error("Invalid delegation job ID.");
  const dir = inspectBrainSession(owner, sessionId).path;
  const scratch = fs.realpathSync.native(path.join(dir, "scratch"));
  const job = await getDelegateJob(jobId);
  if (!job || typeof job.cwd !== "string" || !fs.existsSync(job.cwd)) throw new Error("Delegation unavailable for requested Brain session.");
  const cwd = fs.realpathSync.native(job.cwd);
  if (!within(scratch, cwd)) throw new Error("Delegation is not owned by the requested Brain scratch.");
  assertNoSymlink(scratch, cwd);
  if (job.status !== "succeeded" || job.completionState !== "artifacts_verified" ||
      !Array.isArray(job.artifactEvidence) || !job.artifactEvidence.length || job.artifactEvidence.length > MAX_ITEMS) {
    throw new Error("Only succeeded delegations with bounded verified artifacts can be promoted.");
  }
  const evidences = options.selectedSource
    ? job.artifactEvidence.filter((a: any) => a.path === options.selectedSource)
    : job.artifactEvidence;
  if (!evidences.length || evidences.length > MAX_ITEMS) throw new Error("Selected source artifact is not verified for this job.");
  if (options.outputName && evidences.length !== 1) throw new Error("Output filename override requires one selected artifact.");
  const expected: Array<{ name: string; bytes: Buffer; sha256: string }> = [];
  const names = new Set<string>();
  for (const [i, evidence] of evidences.entries()) {
    if (!["created","updated"].includes(evidence?.state) ||
        !/^[a-f0-9]{64}$/.test(evidence?.sha256 || "")) throw new Error("Delegated artifact evidence is not verified.");
    const sourcePath = String(evidence.path).replace(/\\/g, "/");
    if (!sourcePath || sourcePath.startsWith("/") || /^[a-z]:/i.test(sourcePath) ||
        sourcePath.split("/").some(x => !x || x === "." || x === "..")) throw new Error("Delegated source escapes scratch.");
    const source = path.resolve(cwd, sourcePath);
    if (!within(cwd, source)) throw new Error("Delegated source escapes job scratch.");
    assertNoSymlink(cwd, source);
    const stat = fs.lstatSync(source);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > MAX_FILE_BYTES) throw new Error("Unsupported delegated artifact.");
    const bytes = fs.readFileSync(source);
    const hash = crypto.createHash("sha256").update(bytes).digest("hex");
    if (bytes.length !== evidence.bytes || hash !== evidence.sha256) throw new Error("Delegated artifact changed after verification.");
    const name = options.outputName || (evidences.length > 1 ? i + "-" + jobId.slice(-8) + "-" + path.basename(source) : path.basename(source));
    if (!name || name.includes("/") || name.includes("\\") || path.basename(name) !== name) throw new Error("Invalid output filename.");
    validateDestination("artifacts/" + name);
    if (names.has(name.toLowerCase())) throw new Error("Duplicate destination in promotion batch.");
    names.add(name.toLowerCase());
    expected.push({ name, bytes, sha256: hash });
  }
  return withBrainSessionLock(dir, () => {
    recoverLocked(dir);
    const receipt=readReceipt(dir,jobId);
    if(receipt) {
      const expectedFiles=expected.map(item=>({filePath:"artifacts/"+item.name,sha256:item.sha256,bytes:item.bytes.length}));
      if(JSON.stringify(receipt.files)!==JSON.stringify(expectedFiles))
        throw new Error("Delegation was already promoted with a different artifact selection.");
      return {sessionId,jobId,files:receipt.files,sourceVerified:true,replayed:true};
    }
    const amount = expected.reduce((sum, item) => sum + item.bytes.length, 0);
    if (brainStorageUsage(dir).totalBytes + reservedBytes(dir) + amount > MAX_BATCH_BYTES) throw new Error("Brain batch promotion quota exceeded.");
    const folder = promotionRoot(dir);
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    const records: Item[] = [];
    for (const expectedItem of expected) {
      const destination = path.join(dir, "artifacts", expectedItem.name);
      assertNoSymlink(dir, destination);
      if (fs.existsSync(destination)) throw new Error("Promotion destination exists; no overwrite.");
    }
    try {
      for (const item of expected) {
        const staging = "stage-" + crypto.randomBytes(8).toString("hex") + ".part";
        const file = path.join(folder, staging);
        const fd = fs.openSync(file, "wx", 0o600);
        try { fs.writeFileSync(fd, item.bytes); fs.fsyncSync(fd); }
        finally { fs.closeSync(fd); }
        records.push({name: item.name, staging, sha256:item.sha256, bytes:item.bytes.length});
      }
      storeJournal(folder, {schemaVersion:1,state:"prepared",jobId,items:records});
      for (const [i, item] of records.entries()) {
        fs.linkSync(path.join(folder, item.staging), path.join(dir,"artifacts",item.name));
        if (options.failAfterLinks === i + 1) throw new Error("Injected promotion commit interruption.");
      }
      storeJournal(folder, {schemaVersion:1,state:"committed",jobId,items:records}, true);
      // A failure here leaves a committed journal for harmless later cleanup.
      try { recoverLocked(dir); } catch { /* Transaction is committed; recover on next call. */ }
      return {sessionId,jobId,files:records.map(item=>({filePath:"artifacts/"+item.name,sha256:item.sha256,bytes:item.bytes})),sourceVerified:true};
    } catch (error) {
      if (fs.existsSync(journalPath(folder))) recoverLocked(dir);
      else for (const item of records) {
        const file = path.join(folder,item.staging);
        if (fs.existsSync(file)) fs.unlinkSync(file);
      }
      throw error;
    }
  });
}
