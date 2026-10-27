import { describe, expect, it } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import {
  isPathInScope,
  canonicalizeTarget,
  validateToolCallAgainstFileScope,
} from "../src/core/agent/fileScopeGuard.js";

describe("Delegated fileScope hard enforcement (DEEP-02)", () => {
  const tmpBase = path.join(os.tmpdir(), `superagent_scope_test_${Date.now()}`);
  const workspaceRoot = path.join(tmpBase, "workspace");
  const authDir = path.join(workspaceRoot, "src", "auth");
  const otherDir = path.join(workspaceRoot, "src", "other");
  const outsideDir = path.join(tmpBase, "outside");

  // Setup test filesystem structure
  fs.mkdirSync(authDir, { recursive: true });
  fs.mkdirSync(otherDir, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });

  const authFile = path.join(authDir, "login.ts");
  const otherFile = path.join(otherDir, "secret.ts");
  const outsideFile = path.join(outsideDir, "external.txt");

  fs.writeFileSync(authFile, "export const login = true;");
  fs.writeFileSync(otherFile, "export const secret = 123;");
  fs.writeFileSync(outsideFile, "outside content");

  const fileScope = ["src/auth/**"];

  it("allows paths strictly inside the fileScope", () => {
    const res = isPathInScope("src/auth/login.ts", fileScope, workspaceRoot);
    expect(res.inScope).toBe(true);

    const absRes = isPathInScope(authFile, fileScope, workspaceRoot);
    expect(absRes.inScope).toBe(true);

    // Non-existent child file to be created in allowed scope
    const newFile = isPathInScope("src/auth/new_handler.ts", fileScope, workspaceRoot);
    expect(newFile.inScope).toBe(true);
  });

  it("denies sibling directories outside the fileScope", () => {
    const res = isPathInScope("src/other/secret.ts", fileScope, workspaceRoot);
    expect(res.inScope).toBe(false);
    expect(res.reason).toContain("outside allowed fileScope");

    const absRes = isPathInScope(otherFile, fileScope, workspaceRoot);
    expect(absRes.inScope).toBe(false);
  });

  it("denies directory traversal attempts escaping fileScope", () => {
    // Relative traversal escaping src/auth to src/other
    const travRes = isPathInScope("src/auth/../other/secret.ts", fileScope, workspaceRoot);
    expect(travRes.inScope).toBe(false);

    // Deep traversal escaping workspace completely
    const deepTrav = isPathInScope("src/auth/../../../../outside.txt", fileScope, workspaceRoot);
    expect(deepTrav.inScope).toBe(false);
  });

  it("detects and denies symlinks escaping fileScope", () => {
    const symlinkPath = path.join(authDir, "symlink_to_other.ts");
    try {
      fs.symlinkSync(otherFile, symlinkPath, "file");
    } catch {
      // Symlink creation may require elevated privileges on some Windows environments
    }

    if (fs.existsSync(symlinkPath)) {
      const res = isPathInScope("src/auth/symlink_to_other.ts", fileScope, workspaceRoot);
      expect(res.inScope).toBe(false);
      expect(res.reason).toMatch(/Symlink\/reparse target/);
      try { fs.unlinkSync(symlinkPath); } catch {}
    }
  });

  it("validates file read and write tool calls against fileScope", () => {
    // Allowed read
    const allowedRead = validateToolCallAgainstFileScope(
      fileScope,
      { id: "1", name: "read", args: { filePaths: ["src/auth/login.ts"] } },
      workspaceRoot
    );
    expect(allowedRead.allowed).toBe(true);

    // Denied read (outside scope)
    const deniedRead = validateToolCallAgainstFileScope(
      fileScope,
      { id: "2", name: "read", args: { filePaths: ["package.json"] } },
      workspaceRoot
    );
    expect(deniedRead.allowed).toBe(false);
    expect(deniedRead.reason).toContain("outside allowed fileScope");

    // Denied write (traversal to sibling)
    const deniedWrite = validateToolCallAgainstFileScope(
      fileScope,
      { id: "3", name: "write_to_file", args: { files: [{ filePath: "src/auth/../other/hacked.ts", content: "hacked" }] } },
      workspaceRoot
    );
    expect(deniedWrite.allowed).toBe(false);
  });

  it("validates shell operations and blocks chdir or traversal escapes", () => {
    // Allowed cwd
    const allowedCwd = validateToolCallAgainstFileScope(
      fileScope,
      { id: "4", name: "run_command", args: { command: "ls", cwd: "src/auth" } },
      workspaceRoot
    );
    expect(allowedCwd.allowed).toBe(true);

    // Denied outside cwd
    const deniedCwd = validateToolCallAgainstFileScope(
      fileScope,
      { id: "5", name: "run_command", args: { command: "ls", cwd: "src/other" } },
      workspaceRoot
    );
    expect(deniedCwd.allowed).toBe(false);

    // Denied cd escaping scope
    const deniedCd = validateToolCallAgainstFileScope(
      fileScope,
      { id: "6", name: "run_command", args: { command: "cd ../other && ls", cwd: "src/auth" } },
      workspaceRoot
    );
    expect(deniedCd.allowed).toBe(false);
    expect(deniedCd.reason).toMatch(/cd outside fileScope/);

    // Denied traversal in command arguments
    const deniedArgTrav = validateToolCallAgainstFileScope(
      fileScope,
      { id: "7", name: "run_command", args: { command: "cat ../other/secret.ts", cwd: "src/auth" } },
      workspaceRoot
    );
    expect(deniedArgTrav.allowed).toBe(false);
  });
});
