/**
 * Durable, session-scoped scratch and artifacts, separate from project repositories.
 * Never use this as an authorization grant for a project or a shell sandbox.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { getRootConfigDir } from "../config/paths.js";

export type BrainArea = "scratch" | "artifacts" | "evidence";
export interface BrainManifest {
  schemaVersion: 1;
  sessionId: string;
  ownerHash: string;
  createdAt: string;
  updatedAt: string;
}

const MAX_FILE_BYTES = 256 * 1024;
const MAX_SESSION_BYTES = 10 * 1024 * 1024;

function safeSessionId(sessionId: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(sessionId)) {
    throw new Error("Invalid brain sessionId (use letters, numbers, underscores, hyphens; max 96).");
  }
  return sessionId;
}

function ownerHash(owner: string): string {
  if (!owner || owner.length > 2048) throw new Error("Invalid brain principal.");
  return crypto.createHash("sha256").update(owner).digest("hex").slice(0, 24);
}

function rootFor(owner: string, configRoot: string): string {
  return path.join(configRoot, "brain", ownerHash(owner));
}

function sessionDir(owner: string, sessionId: string, configRoot: string): string {
  return path.join(rootFor(owner, configRoot), safeSessionId(sessionId));
}

function rejectSymlinkComponents(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Brain path escapes its root.");
  // Include root and all existing descendants. Prevent following pre-existing links.
  let current = root;
  if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error("Brain symlink boundary.");
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error("Brain symlink boundary.");
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

function safeRelativeFile(file: string): string {
  if (typeof file !== "string" || file.length < 1 || file.length > 240 ||
      path.isAbsolute(file) || /^[a-zA-Z]:/.test(file) || file.includes("\\") || file.includes("\0")) {
    throw new Error("Invalid brain relative file path.");
  }
  const parts = file.split("/");
  if (parts.length > 8 || parts.some((p) => !p || p === "." || p === ".." ||
      p.startsWith(".") || p.endsWith(".") || /[:<>|?*"\\]/.test(p) ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) {
    throw new Error("Unsafe brain relative file path.");
  }
  if (!["scratch", "artifacts", "evidence"].includes(parts[0]) || parts.length < 2) {
    throw new Error("Brain files must be in scratch/, artifacts/ or evidence/.");
  }
  return path.join(...parts);
}

function existingSession(owner: string, sessionId: string, configRoot: string): { dir: string; manifest: BrainManifest } {
  const dir = sessionDir(owner, sessionId, configRoot);
  rejectSymlinkComponents(path.join(configRoot, "brain"), dir);
  const file = path.join(dir, "manifest.json");
  rejectSymlinkComponents(dir, file);
  if (!fs.existsSync(file)) throw new Error("Brain session not found.");
  const manifest = JSON.parse(fs.readFileSync(file, "utf8")) as BrainManifest;
  if (manifest.schemaVersion !== 1 || manifest.ownerHash !== ownerHash(owner) || manifest.sessionId !== sessionId) {
    throw new Error("Brain session manifest is invalid or belongs to another principal.");
  }
  return { dir, manifest };
}

export function createBrainSession(owner: string, sessionId: string = crypto.randomUUID(), configRoot = getRootConfigDir()) {
  const dir = sessionDir(owner, sessionId, configRoot);
  rejectSymlinkComponents(path.join(configRoot, "brain"), dir);
  if (fs.existsSync(path.join(dir, "manifest.json"))) return inspectBrainSession(owner, sessionId, configRoot);
  if (fs.existsSync(dir)) throw new Error("Brain session directory already exists without a manifest.");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const area of ["scratch", "scratch/scripts", "scratch/experiments", "scratch/temporary", "artifacts", "evidence"]) {
    fs.mkdirSync(path.join(dir, area), { recursive: true, mode: 0o700 });
  }
  const now = new Date().toISOString();
  const manifest: BrainManifest = { schemaVersion: 1, sessionId, ownerHash: ownerHash(owner), createdAt: now, updatedAt: now };
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2), { flag: "wx", mode: 0o600 });
  return { ...manifest, path: dir, scratchPath: path.join(dir, "scratch"), artifactsPath: path.join(dir, "artifacts") };
}

export function inspectBrainSession(owner: string, sessionId: string, configRoot = getRootConfigDir()) {
  const { dir, manifest } = existingSession(owner, sessionId, configRoot);
  return { ...manifest, path: dir, scratchPath: path.join(dir, "scratch"), artifactsPath: path.join(dir, "artifacts") };
}

export function listBrainSessions(owner: string, configRoot = getRootConfigDir()): BrainManifest[] {
  const root = rootFor(owner, configRoot);
  rejectSymlinkComponents(path.join(configRoot, "brain"), root);
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory())
    .flatMap((e) => {
      try { return [existingSession(owner, e.name, configRoot).manifest]; }
      catch { return []; }
    }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 100);
}

export function listBrainFiles(owner: string, sessionId: string, configRoot = getRootConfigDir()) {
  const { dir } = existingSession(owner, sessionId, configRoot);
  const files: Array<{ path: string; bytes: number }> = [];
  const visit = (current: string, depth: number) => {
    if (depth > 8 || files.length >= 250) return;
    rejectSymlinkComponents(dir, current);
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (files.length >= 250) return;
      if (entry.isSymbolicLink()) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) visit(full, depth + 1);
      else if (entry.isFile()) files.push({ path: path.relative(dir, full).replace(/\\/g, "/"), bytes: fs.statSync(full).size });
    }
  };
  for (const area of ["scratch", "artifacts", "evidence"]) visit(path.join(dir, area), 0);
  return files;
}

export function readBrainFile(owner: string, sessionId: string, relativePath: string, configRoot = getRootConfigDir()) {
  const { dir } = existingSession(owner, sessionId, configRoot);
  const target = path.join(dir, safeRelativeFile(relativePath));
  rejectSymlinkComponents(dir, target);
  if (fs.statSync(target).size > MAX_FILE_BYTES) throw new Error("Brain file exceeds read limit.");
  return fs.readFileSync(target, "utf8");
}

export function writeBrainFile(
  owner: string, sessionId: string, relativePath: string, content: string,
  overwrite = false, configRoot = getRootConfigDir(),
) {
  if (typeof content !== "string" || Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) {
    throw new Error("Brain file exceeds 256 KiB text write limit.");
  }
  const { dir } = existingSession(owner, sessionId, configRoot);
  const target = path.join(dir, safeRelativeFile(relativePath));
  rejectSymlinkComponents(dir, target);
  if (!overwrite && fs.existsSync(target)) throw new Error("Brain file exists; set overwrite=true.");
  const fileTotals = listBrainFiles(owner, sessionId, configRoot);
  const previous = fs.existsSync(target) ? fs.statSync(target).size : 0;
  const total = fileTotals.reduce((sum, item) => sum + item.bytes, 0) - previous + Buffer.byteLength(content, "utf8");
  if (total > MAX_SESSION_BYTES) throw new Error("Brain session exceeds 10 MiB quota.");
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  rejectSymlinkComponents(dir, target);
  const temp = path.join(path.dirname(target), `.brain-${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temp, content, { flag: "wx", mode: 0o600 });
    if (overwrite) fs.renameSync(temp, target);
    else fs.copyFileSync(temp, target, fs.constants.COPYFILE_EXCL);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
  return { sessionId, relativePath: relativePath.replace(/\\/g, "/"), bytes: Buffer.byteLength(content, "utf8") };
}

export function getBrainScratchPath(owner: string, sessionId: string, configRoot = getRootConfigDir()): string {
  const { dir } = existingSession(owner, sessionId, configRoot);
  const scratch = path.join(dir, "scratch");
  rejectSymlinkComponents(dir, scratch);
  if (!fs.existsSync(scratch)) fs.mkdirSync(scratch, { recursive: true, mode: 0o700 });
  return scratch;
}

/**
 * Explicitly publish a *text* artifact to an already-authorized local project.
 * Access checks belong to the invoking MCP workspace/project policy.
 * Never overwrite an existing project file or follow a symlink destination.
 */
