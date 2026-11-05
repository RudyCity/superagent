/** Durable proofs for paired Delegate profiles.
 *
 * Chrome holds a random 256-bit bearer token. The Core stores only its SHA-256
 * digest (never the bearer), bound to the exact extension origin and client ID.
 * The local profile directory supplies the filesystem access boundary.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getRootConfigDir } from "../config/paths.js";

export type PairedClientProof = { extensionId: string; tokenDigest: string };
const CLIENT_ID_RE = /^[a-zA-Z0-9_-]{8,80}$/;
const EXTENSION_ID_RE = /^[a-p]{32}$/;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const MAX_PAIRS = 32;
const MAX_STORE_BYTES = 12_000;

export function defaultDelegatePairStorePath(): string {
  return join(getRootConfigDir(), "delegate", "paired-profiles-v1.json");
}

export function digestDelegateToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function matchesDelegateTokenDigest(digest: string, candidate: unknown): boolean {
  if (!DIGEST_RE.test(digest) || typeof candidate !== "string" ||
    candidate.length < 32 || candidate.length > 512) return false;
  return timingSafeEqual(Buffer.from(digest, "hex"),
    createHash("sha256").update(candidate).digest());
}

export function loadDelegatePairProofs(file: string): Map<string, PairedClientProof> {
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_STORE_BYTES) return new Map();
    const document: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!document || typeof document !== "object" || Array.isArray(document)) return new Map();
    const { version, clients } = document as Record<string, unknown>;
    if (version !== 1 || !Array.isArray(clients) || clients.length > MAX_PAIRS) return new Map();
    const result = new Map<string, PairedClientProof>();
    for (const record of clients) {
      if (!record || typeof record !== "object" || Array.isArray(record)) return new Map();
      const { clientId, extensionId, tokenDigest } = record as Record<string, unknown>;
      if (typeof clientId !== "string" || !CLIENT_ID_RE.test(clientId) ||
        typeof extensionId !== "string" || !EXTENSION_ID_RE.test(extensionId) ||
        typeof tokenDigest !== "string" || !DIGEST_RE.test(tokenDigest) ||
        result.has(clientId)) return new Map();
      result.set(clientId, { extensionId, tokenDigest });
    }
    return result;
  } catch { return new Map(); }
}

export function saveDelegatePairProofs(file: string, clients: Map<string, PairedClientProof>): void {
  if (clients.size > MAX_PAIRS) throw new Error("DELEGATE_PAIR_LIMIT");
  const rows = Array.from(clients, ([clientId, proof]) => {
    if (!CLIENT_ID_RE.test(clientId) || !EXTENSION_ID_RE.test(proof.extensionId) ||
      !DIGEST_RE.test(proof.tokenDigest)) throw new Error("DELEGATE_PAIR_RECORD_INVALID");
    return { clientId, extensionId: proof.extensionId, tokenDigest: proof.tokenDigest };
  });
  const directory = dirname(file);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (existsSync(file)) {
    const info = lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error("DELEGATE_PAIR_STORE_UNSAFE");
  }
  const tmp = join(directory, ".delegate-pairs-" + randomBytes(8).toString("hex") + ".tmp");
  try {
    writeFileSync(tmp, JSON.stringify({ version: 1, clients: rows }), {
      encoding: "utf8", mode: 0o600, flag: "wx",
    });
    renameSync(tmp, file);
  } finally {
    try { unlinkSync(tmp); } catch { /* Atomic rename consumed the temp file. */ }
  }
}
