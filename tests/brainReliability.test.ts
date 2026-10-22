import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createBrainSession, inspectBrainSession } from "../src/core/brain/brainWorkspace.js";
import {
  beginBrainTransfer, appendBrainTransfer, inspectBrainTransfer, finishBrainTransfer,
  cleanupBrainTransfers,
} from "../src/core/brain/brainTransfers.js";
import { importBrainBinaryArtifact } from "../src/core/brain/brainStorageManager.js";

const folders: string[] = [];
afterEach(() => {
  delete process.env.SUPERAGENT_CONFIG_DIR;
  for (const p of folders.splice(0)) fs.rmSync(p, { recursive: true, force: true });
});
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "brain-reliability-"));
  folders.push(root);
  process.env.SUPERAGENT_CONFIG_DIR = root;
  const session = createBrainSession("oauth:owner", "sess_recovery");
  return { root, dir: session.path, owner: "oauth:owner", sessionId: session.sessionId };
}
const sha = (buffer: Buffer) => crypto.createHash("sha256").update(buffer).digest("hex");

describe("Brain storage crash and concurrency recovery", () => {
  it("rewinds a partial uncommitted chunk after a crash and resumes with original checksum", () => {
    const { dir, owner, sessionId } = setup();
    const bytes = Buffer.from("abcdefghijk");
    const started = beginBrainTransfer(owner, sessionId, "payload.zip", bytes.length, sha(bytes));
    appendBrainTransfer(owner, sessionId, started.transferId, 0, bytes.subarray(0, 5).toString("base64"));
    const part = path.join(dir, ".transfers", started.transferId + ".part");
    fs.appendFileSync(part, "bad uncommitted payload");
    expect(inspectBrainTransfer(owner, sessionId, started.transferId).offset).toBe(5);
    expect(fs.statSync(part).size).toBe(5);
    appendBrainTransfer(owner, sessionId, started.transferId, 5, bytes.subarray(5).toString("base64"));
    expect(finishBrainTransfer(owner, sessionId, started.transferId).success).toBe(true);
    expect(fs.readFileSync(path.join(dir, "artifacts", "payload.zip"))).toEqual(bytes);
  });

  it("reclaims expired transfers without deleting current artifacts", () => {
    const { dir, owner, sessionId } = setup();
    const bytes = Buffer.from("unfinished");
    const started = beginBrainTransfer(owner, sessionId, "old.zip", bytes.length, sha(bytes));
    const file = path.join(dir, ".transfers", started.transferId + ".json");
    const old = JSON.parse(fs.readFileSync(file, "utf8"));
    old.updatedAt = Date.now() - 25 * 3600000;
    fs.writeFileSync(file, JSON.stringify(old));
    fs.writeFileSync(path.join(dir, "artifacts", "keep.txt"), "keep");
    const cleaned = cleanupBrainTransfers(owner, sessionId);
    expect(cleaned.removed).toBe(1);
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.readFileSync(path.join(dir, "artifacts", "keep.txt"), "utf8")).toBe("keep");
    const orphan = path.join(dir, ".transfers", "btx_" + "e".repeat(32) + ".part");
    fs.writeFileSync(orphan, "orphan");
    const age = new Date(Date.now() - 26 * 3600000);
    fs.utimesSync(orphan, age, age);
    expect(cleanupBrainTransfers(owner, sessionId).removed).toBe(1);
    expect(fs.existsSync(orphan)).toBe(false);
    expect(beginBrainTransfer(owner, sessionId, "old.zip", bytes.length, sha(bytes)).transferId).toBeTruthy();
  });

  it("rejects active locks, safely reclaims a provably dead old owner", () => {
    const { dir, owner, sessionId } = setup();
    const lock = path.join(dir, ".brain-write.lock");
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, marker: "active" }));
    expect(() => beginBrainTransfer(owner, sessionId, "a.zip", 1, "a".repeat(64))).toThrow(/modified/);
    fs.writeFileSync(lock, JSON.stringify({ pid: 99999999, marker: "crashed" }));
    const old = new Date(Date.now() - 8000);
    fs.utimesSync(lock, old, old);
    const started = beginBrainTransfer(owner, sessionId, "a.zip", 1, "a".repeat(64));
    expect(started.transferId).toBeTruthy();
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("holds one quota reservation over concurrent uploads and binary imports", () => {
    const { dir, owner, sessionId } = setup();
    const size = 20 * 1024 * 1024;
    const a = beginBrainTransfer(owner, sessionId, "first.zip", size, "a".repeat(64));
    expect(a.transferId).toBeTruthy();
    const b = beginBrainTransfer(owner, sessionId, "second.zip", size, "b".repeat(64));
    expect(b.transferId).toBeTruthy();
    const five = Buffer.alloc(5 * 1024 * 1024, 9);
    expect(importBrainBinaryArtifact(dir, "third.pdf", five).success).toBe(true);
    expect(() => beginBrainTransfer(owner, sessionId, "fourth.zip", 6 * 1024 * 1024, "c".repeat(64))).toThrow(/quota/i);
    expect(importBrainBinaryArtifact(dir, "fourth.pdf", five).success).toBe(true);
    expect(() => importBrainBinaryArtifact(dir, "fifth.pdf", Buffer.from("x"))).toThrow(/quota/i);
  });
});
