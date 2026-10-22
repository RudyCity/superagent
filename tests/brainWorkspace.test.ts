import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createBrainSession, inspectBrainSession, listBrainSessions, listBrainFiles,
  writeBrainFile, readBrainFile, cleanBrainScratch,
} from "../src/core/brain/brainWorkspace.js";

const roots: string[] = [];
function tempRoot() { const root = fs.mkdtempSync(path.join(os.tmpdir(), "superagent-brain-")); roots.push(root); return root; }
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe("SuperAgent session Brain", () => {
  it("creates an independent scratch without writing into project root", () => {
    const root = tempRoot();
    const session = createBrainSession("oauth:a", "sess_test", root);
    expect(session.scratchPath).toContain(path.join("brain", session.ownerHash, "sess_test", "scratch"));
    expect(inspectBrainSession("oauth:a", "sess_test", root).sessionId).toBe("sess_test");
    expect(listBrainSessions("oauth:a", root)).toHaveLength(1);
  });
  it("isolates owners and sessions", () => {
    const root = tempRoot();
    createBrainSession("oauth:a", "one", root);
    createBrainSession("oauth:a", "two", root);
    writeBrainFile("oauth:a", "one", "scratch/scripts/hello.txt", "secret", false, root);
    expect(readBrainFile("oauth:a", "one", "scratch/scripts/hello.txt", root)).toBe("secret");
    expect(() => readBrainFile("oauth:a", "two", "scratch/scripts/hello.txt", root)).toThrow();
    expect(() => inspectBrainSession("oauth:b", "one", root)).toThrow();
    expect(listBrainSessions("oauth:b", root)).toEqual([]);
  });
  it("blocks traversal, secret dotfiles, symlinks and overwrite by default", () => {
    const root = tempRoot();
    const s = createBrainSession("oauth:a", "safe", root);
    expect(() => createBrainSession("oauth:a", "../bad", root)).toThrow();
    for (const bad of ["../outside", "scratch/../artifacts/file", "scratch/.env", "artifacts/C:/foo", "scratch/a\\b"]) {
      expect(() => writeBrainFile("oauth:a", "safe", bad, "x", false, root)).toThrow();
    }
    writeBrainFile("oauth:a", "safe", "scratch/ok.txt", "v1", false, root);
    expect(() => writeBrainFile("oauth:a", "safe", "scratch/ok.txt", "v2", false, root)).toThrow();
    const link = path.join(s.scratchPath, "linked");
    try {
      fs.symlinkSync(os.tmpdir(), link, process.platform === "win32" ? "junction" : "dir");
      expect(() => writeBrainFile("oauth:a", "safe", "scratch/linked/external.txt", "x", false, root)).toThrow();
    } catch (err: any) {
      if (err.code !== "EPERM" && err.code !== "EACCES") throw err;
    }
  });
  it("cleanup only removes scratch, preserving artifact and evidence", () => {
    const root = tempRoot();
    createBrainSession("oauth:a", "clean", root);
    writeBrainFile("oauth:a", "clean", "scratch/temp.txt", "scratch", false, root);
    writeBrainFile("oauth:a", "clean", "artifacts/result.txt", "keep", false, root);
    expect(() => cleanBrainScratch("oauth:a", "clean", "wrong", root)).toThrow();
    cleanBrainScratch("oauth:a", "clean", "clean", root);
    expect(readBrainFile("oauth:a", "clean", "artifacts/result.txt", root)).toBe("keep");
    expect(listBrainFiles("oauth:a", "clean", root).map(x => x.path)).toEqual(["artifacts/result.txt"]);
  });
});
