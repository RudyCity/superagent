/**
 * Secret store: AES-256-GCM encryption-at-rest for secrets persisted to
 * `~/.superagent-r/model-config.json`.
 *
 * Audit fix C2: previously the file held raw API keys in plain text. A
 * single accidental copy, log dump, or backup left the user's
 * credentials in the clear. We now encrypt the `apiKey` field of every
 * ProviderProfile before it touches disk, and decrypt on read.
 *
 * Design choices:
 * - Algorithm: AES-256-GCM (authenticated encryption; detects
 *   tampering). Each ciphertext has a fresh 12-byte IV and a 16-byte
 *   authentication tag. Format on disk:
 *     "enc:v1:<base64(iv|tag|ciphertext)>"
 *   The "enc:v1:" prefix lets us detect/upgrade old plaintext values
 *   that were saved before this change.
 * - Master key: derived from a per-machine secret stored at
 *   `~/.superagent-r/.secret-key` (32 random bytes, base64-encoded).
 *   The file is created on first use with `fs.chmod 0o600` (owner
 *   read/write only). If the file already exists with a different
 *   size or content we re-use it. Without this key, encrypted values
 *   become unreadable — callers MUST treat a missing key file as
 *   "no secret can be decrypted", never as a hard error.
 * - Backwards compat: when reading, plaintext values are returned
 *   as-is. This means an existing `model-config.json` that still
 *   contains plaintext keys continues to work; the next time the
 *   user saves a provider, the plaintext is replaced with the
 *   encrypted form automatically.
 * - We deliberately do NOT use the OS keychain (DPAPI on Windows,
 *   Keychain on macOS, libsecret on Linux) to keep this code 100%
 *   portable and dependency-free. The on-disk key file is the
 *   threat-model boundary; the user is expected to keep the
 *   `~/.superagent-r/` directory's filesystem permissions tight.
 *
 * What is NOT in scope:
 * - This module does NOT log, print, or echo keys. It only returns
 *   plaintext on `decrypt()` calls from the config layer.
 * - It does NOT handle in-memory exposure (heap dumps, debug logs).
 *   Those require external controls.
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { getRootConfigDir } from "./paths.js";

const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
const PREFIX = "enc:v1:";
const KEY_FILE = ".secret-key";

function keyFilePath(): string {
  return path.join(getRootConfigDir(), KEY_FILE);
}

let _cachedKey: Buffer | null = null;

/**
 * Read (or lazily create) the 32-byte master key.
 *
 * Side effects: on first call in a fresh install, writes a 32-byte
 * random key to `~/.superagent-r/.secret-key` with mode 0600.
 */
export function getOrCreateMasterKey(): Buffer {
  if (_cachedKey) return _cachedKey;
  const kf = keyFilePath();
  const dir = path.dirname(kf);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (fs.existsSync(kf)) {
    const raw = fs.readFileSync(kf, "utf-8").trim();
    // Tolerate base64 (preferred) and raw hex for forward compatibility.
    let buf: Buffer;
    try {
      buf = Buffer.from(raw, "base64");
    } catch {
      buf = Buffer.from(raw, "hex");
    }
    if (buf.length === KEY_LEN) {
      _cachedKey = buf;
      return buf;
    }
    // Wrong size — refuse to overwrite silently. The user must
    // delete the file (and any encrypted values become unreadable).
    throw new Error(
      `${KEY_FILE} has unexpected size ${buf.length} bytes; expected ${KEY_LEN}. Refusing to overwrite. Delete it (and any encrypted values will be lost) or restore from a backup.`
    );
  }
  const fresh = crypto.randomBytes(KEY_LEN);
  fs.writeFileSync(kf, fresh.toString("base64"), { mode: 0o600 });
  // On some platforms mode is masked by umask; chmod again.
  try {
    fs.chmodSync(kf, 0o600);
  } catch {
    /* best-effort */
  }
  _cachedKey = fresh;
  return fresh;
}

/**
 * Encrypt a UTF-8 string. Returns the on-disk representation:
 *   "enc:v1:<base64(iv|tag|ciphertext)>"
 *
 * Empty / undefined inputs are returned as empty strings so the
 * caller can store them in JSON without producing "enc:v1:" of an
 * empty value.
 */
export function encryptSecret(plaintext: string | undefined | null): string {
  if (plaintext === undefined || plaintext === null || plaintext === "") {
    return "";
  }
  if (typeof plaintext !== "string") {
    throw new TypeError("encryptSecret: expected string");
  }
  const key = getOrCreateMasterKey();
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const blob = Buffer.concat([iv, tag, enc]).toString("base64");
  return PREFIX + blob;
}

/**
 * Decrypt a previously-encrypted value. Accepts:
 *   - the `enc:v1:...` envelope → plaintext
 *   - any other string → returned as-is (backwards compat with
 *     pre-encryption plain values still in the user's JSON)
 *   - empty / undefined → empty string
 *
 * If decryption fails (corrupted envelope, wrong key), the value
 * is treated as lost: a warning is logged and an empty string is
 * returned. We never throw from this function, because a corrupt
 * key should not crash the entire model-config loader.
 */
export function decryptSecret(stored: string | undefined | null): string {
  if (stored === undefined || stored === null || stored === "") {
    return "";
  }
  if (typeof stored !== "string") return "";
  if (!stored.startsWith(PREFIX)) {
    // Legacy plain value — pass through.
    return stored;
  }
  const b64 = stored.slice(PREFIX.length);
  let blob: Buffer;
  try {
    blob = Buffer.from(b64, "base64");
  } catch {
    return "";
  }
  if (blob.length < IV_LEN + TAG_LEN + 1) {
    console.warn("[secretStore] encrypted value too short; treating as empty");
    return "";
  }
  const iv = blob.subarray(0, IV_LEN);
  const tag = blob.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const enc = blob.subarray(IV_LEN + TAG_LEN);
  let key: Buffer;
  try {
    key = getOrCreateMasterKey();
  } catch (err) {
    console.warn(
      "[secretStore] cannot load master key; returning empty secret:",
      (err as Error).message
    );
    return "";
  }
  try {
    const decipher = crypto.createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    const out = Buffer.concat([decipher.update(enc), decipher.final()]);
    return out.toString("utf-8");
  } catch (err) {
    console.warn(
      "[secretStore] decryption failed (corrupt value or wrong key); returning empty secret:",
      (err as Error).message
    );
    return "";
  }
}

/**
 * Return true if the given string is already an encrypted envelope.
 * Used by config writers to decide whether a value needs to be
 * re-encrypted before persistence.
 */
export function isEncrypted(stored: string | undefined | null): boolean {
  return typeof stored === "string" && stored.startsWith(PREFIX);
}

/**
 * Test-only: forget the cached key. Production code should never
 * need this — the key is stable for the lifetime of the process.
 */
export function _resetSecretStoreForTests(): void {
  _cachedKey = null;
}
