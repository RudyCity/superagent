/** Redacted evidence of an isolated Phase 4o disaster recovery exercise.
 * Informational local evidence only; NOT a cryptographic proof of production safety.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
export type MuseDrillEvidence = { version: 1; port: number; completedAt: number;
  isolated: true; passedChecks: number; failedChecks: 0 };
const fileFor = (port: number, root: string) => {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid drill evidence port");
  return path.join(root, "muse-dr-drill-" + port + ".json");
};
export function storeMuseDrillEvidence(port: number, passedChecks: number,
  root = path.join(os.homedir(), ".superagent-r"), at = Date.now()) {
  if (!Number.isInteger(passedChecks) || passedChecks < 15 ||
      !Number.isSafeInteger(at) || at <= 0) throw new Error("Incomplete DR drill");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const directory = fs.lstatSync(root);
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("Unsafe DR evidence root");
  const file = fileFor(port, root);
  if (fs.existsSync(file)) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Unsafe DR evidence file");
  }
  const temp = file + "." + crypto.randomBytes(8).toString("hex") + ".tmp";
  try {
    const fd = fs.openSync(temp, "wx", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify({
        version: 1, port, completedAt: at, isolated: true,
        passedChecks, failedChecks: 0,
      } satisfies MuseDrillEvidence));
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(temp, file);
  } finally { try { fs.rmSync(temp, { force: true }); } catch {} }
}
export function readMuseDrillEvidence(port: number,
  root = path.join(os.homedir(), ".superagent-r"), now = Date.now()): MuseDrillEvidence | null {
  const file = fileFor(port, root);
  let stat: fs.Stats;
  try { stat = fs.lstatSync(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("DR evidence unreadable");
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > 512) {
    throw new Error("DR evidence corrupted");
  }
  try {
    const e = JSON.parse(fs.readFileSync(file, "utf8")) as MuseDrillEvidence;
    if (e.version !== 1 || e.port !== port || e.isolated !== true ||
        e.failedChecks !== 0 || !Number.isInteger(e.passedChecks) ||
        e.passedChecks < 15 || !Number.isSafeInteger(e.completedAt) ||
        e.completedAt < 1 || e.completedAt > now) throw new Error("DR evidence invalid");
    return e;
  } catch { throw new Error("DR evidence invalid"); }
}
