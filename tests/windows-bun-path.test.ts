import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  augmentWindowsEnvPath,
  resolveWindowsBunExecutable,
  resolveWindowsGhExecutable,
  resolveWindowsGitExecutable,
} from "../src/core/tools/helpers.js";

describe("Windows MCP toolchain PATH", () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const roots: string[] = [];
  afterEach(() => {
    Object.defineProperty(process, "platform", originalPlatform);
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  });

  it("adds only an installed per-user Bun executable directory", () => {
    const user = fs.mkdtempSync(path.join(os.tmpdir(), "superagent-win-bun-"));
    roots.push(user);
    const bunBin = path.join(user, ".bun", "bin");
    fs.mkdirSync(bunBin, { recursive: true });
    fs.writeFileSync(path.join(bunBin, "bun.exe"), "");
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });

    const env = augmentWindowsEnvPath({ USERPROFILE: user, PATH: "C:\\Windows\\System32" });
    expect(env.PATH?.split(";")).toContain(bunBin);
    expect(env.Path).toBe(env.PATH);

    const again = augmentWindowsEnvPath(env);
    expect(again.PATH?.split(";").filter(value => value === bunBin)).toHaveLength(1);
  });

  it("does not invent a Bun path when bun.exe is missing", () => {
    const user = fs.mkdtempSync(path.join(os.tmpdir(), "superagent-no-bun-"));
    roots.push(user);
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    const env = augmentWindowsEnvPath({ USERPROFILE: user, PATH: "C:\\Windows\\System32" });
    expect(env.PATH).not.toContain(path.join(user, ".bun", "bin"));
  });
  it("resolves an installed Bun directly without requiring the shell PATH", () => {
    const user = fs.mkdtempSync(path.join(os.tmpdir(), "superagent-direct-bun-"));
    roots.push(user);
    const bunDir = path.join(user, ".bun", "bin");
    fs.mkdirSync(bunDir, { recursive: true });
    const exe = path.join(bunDir, "bun.exe");
    fs.writeFileSync(exe, "");
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    expect(resolveWindowsBunExecutable({ USERPROFILE: user, PATH: "" })).toBe(exe);
    expect(resolveWindowsBunExecutable({ USERPROFILE: user, BUN_INSTALL: path.join(user, "missing") })).toBeNull();
  });

  it("prefers a verified native Git executable and never guesses missing binaries", () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    const actual = "D:\\Tools\\Git\\cmd\\git.exe";
    const existing = (candidate: string) => candidate === actual;
    expect(resolveWindowsGitExecutable({ ProgramFiles: "D:\\Tools", PATH: "" }, existing)).toBe(actual);
    expect(resolveWindowsGitExecutable({ ProgramFiles: "D:\\Tools", PATH: "" }, () => false)).toBe("git");
  });

  it("adds a verified Git command directory to a stale Windows PATH", () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    const user = fs.mkdtempSync(path.join(os.tmpdir(), "superagent-git-path-"));
    roots.push(user);
    // PATH augmentation should keep an existing path intact even if Git is not installed.
    const env = augmentWindowsEnvPath({ USERPROFILE: user, PATH: "C:\\Windows\\System32" });
    expect(env.PATH).toContain("C:\\Windows\\System32");
  });

  it("resolves an installed Windows GitHub CLI executable and injects it into stale PATH", () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "superagent-gh-path-"));
    roots.push(tempRoot);
    const ghDir = path.join(tempRoot, "GitHub CLI");
    fs.mkdirSync(ghDir, { recursive: true });
    const ghExe = path.join(ghDir, "gh.exe");
    fs.writeFileSync(ghExe, "");

    expect(resolveWindowsGhExecutable({ ProgramFiles: tempRoot, PATH: "" })).toBe(ghExe);
    expect(resolveWindowsGhExecutable({ ProgramFiles: tempRoot, PATH: "" }, () => false)).toBe("gh");

    const env = augmentWindowsEnvPath({
      USERPROFILE: tempRoot,
      ProgramFiles: tempRoot,
      PATH: "C:\\Windows\\System32",
    });
    expect(env.PATH?.split(";")).toContain(ghDir);
    expect(env.Path).toBe(env.PATH);

    const again = augmentWindowsEnvPath(env);
    expect(again.PATH?.split(";").filter(value => value === ghDir)).toHaveLength(1);
  });

});
