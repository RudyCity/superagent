/**
 * Explicit two-step local Brain storage mutations. Does not accept arbitrary
 * filesystem roots, avoids symlink traversal, and never overwrites a project file.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getRootConfigDir } from '../config/paths.js';
import { inspectBrainSession, listBrainSessions } from './brainWorkspace.js';

const MAX_SCAN_ENTRIES = 5000;
const MAX_BINARY_BYTES = 20 * 1024 * 1024;
const CHALLENGE_TTL_MS = 60_000;
const challengeStore = new Map<string, {
  owner: string; action: 'clean-scratch' | 'publish'; fingerprint: string;
  sessionId: string; filePath?: string; destinationPath?: string; projectRoot?: string;
  expiresAt: number; bytes: number;
}>();

export function validateDestination(filePath: string): string {
  if (!filePath || filePath.length > 240 || path.isAbsolute(filePath) ||
    filePath.includes('\\') || /[\x00-\x1f\x7f]/.test(filePath) || /^[A-Za-z]:/.test(filePath)) throw new Error('Invalid destination path.');
  const parts = filePath.split('/');
  if (parts.length < 1 || parts.length > 8 || parts.some(p =>
    !p || p === '.' || p === '..' || p.startsWith('.') || p.endsWith('.') ||
    /[:<>|?*"\\]/.test(p) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)
  )) throw new Error('Unsafe destination path.');
  return path.join(...parts);
}

export function assertNoSymlink(root: string, target: string): void {
  const rel = path.relative(root, target);
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw new Error('Path escapes root.');
  let current = root;
  if (fs.existsSync(root) && fs.lstatSync(root).isSymbolicLink()) throw new Error('Symlink root refused.');
  for (const segment of rel.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Symlink boundary refused.');
    } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  }
}

export function scanBrainArea(dir: string, area: 'scratch' | 'artifacts' | 'evidence') {
  const directory = path.join(dir, area);
  assertNoSymlink(dir, directory);
  let bytes = 0;
  let count = 0;
  let latestModified = 0;
  const fingerprint = crypto.createHash('sha256');
  const walk = (folder: string, depth: number) => {
    if (depth > 10 || count > MAX_SCAN_ENTRIES) throw new Error('Too many Brain files to safely scan.');
    assertNoSymlink(dir, folder);
    if (!fs.existsSync(folder)) return;
    for (const entry of fs.readdirSync(folder, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) throw new Error('Brain symlink encountered; refusing storage operation.');
      const full = path.join(folder, entry.name);
      assertNoSymlink(dir, full);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.isFile()) {
        const stat = fs.lstatSync(full);
        if (stat.nlink > 1) throw new Error('Hard-linked Brain file; refusing destructive operation.');
        count++;
        bytes += stat.size;
        latestModified = Math.max(latestModified, stat.mtimeMs);
        fingerprint.update(path.relative(directory, full) + ':' + stat.size + ':' + stat.mtimeMs + ':' + stat.ctimeMs + '\n');
      } else {
        throw new Error('Unsupported Brain filesystem entry; refusing storage operation.');
      }
    }
  };
  walk(directory, 0);
  return { area, files: count, bytes, lastModifiedAt: latestModified ? new Date(latestModified).toISOString() : null, fingerprint: fingerprint.digest('hex') };
}

export function brainStorageUsage(dir: string) {
  const areas = (['scratch', 'artifacts', 'evidence'] as const).map(a => scanBrainArea(dir, a));
  return { areas: areas.map(({ fingerprint, ...safe }) => safe), totalBytes: areas.reduce((sum, a) => sum + a.bytes, 0) };
}

/** Dry-run retention overview, scoped to the supplied Brain principal. */
export function previewBrainRetention(principal: string, requestedDays: number = 30, configRoot = getRootConfigDir()) {
  if (![7, 30, 90].includes(requestedDays)) throw new Error('Retention preview supports only 7, 30 or 90 days.');
  const sessions = listBrainSessions(principal, configRoot);
  const cutoff = Date.now() - requestedDays * 86_400_000;
  const candidates: Array<{ sessionId: string; scratchFiles: number; scratchBytes: number; lastModifiedAt: string | null }> = [];
  for (const item of sessions) {
    try {
      const dir = inspectBrainSession(principal, item.sessionId, configRoot).path;
      const area = scanBrainArea(dir, 'scratch');
      if (area.files && area.lastModifiedAt && Date.parse(area.lastModifiedAt) < cutoff) {
        candidates.push({
          sessionId: item.sessionId, scratchFiles: area.files, scratchBytes: area.bytes,
          lastModifiedAt: area.lastModifiedAt,
        });
      }
    } catch { /* Uninspectable sessions are never silently removed. */ }
  }
  return {
    days: requestedDays, dryRun: true, autoDelete: false, candidates, partial: sessions.length >= 100,
    totalCandidateBytes: candidates.reduce((sum, c) => sum + c.scratchBytes, 0),
  };
}

