import crypto from "node:crypto";
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";

/**
 * SAFOLDER1 is nine ASCII bytes (despite the original protocol brief calling
 * it eight). Both Java and TypeScript use the literal nine-byte marker.
 * The transfer of this buffer still requires the existing approved file
 * transfer; this module intentionally never opens a network connection.
 */
export const FOLDER_MAGIC = Buffer.from("SAFOLDER1", "ascii");
export const FOLDER_PACKAGE_MAX_BYTES = 4 * 1024 * 1024;
export const FOLDER_MANIFEST_MAX_BYTES = 32 * 1024;
export const FOLDER_MAX_FILES = 64;
export const FOLDER_MAX_NESTED_LEVELS = 8;

export interface FolderEntry {
  path: string;
  size: number;
  sha256: string;
}
export interface FolderManifest {
  version: 1;
  files: FolderEntry[];
}
export interface UnpackedFolder {
  directory: string;
  files: string[];
  manifest: FolderManifest;
}

const COMPONENT = /^[A-Za-z0-9_][A-Za-z0-9_ .()-]{0,95}$/;
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const SENSITIVE = /(?:^|[_ .(-])(?:secret|secrets|password|passwords|passwd|credential|credentials|private|token|tokens|apikey|api-key|accesskey|access-key|id_rsa|id_dsa|id_ecdsa|id_ed25519|keystore|wallet|recovery|seedphrase)(?:$|[_ .)-])/i;
const SENSITIVE_SUFFIX = /\.(?:pem|key|p12|pfx|jks|kdbx|asc)$/i;
const hash = (bytes: Uint8Array) => crypto.createHash("sha256").update(bytes).digest("hex");

export function validateFolderRelativePath(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 900 ||
      value.startsWith("/") || value.includes("\\") || value.includes(":") ||
      /[\u0000-\u001f\u007f]/.test(value)) {
    throw Error("Unsafe folder package path.");
  }
  const pieces = value.split("/");
  if (pieces.length < 1 || pieces.length > FOLDER_MAX_NESTED_LEVELS + 1) {
    throw Error("Folder package nesting limit exceeded.");
  }
  for (const part of pieces) {
    if (!part || part === "." || part === ".." || part.startsWith(".") ||
        part.endsWith(".") || part.endsWith(" ") || !COMPONENT.test(part) ||
        WINDOWS_DEVICE.test(part) || SENSITIVE.test(part) ||
        SENSITIVE_SUFFIX.test(part)) {
      throw Error("Hidden, sensitive, or unsafe folder package name.");
    }
  }
  return value;
}

function checkedManifest(value: unknown): FolderManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid folder manifest.");
  const obj = value as Record<string, unknown>;
  if (Object.keys(obj).length !== 2 || !Object.hasOwn(obj, "version") ||
      !Object.hasOwn(obj, "files") || obj.version !== 1 || !Array.isArray(obj.files) ||
      obj.files.length < 1 || obj.files.length > FOLDER_MAX_FILES) {
    throw Error("Invalid folder manifest version or file count.");
  }
  const seen = new Set<string>();
  const entries: FolderEntry[] = [];
  let contentBytes = 0;
  for (const item of obj.files) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw Error("Invalid folder entry.");
    const raw = item as Record<string, unknown>;
    if (Object.keys(raw).length !== 3 || !Object.hasOwn(raw, "path") ||
        !Object.hasOwn(raw, "size") || !Object.hasOwn(raw, "sha256")) {
      throw Error("Unexpected folder manifest entry property.");
    }
    const relative = validateFolderRelativePath(raw.path);
    const key = relative.toLowerCase();
    if (seen.has(key)) throw Error("Duplicate folder package path.");
    seen.add(key);
    if (typeof raw.size !== "number" || !Number.isSafeInteger(raw.size) ||
        raw.size < 0 || raw.size > FOLDER_PACKAGE_MAX_BYTES ||
        typeof raw.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(raw.sha256)) {
      throw Error("Invalid folder entry size or SHA-256.");
    }
    contentBytes += raw.size;
    if (contentBytes > FOLDER_PACKAGE_MAX_BYTES) throw Error("Folder content exceeds 4 MiB.");
    entries.push({ path: relative, size: raw.size, sha256: raw.sha256 });
  }
  for (const key of seen) {
    const pieces = key.split("/");
    for (let i = 1; i < pieces.length; i++) {
      if (seen.has(pieces.slice(0, i).join("/"))) {
        throw Error("Folder entry conflicts with directory name.");
      }
    }
  }
  return { version: 1, files: entries };
}

