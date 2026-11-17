/**
 * One-use, locally keyed proof for attended native Tray project mutations.
 * A Core bearer alone is insufficient. The private key is never sent to
 * WebView, HTTP clients, MCP tools, tunnels or logs.
 *
 * Same-OS-user malware could read a user-owned key; stronger OS IPC/keystore
 * attestation is a separate release-security requirement.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getRootConfigDir } from "../config/paths.js";

const KEY_FILE = ".mcp-project-operator.key";
const TTL = 30_000;
const MAX_PENDING = 8;
const PREFIX = "superagent-project-operator-v1:";
const fail = (): never => { throw new Error("PROJECT_OPERATOR_PROOF_REQUIRED"); };

function localKey(): Buffer {
  const root = getRootConfigDir();
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(root).isSymbolicLink()) fail();
  const file = path.join(root, KEY_FILE);
  try {
    const fd = fs.openSync(file, "wx", 0o600);
    try { fs.writeSync(fd, crypto.randomBytes(32).toString("hex") + "\n"); }
    finally { fs.closeSync(fd); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 64 ||
      stat.size > 80 || (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) fail();
  const raw = fs.readFileSync(file, "ascii").trim();
  if (!/^[a-f0-9]{64}$/.test(raw)) fail();
  return Buffer.from(raw, "hex");
}

export class ProjectOperatorProof {
  private readonly pending = new Map<string, number>();
  constructor(private readonly key: () => Buffer = localKey,
    private readonly now: () => number = Date.now) {}

  issue(): { nonce: string; expiresAt: number } {
    this.key();
    for (const [nonce, expires] of this.pending)
      if (expires <= this.now()) this.pending.delete(nonce);
    if (this.pending.size >= MAX_PENDING) fail();
    const nonce = crypto.randomBytes(24).toString("hex");
    const expiresAt = this.now() + TTL;
    this.pending.set(nonce, expiresAt);
    return { nonce, expiresAt };
  }

  consume(input: unknown): Record<string, unknown> {
    if (!input || typeof input !== "object" || Array.isArray(input)) fail();
    const packet = input as Record<string, unknown>;
    if (Object.keys(packet).sort().join() !== "payloadText,proof" ||
        typeof packet.payloadText !== "string" || packet.payloadText.length > 7500) fail();
    const p = packet.proof;
    if (!p || typeof p !== "object" || Array.isArray(p)) fail();
    const proof = p as Record<string, unknown>;
    if (Object.keys(proof).sort().join() !== "mac,nonce" ||
        typeof proof.nonce !== "string" || !/^[a-f0-9]{48}$/.test(proof.nonce) ||
        typeof proof.mac !== "string" || !/^[a-f0-9]{64}$/.test(proof.mac)) fail();
    const nonce = proof.nonce as string;
    const mac = proof.mac as string;
    const payloadText = packet.payloadText as string;
    const expires = this.pending.get(nonce);
    this.pending.delete(nonce); // burn even forged attempts
    if (!expires || expires <= this.now()) fail();
    const expected = crypto.createHmac("sha256", this.key())
      .update(PREFIX + nonce + ":" + payloadText).digest();
    if (!crypto.timingSafeEqual(expected, Buffer.from(mac, "hex"))) fail();
    let parsed: unknown;
    try { parsed = JSON.parse(payloadText); } catch { fail(); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail();
    return parsed as Record<string, unknown>;
  }

  static signForTest(key: Buffer, nonce: string, payloadText: string): string {
    return crypto.createHmac("sha256", key).update(PREFIX + nonce + ":" + payloadText).digest("hex");
  }
}
export const projectOperatorProof = new ProjectOperatorProof();