export function publishBrainArtifact(
  owner: string, sessionId: string, filePath: string, projectRoot: string,
  destinationPath: string, configRoot = getRootConfigDir(),
) {
  if (!filePath.startsWith("artifacts/")) throw new Error("Only artifacts/ files may be published.");
  const source = path.join(existingSession(owner, sessionId, configRoot).dir, safeRelativeFile(filePath));
  rejectSymlinkComponents(sessionDir(owner, sessionId, configRoot), source);
  if (!fs.statSync(source).isFile()) throw new Error("Artifact source must be a regular file.");
  const stat = fs.statSync(source);
  if (stat.size > MAX_FILE_BYTES) throw new Error("Artifact exceeds publish limit.");
  if (!destinationPath || destinationPath.length > 240 ||
    path.isAbsolute(destinationPath) || /^[a-zA-Z]:/.test(destinationPath) ||
    destinationPath.includes("\\") || destinationPath.includes("\0")) {
    throw new Error("Invalid publish destination.");
  }
  const parts = destinationPath.split("/");
  if (parts.length > 8 || parts.some(p => !p || p === "." || p === ".." ||
    p.startsWith(".") || p.endsWith(".") || /[:<>|?*"\\]/.test(p) ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) {
    throw new Error("Unsafe publish destination.");
  }
  if (!fs.existsSync(projectRoot) || !fs.statSync(projectRoot).isDirectory()) {
    throw new Error("Project root not available.");
  }
  // The resolved root may itself be registered via a symlink; honor its canonical
  // boundary but never traverse symlinks *inside* the destination hierarchy.
  const realRoot = fs.realpathSync(projectRoot);
  const target = path.join(realRoot, ...parts);
  rejectSymlinkComponents(realRoot, target);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  rejectSymlinkComponents(realRoot, target);
  fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
  const hash = crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex");
  return { sessionId, filePath, destinationPath, bytes: stat.size, sha256: hash, published: true };
}

export function cleanBrainScratch(owner: string, sessionId: string, confirmation: string, configRoot = getRootConfigDir()) {
  if (confirmation !== sessionId) throw new Error("Confirm cleanup with the exact sessionId.");
  const { dir } = existingSession(owner, sessionId, configRoot);
  const scratch = path.join(dir, "scratch");
  rejectSymlinkComponents(dir, scratch);
  // Artifacts/evidence and the manifest intentionally survive cleanup.
  fs.rmSync(scratch, { recursive: true, force: true });
  fs.mkdirSync(scratch, { mode: 0o700 });
  return { sessionId, cleaned: "scratch", retained: ["artifacts", "evidence", "manifest.json"] };
}