function decodedPackage(input: Uint8Array): { manifest: FolderManifest; chunks: Buffer[] } {
  if (!(input instanceof Uint8Array) || input.byteLength > FOLDER_PACKAGE_MAX_BYTES ||
      input.byteLength < FOLDER_MAGIC.length + 4) {
    throw Error("Invalid or oversized folder package.");
  }
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (!bytes.subarray(0, FOLDER_MAGIC.length).equals(FOLDER_MAGIC)) throw Error("Invalid SAFOLDER1 header.");
  const manifestSize = bytes.readUInt32BE(FOLDER_MAGIC.length);
  const manifestStart = FOLDER_MAGIC.length + 4;
  if (manifestSize < 1 || manifestSize > FOLDER_MANIFEST_MAX_BYTES ||
      manifestStart + manifestSize > bytes.length) throw Error("Invalid folder manifest length.");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
      .decode(bytes.subarray(manifestStart, manifestStart + manifestSize));
  } catch { throw Error("Malformed UTF-8 folder manifest."); }
  if (text.charCodeAt(0) === 0xfeff) throw Error("BOM is not allowed in the manifest.");
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw Error("Malformed JSON folder manifest."); }
  const manifest = checkedManifest(value);
  let offset = manifestStart + manifestSize;
  const chunks: Buffer[] = [];
  for (const entry of manifest.files) {
    if (offset + entry.size > bytes.length) throw Error("Truncated folder package payload.");
    const chunk = bytes.subarray(offset, offset + entry.size);
    if (hash(chunk) !== entry.sha256) throw Error("Folder package SHA-256 mismatch.");
    chunks.push(chunk);
    offset += entry.size;
  }
  if (offset !== bytes.length) throw Error("Folder package trailing bytes.");
  return { manifest, chunks };
}

export function inspectFolderPackage(input: Uint8Array): FolderManifest {
  return decodedPackage(input).manifest;
}

function isWithin(root: string, location: string): boolean {
  const relative = path.relative(root, location);
  return relative === "" || (relative !== ".." && !relative.startsWith(".." + path.sep) &&
    !path.isAbsolute(relative));
}

