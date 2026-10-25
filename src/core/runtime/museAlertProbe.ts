/**
 * Explicit opt-in probe of configured external alert delivery. No incident or
 * recovery mutation; a successful HTTP request is NOT proof of human receipt.
 * A successful test for an encrypted local config records only its ciphertext
 * fingerprint, so any provider edit invalidates prior evidence.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolvedIncidentTarget, sendIncidentAlert } from "../remoteAgent/museIncidentCenter.js";
import { loadMuseAlertConfig } from "../remoteAgent/museAlertConfig.js";

type Probe = { version: 1; port: number; testedAt: number; sourceDigest: string };
function probePaths(port: number, root = path.join(os.homedir(), ".superagent-r")) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid probe port");
  return { file: path.join(root, "muse-alert-probe-" + port + ".json"),
    source: path.join(root, "muse-alert-config-" + port + ".json") };
}
function sourceFingerprint(port: number, root: string): string | null {
  const { source } = probePaths(port, root);
  let stat: fs.Stats;
  try { stat = fs.lstatSync(source); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("Unreadable alert configuration");
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192 || stat.size <= 0) {
    throw new Error("Unsafe alert configuration");
  }
  return crypto.createHash("sha256").update(fs.readFileSync(source)).digest("hex");
}
/** No retained token/chat ID, URL, hostname, event payload or HTTP error body. */
export function readMuseAlertProbe(port: number, root = path.join(os.homedir(), ".superagent-r"),
  now = Date.now()): { testedAt: number; currentConfig: boolean } | null {
  const { file } = probePaths(port, root);
  let stat: fs.Stats;
  try { stat = fs.lstatSync(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("Unreadable alert probe");
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 512) {
    throw new Error("Invalid alert probe");
  }
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as Probe;
    if (value.version !== 1 || value.port !== port ||
        !Number.isSafeInteger(value.testedAt) || value.testedAt <= 0 ||
        value.testedAt > now || !/^[a-f0-9]{64}$/.test(value.sourceDigest)) {
      throw new Error("Invalid probe");
    }
    return { testedAt: value.testedAt, currentConfig: sourceFingerprint(port, root) === value.sourceDigest };
  } catch { throw new Error("Invalid alert probe"); }
}
export async function probeMuseAlertDelivery(
  port: number, root = path.join(os.homedir(), ".superagent-r"),
  fetcher: typeof fetch = fetch, now = Date.now(),
): Promise<boolean> {
  const cfg = loadMuseAlertConfig(port, root);
  const target = resolvedIncidentTarget(port, root);
  if (!target) return false;
  const digest = cfg ? sourceFingerprint(port, root) : null;
  const sent = await sendIncidentAlert({
    id: crypto.randomBytes(16).toString("hex"), port,
    kind: "host_unavailable", condition: "online", observedAt: now, test: true,
  }, target, fetcher);
  if (!sent || !digest) return sent;
  // An operator might have changed the provider during the request.
  if (sourceFingerprint(port, root) !== digest) return sent;
  const { file } = probePaths(port, root);
  const directory = path.dirname(file);
  const directoryStat = fs.lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error("Unsafe probe root");
  if (fs.existsSync(file)) {
    const old = fs.lstatSync(file);
    if (!old.isFile() || old.isSymbolicLink()) throw new Error("Unsafe probe path");
  }
  const tmp = file + "." + crypto.randomBytes(8).toString("hex") + ".tmp";
  try {
    const fd = fs.openSync(tmp, "wx", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify({
        version: 1, port, testedAt: now, sourceDigest: digest,
      } satisfies Probe));
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
  } finally { try { fs.rmSync(tmp, { force: true }); } catch {} }
  return true;
}