function claimOwner(authorization: unknown): string {
  const value = typeof authorization === 'string' ? authorization : '';
  if (!/^(Bearer|bearer) [^\s]{12,8192}$/.test(value)) throw new Error('Authenticated operator required.');
  return crypto.createHash('sha256').update(value).digest('hex');
}
function garbageCollect() {
  const now = Date.now();
  for (const [key, entry] of challengeStore) if (entry.expiresAt <= now) challengeStore.delete(key);
  // Bound memory even if many incomplete prepares are requested.
  while (challengeStore.size > 100) challengeStore.delete(challengeStore.keys().next().value!);
}

/** Fail closed when persisted CLI Bridge still reports a session-scratch job active.
 * Prevents a destructive cleanup while a delegated AGY/Claude command may be
 * writing into the directory. Stale active snapshots require operator triage.
 */
export function hasActiveBrainDelegation(configRoot: string, dir: string): boolean {
  const root = path.join(configRoot, 'cli-bridge', 'delegations', 'jobs.d');
  assertNoSymlink(configRoot, root);
  if (!fs.existsSync(root)) return false;
  const scratch = path.join(dir, 'scratch');
  const canonicalScratch = fs.realpathSync.native(scratch);
  const folders = fs.readdirSync(root, { withFileTypes: true });
  // Fail closed on unexpectedly huge or uninspectable delegation indexes.
  if (folders.length > 5000) throw new Error('Delegation index requires maintenance.');
  for (const entry of folders) {
    if (!entry.isDirectory() || !/^clj_\d+_[a-f0-9]{8,32}$/.test(entry.name)) continue;
    const directory = path.join(root, entry.name);
    assertNoSymlink(root, directory);
    const snapshots = fs.readdirSync(directory)
      .filter(name => /^\d{13}-\d{10}-[a-f0-9]{16}\.json$/.test(name)).sort().reverse().slice(0, 8);
    for (const snapshot of snapshots) {
      const file = path.join(directory, snapshot);
      assertNoSymlink(root, file);
      try {
        if (fs.statSync(file).size > 65536) continue;
        const job = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (job?.jobId !== entry.name || typeof job?.cwd !== 'string' || typeof job?.status !== 'string') continue;
        if (!fs.existsSync(job.cwd)) continue;
        const canonicalCwd = fs.realpathSync.native(job.cwd);
        if (process.platform === 'win32' ? canonicalCwd.toLowerCase() !== canonicalScratch.toLowerCase() : canonicalCwd !== canonicalScratch) break;
        if (['starting', 'running', 'cancelling'].includes(job.status)) return true;
        break;
      } catch { /* Check previous committed snapshot. */ }
    }
  }
  return false;
}

export function prepareBrainCleanup(authorization: unknown, sessionId: string, dir: string, configRoot = path.dirname(path.dirname(path.dirname(dir)))) {
  garbageCollect();
  const owner = claimOwner(authorization);
  if (hasActiveBrainDelegation(configRoot, dir)) throw new Error('Cannot clean scratch while delegation is active.');
  const scratch = scanBrainArea(dir, 'scratch');
  const challenge = crypto.randomBytes(24).toString('hex');
  challengeStore.set(challenge, {
    owner, action: 'clean-scratch', fingerprint: scratch.fingerprint, sessionId,
    expiresAt: Date.now() + CHALLENGE_TTL_MS, bytes: scratch.bytes,
  });
  return { sessionId, challenge, expiresInSeconds: 60, preview: {
    files: scratch.files, bytes: scratch.bytes, retained: ['artifacts/', 'evidence/', 'manifest.json'],
  } };
}

export function confirmBrainCleanup(authorization: unknown, sessionId: string, challenge: string, dir: string, configRoot = path.dirname(path.dirname(path.dirname(dir)))) {
  const entry = challengeStore.get(challenge);
  challengeStore.delete(challenge); // One-time regardless of validation outcome.
  if (!entry || entry.action !== 'clean-scratch' || entry.owner !== claimOwner(authorization) ||
      entry.sessionId !== sessionId || Date.now() >= entry.expiresAt) throw new Error('Invalid or expired Brain cleanup confirmation.');
  if (hasActiveBrainDelegation(configRoot, dir)) throw new Error('Delegation began while cleanup was pending.');
  const scratch = scanBrainArea(dir, 'scratch');
  if (scratch.fingerprint !== entry.fingerprint) throw new Error('Brain scratch changed since preview; refresh required.');
  const directory = path.join(dir, 'scratch');
  assertNoSymlink(dir, directory);
  // No artifact/evidence/manifests are ever touched.
  fs.rmSync(directory, { recursive: true, force: true });
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  return { success: true, sessionId, reclaimedBytes: entry.bytes, retained: ['artifacts/', 'evidence/', 'manifest.json'] };
}