/** The caller must explicitly select the local folder. No hidden files are skipped. */
export async function packFolder(root: string): Promise<Buffer> {
  const base = path.resolve(root);
  validateFolderRelativePath(path.basename(base)); // refuse hidden/sensitive selected roots
  const rootInfo = await fs.lstat(base);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw Error("Select a real local directory.");
  const canonicalRoot = await fs.realpath(base);
  const collected: Array<{ entry: FolderEntry; bytes: Buffer }> = [];
  let payloadSize = 0;

  async function walk(directory: string, prefix: string, depth: number): Promise<void> {
    const actual = await fs.realpath(directory);
    if (!isWithin(canonicalRoot, actual)) throw Error("Folder directory escaped its root.");
    const names = (await fs.readdir(directory)).sort();
    if (!names.length) throw Error("Empty directories cannot be represented in SAFOLDER1.");
    for (const name of names) {
      const relative = prefix ? prefix + "/" + name : name;
      validateFolderRelativePath(relative);
      const location = path.join(directory, name);
      const before = await fs.lstat(location);
      if (before.isSymbolicLink()) throw Error("Symlinks are not allowed in folder packages.");
      if (before.isDirectory()) {
        if (depth >= FOLDER_MAX_NESTED_LEVELS) throw Error("Folder nesting limit exceeded.");
        await walk(location, relative, depth + 1);
        continue;
      }
      if (!before.isFile() || !Number.isSafeInteger(before.size) ||
          before.size > FOLDER_PACKAGE_MAX_BYTES) throw Error("Only bounded regular files are supported.");
      if (collected.length >= FOLDER_MAX_FILES) throw Error("Folder file count limit exceeded.");
      payloadSize += before.size;
      if (payloadSize > FOLDER_PACKAGE_MAX_BYTES) throw Error("Folder content exceeds 4 MiB.");
      // O_NOFOLLOW refuses a substituted final-component symlink. Verify the
      // opened file and its canonical location before and after reading.
      const fd = await fs.open(location, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
      let bytes: Buffer;
      try {
        const openInfo = await fd.stat();
        const real = await fs.realpath(location);
        if (!isWithin(canonicalRoot, real) || !openInfo.isFile() ||
            openInfo.ino !== before.ino || openInfo.dev !== before.dev ||
            openInfo.size !== before.size) throw Error("Folder entry changed during selection.");
        bytes = await fd.readFile();
        const after = await fd.stat();
        if (bytes.length !== before.size || after.size !== before.size ||
            after.mtimeMs !== openInfo.mtimeMs || after.ino !== openInfo.ino ||
            !isWithin(canonicalRoot, await fs.realpath(location))) {
          throw Error("Folder entry changed during packaging.");
        }
      } finally { await fd.close(); }
      collected.push({ entry: { path: relative, size: bytes.length, sha256: hash(bytes) }, bytes });
    }
  }
  await walk(base, "", 0);
  collected.sort((a, b) => a.entry.path < b.entry.path ? -1 : a.entry.path > b.entry.path ? 1 : 0);
  const manifest: FolderManifest = checkedManifest({ version: 1, files: collected.map((f) => f.entry) });
  const manifestBytes = Buffer.from(JSON.stringify(manifest), "utf8");
  if (manifestBytes.length > FOLDER_MANIFEST_MAX_BYTES) throw Error("Folder manifest exceeds 32 KiB.");
  const total = FOLDER_MAGIC.length + 4 + manifestBytes.length + payloadSize;
  if (total > FOLDER_PACKAGE_MAX_BYTES) throw Error("Folder package exceeds 4 MiB including manifest.");
  const header = Buffer.alloc(FOLDER_MAGIC.length + 4);
  FOLDER_MAGIC.copy(header);
  header.writeUInt32BE(manifestBytes.length, FOLDER_MAGIC.length);
  return Buffer.concat([header, manifestBytes, ...collected.map((f) => f.bytes)], total);
}

/** Extract only into an existing, caller-chosen local parent; always create a private unique child. */
export async function unpackFolderPackage(input: Uint8Array, outputDirectory: string): Promise<UnpackedFolder> {
  const { manifest, chunks } = decodedPackage(input); // fully authenticate before writing
  const parent = path.resolve(outputDirectory);
  const parentInfo = await fs.lstat(parent);
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) {
    throw Error("Extraction parent must be an existing non-symlink directory.");
  }
  const safeParent = await fs.realpath(parent);
  const destination = await fs.mkdtemp(path.join(safeParent, "SuperAgent-LAN-"));
  const written: string[] = [];
  try {
    for (let i = 0; i < manifest.files.length; i++) {
      const relative = manifest.files[i].path;
      const target = path.join(destination, ...relative.split("/"));
      if (!isWithin(destination, target)) throw Error("Unsafe extraction destination.");
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      const handle = await fs.open(target, fsConstants.O_WRONLY | fsConstants.O_CREAT |
        fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW || 0), 0o600);
      try { await handle.writeFile(chunks[i]); } finally { await handle.close(); }
      written.push(target);
    }
    return { directory: destination, files: written, manifest };
  } catch (error) {
    await fs.rm(destination, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