const IMPORT_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.pdf', '.zip',
  '.mp4', '.webm', '.wav', '.mp3', '.csv', '.json', '.txt',
]);
export function importBrainBinaryArtifact(dir: string, fileName: string, content: Buffer) {
  if (!Buffer.isBuffer(content) || content.length === 0 || content.length > 5 * 1024 * 1024) {
    throw new Error('Binary import must be 1 byte–5 MiB.');
  }
  const relative = validateDestination('artifacts/' + fileName);
  if (fileName.includes('/') || fileName.includes('\\') ||
    !IMPORT_EXTENSIONS.has(path.extname(fileName).toLowerCase())) throw new Error('Unsupported artifact filename or type.');
  const destination = path.join(dir, relative);
  assertNoSymlink(dir, destination);
  const storage = brainStorageUsage(dir);
  if (storage.totalBytes + content.length > 50 * 1024 * 1024) throw new Error('Brain storage quota exceeded (50 MiB).');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  assertNoSymlink(dir, destination);
  const fd = fs.openSync(destination, 'wx', 0o600);
  try { fs.writeFileSync(fd, content); }
  catch (error) { fs.closeSync(fd); try { fs.unlinkSync(destination); } catch {} throw error; }
  fs.closeSync(fd);
  return { success: true, filePath: 'artifacts/' + fileName, bytes: content.length,
    sha256: crypto.createHash('sha256').update(content).digest('hex') };
}

export function prepareBrainPublish(
  authorization: unknown, sessionId: string, dir: string, filePath: string,
  projectRoot: string, destinationPath: string,
) {
  garbageCollect();
  const owner = claimOwner(authorization);
  if (!filePath.startsWith('artifacts/')) throw new Error('Only artifacts may be published.');
  const source = path.join(dir, validateDestination(filePath));
  assertNoSymlink(dir, source);
  const stat = fs.lstatSync(source);
  if (!stat.isFile() || stat.nlink > 1 || stat.size > MAX_BINARY_BYTES) throw new Error('Artifact is not a supported regular file (20 MiB max).');
  const canonicalRoot = fs.realpathSync.native(projectRoot);
  if (!fs.statSync(canonicalRoot).isDirectory()) throw new Error('Project root unavailable.');
  const safeDestination = validateDestination(destinationPath);
  const target = path.join(canonicalRoot, safeDestination);
  assertNoSymlink(canonicalRoot, target);
  if (fs.existsSync(target)) throw new Error('Destination exists; publish never overwrites.');
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex');
  const challenge = crypto.randomBytes(24).toString('hex');
  challengeStore.set(challenge, {
    owner, action: 'publish', fingerprint: sha256, sessionId, filePath,
    destinationPath, projectRoot: canonicalRoot, expiresAt: Date.now() + CHALLENGE_TTL_MS, bytes: stat.size,
  });
  return { sessionId, challenge, expiresInSeconds: 60, preview: {
    filePath, destinationPath, projectRoot: canonicalRoot, bytes: stat.size, sha256, overwrite: false,
  } };
}

export function confirmBrainPublish(
  authorization: unknown, sessionId: string, challenge: string, dir: string,
  projectRoot: string, authorized: boolean,
) {
  const entry = challengeStore.get(challenge);
  challengeStore.delete(challenge);
  if (!entry || entry.action !== 'publish' || entry.owner !== claimOwner(authorization) ||
    entry.sessionId !== sessionId || Date.now() >= entry.expiresAt) throw new Error('Invalid or expired publish confirmation.');
  if (!authorized) throw new Error('Registered project access was revoked.');
  const canonicalRoot = fs.realpathSync.native(projectRoot);
  if (canonicalRoot !== entry.projectRoot) throw new Error('Project root changed since preview.');
  const source = path.join(dir, validateDestination(entry.filePath!));
  assertNoSymlink(dir, source);
  const stat = fs.lstatSync(source);
  if (!stat.isFile() || stat.nlink > 1 || stat.size > MAX_BINARY_BYTES) throw new Error('Artifact changed since preview.');
  // Capture one immutable payload. Never hash one version and then copy a second
  // version if another process edits the source during publication.
  const bytes = fs.readFileSync(source);
  if (bytes.length !== entry.bytes || crypto.createHash('sha256').update(bytes).digest('hex') !== entry.fingerprint) {
    throw new Error('Artifact changed since preview.');
  }
  const target = path.join(canonicalRoot, validateDestination(entry.destinationPath!));
  assertNoSymlink(canonicalRoot, target);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  assertNoSymlink(canonicalRoot, target);
  const fd = fs.openSync(target, 'wx', 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); }
  catch (error) { fs.closeSync(fd); try { fs.unlinkSync(target); } catch {} throw error; }
  fs.closeSync(fd);
  return { success: true, sessionId, destinationPath: entry.destinationPath, bytes: bytes.length, sha256: entry.fingerprint };
}
