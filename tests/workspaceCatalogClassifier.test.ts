import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sanitizeSshTarget, isSshTarget } from "../src/core/project/sshTargetSanitizer.js";
import {
  classifyWorkspaceTarget,
  normalizeLocalPath,
  pathKey,
  isWorktreePath,
  isTemporaryOrTestPath,
} from "../src/core/project/workspaceCatalogClassifier.js";

describe("sshTargetSanitizer", () => {
  it("detects and validates standard credential-free SSH targets", () => {
    expect(isSshTarget("ssh://deploy@example.com:22/srv/apps/api")).toBe(true);
    expect(isSshTarget("https://github.com")).toBe(false);
    expect(isSshTarget("D:\\workspace")).toBe(false);

    const res = sanitizeSshTarget("ssh://deploy@example.com:22/srv/apps/api");
    expect(res.valid).toBe(true);
    expect(res.sanitized).toBe("ssh://deploy@example.com:22/srv/apps/api");
    expect(res.hasStrippedCredentials).toBe(false);
  });

  it("strips legacy SSH key query parameters and never returns the stripped secret", () => {
    const raw = "ssh://ubuntu@43.134.226.18:2345/home/ubuntu?key=C:\\Users\\USER\\Downloads\\RudyNuzi.pem";
    const res = sanitizeSshTarget(raw);
    expect(res.valid).toBe(true);
    expect(res.sanitized).toBe("ssh://ubuntu@43.134.226.18:2345/home/ubuntu");
    expect(res.hasStrippedCredentials).toBe(true);
    expect(res.requiresManualProfile).toBe(true);
    expect(JSON.stringify(res)).not.toContain("RudyNuzi.pem");
    expect(JSON.stringify(res)).not.toContain("key=");
  });

  it("strips embedded passwords and hash fragments", () => {
    const raw = "ssh://admin:superSecretPass@prod-server.internal:2222/var/www#token=xyz";
    const res = sanitizeSshTarget(raw);
    expect(res.valid).toBe(true);
    expect(res.sanitized).toBe("ssh://admin@prod-server.internal:2222/var/www");
    expect(res.hasStrippedCredentials).toBe(true);
    expect(JSON.stringify(res)).not.toContain("superSecretPass");
  });

  it("rejects malformed SSH URIs safely without crashing", () => {
    expect(sanitizeSshTarget("").valid).toBe(false);
    expect(sanitizeSshTarget("ssh://").valid).toBe(false);
    expect(sanitizeSshTarget("ssh://:22/path").valid).toBe(false);
    expect(sanitizeSshTarget("http://not-ssh.com").valid).toBe(false);
  });
});

describe("workspaceCatalogClassifier", () => {
  let testRoot: string;

  beforeEach(() => {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-classifier-test-"));
  });

  afterEach(() => {
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  it("normalizes Windows paths and collapses case variants", () => {
    const p1 = "c:\\MyProject\\SubDir\\";
    const norm = normalizeLocalPath(p1);
    expect(norm).toMatch(/^C:[\\/]MyProject[\\/]SubDir$/);
    expect(pathKey("c:\\myproject\\subdir")).toBe(pathKey("C:\\MYPROJECT\\SUBDIR"));
  });

  it("classifies missing directories as 'missing' and non-importable", () => {
    const nonExistent = path.join(testRoot, "does-not-exist");
    const res = classifyWorkspaceTarget(nonExistent);
    expect(res.classification).toBe("missing");
    expect(res.available).toBe(false);
    expect(res.importable).toBe(false);
    expect(res.rejectionReasons[0]).toContain("does not exist on disk");
  });

  it("classifies worktrees as 'worktree' and non-importable", () => {
    const wtDir = path.join(testRoot, ".worktrees", "feature-x");
    fs.mkdirSync(wtDir, { recursive: true });

    const res = classifyWorkspaceTarget(wtDir);
    expect(res.classification).toBe("worktree");
    expect(res.importable).toBe(false);
    expect(res.rejectionReasons[0].toLowerCase()).toContain("worktree");
  });

  it("classifies test fixtures and temporary paths as 'test-fixture' / 'temporary' and non-importable", () => {
    const fixtureDir = path.join(testRoot, "temp-home-worker-test");
    fs.mkdirSync(fixtureDir, { recursive: true });

    const res = classifyWorkspaceTarget(fixtureDir);
    expect(["temporary", "test-fixture"]).toContain(res.classification);
    expect(res.importable).toBe(false);
  });

  it("classifies a directory with its own .git as a first-class project and importable", () => {
    const repoDir = path.join(testRoot, "real-project");
    fs.mkdirSync(path.join(repoDir, ".git"), { recursive: true });

    const res = classifyWorkspaceTarget(repoDir, { allowTempAsProjectRoot: true });
    expect(res.classification).toBe("project");
    expect(res.available).toBe(true);
    expect(res.importable).toBe(true);
    expect(res.gitRoot).toBe(normalizeLocalPath(repoDir));
  });

  it("classifies a nested subdirectory in a monorepo as nested-project and non-importable by default", () => {
    const monorepo = path.join(testRoot, "monorepo");
    fs.mkdirSync(path.join(monorepo, ".git"), { recursive: true });
    const subApp = path.join(monorepo, "packages", "nested-app");
    fs.mkdirSync(subApp, { recursive: true });

    const res = classifyWorkspaceTarget(subApp, { allowTempAsProjectRoot: true });
    expect(res.classification).toBe("nested-project");
    expect(res.available).toBe(true);
    expect(res.importable).toBe(false);
    expect(res.gitRoot).toBe(normalizeLocalPath(monorepo));
    expect(res.rejectionReasons[0]).toContain("Nested subdirectory of parent repository");
  });

  it("allows nested directory if it is already registered in project registry", () => {
    const monorepo = path.join(testRoot, "monorepo");
    fs.mkdirSync(path.join(monorepo, ".git"), { recursive: true });
    const subApp = path.join(monorepo, "packages", "nested-app");
    fs.mkdirSync(subApp, { recursive: true });

    const registeredRoots = new Set<string>([pathKey(subApp)]);
    const res = classifyWorkspaceTarget(subApp, { registeredRoots, allowTempAsProjectRoot: true });
    expect(res.classification).toBe("nested-project");
    expect(res.available).toBe(true);
    expect(res.importable).toBe(false); // Already registered, so cannot be re-imported
    expect(res.rejectionReasons[0]).toContain("Already registered");
  });

  it("sanitizes legacy SSH workspace targets and classifies them as project", () => {
    const rawSsh = "ssh://ubuntu@10.0.0.1:22/var/www/app?key=C:\\private.pem";
    const res = classifyWorkspaceTarget(rawSsh);
    expect(res.classification).toBe("project");
    expect(res.type).toBe("ssh");
    expect(res.canonicalTarget).toBe("ssh://ubuntu@10.0.0.1:22/var/www/app");
    expect(res.importable).toBe(true);
    expect(JSON.stringify(res)).not.toContain("private.pem");
  });

  it("classifies deleted or missing worktree paths structurally as 'worktree' with available: false (Finding D)", () => {
    // 1. Missing .worktrees path
    const missingWt = path.join(testRoot, "deleted-repo", ".worktrees", "wt_feature");
    const resWt = classifyWorkspaceTarget(missingWt);
    expect(resWt.classification).toBe("worktree");
    expect(resWt.available).toBe(false);
    expect(resWt.importable).toBe(false);
    expect(resWt.rejectionReasons[0]).toContain("Worktree environments cannot be imported");

    // 2. Missing wt_* path
    const missingWtPattern = path.join(testRoot, "deleted-proj", "wt_9999");
    const resPattern = classifyWorkspaceTarget(missingWtPattern);
    expect(resPattern.classification).toBe("worktree");
    expect(resPattern.available).toBe(false);
    expect(resPattern.importable).toBe(false);

    // 3. Regular non-worktree missing directory remains 'missing'
    const missingNormal = path.join(testRoot, "regular-missing-dir");
    const resNormal = classifyWorkspaceTarget(missingNormal);
    expect(resNormal.classification).toBe("missing");
    expect(resNormal.available).toBe(false);
    expect(resNormal.importable).toBe(false);
  });

  it("canonicalizes existing directories across symlinks/junctions and preserves missing/broken links safely (Finding I)", () => {
    const realTarget = path.join(testRoot, "real-symlink-target");
    fs.mkdirSync(realTarget, { recursive: true });

    const symlinkTarget = path.join(testRoot, "symlink-alias");
    let symlinkCreated = false;
    try {
      // On Windows, type "junction" or "dir" works for directories
      fs.symlinkSync(realTarget, symlinkTarget, process.platform === "win32" ? "junction" : "dir");
      symlinkCreated = true;
    } catch {}

    if (symlinkCreated) {
      expect(normalizeLocalPath(symlinkTarget)).toBe(normalizeLocalPath(realTarget));
      expect(pathKey(symlinkTarget)).toBe(pathKey(realTarget));

      const resSym = classifyWorkspaceTarget(symlinkTarget, { allowTempAsProjectRoot: true });
      const resReal = classifyWorkspaceTarget(realTarget, { allowTempAsProjectRoot: true });
      expect(resSym.canonicalTarget).toBe(resReal.canonicalTarget);
      expect(resSym.classification).toBe(resReal.classification);
    }

    // Broken symlink or non-existent path does not throw and is classified as missing
    const brokenPath = path.join(testRoot, "broken-non-existent-link");
    expect(() => normalizeLocalPath(brokenPath)).not.toThrow();
    const resBroken = classifyWorkspaceTarget(brokenPath);
    expect(resBroken.classification).toBe("missing");
    expect(resBroken.available).toBe(false);
  });

  it("allows nested project to be importable when explicitlyTrustedNamed is supplied, while collapsing arbitrary nested folders (Finding B)", () => {
    const monorepo = path.join(testRoot, "monorepo-named");
    fs.mkdirSync(path.join(monorepo, ".git"), { recursive: true });

    const trustedNamedSub = path.join(monorepo, "packages", "trusted-custom-service");
    fs.mkdirSync(trustedNamedSub, { recursive: true });

    const arbitrarySub = path.join(monorepo, "packages", "arbitrary-sub");
    fs.mkdirSync(arbitrarySub, { recursive: true });

    // Positive case: explicitlyTrustedNamed permits independent candidate
    const explicitlyTrustedNamed = new Set<string>([pathKey(trustedNamedSub)]);
    const resTrusted = classifyWorkspaceTarget(trustedNamedSub, {
      explicitlyTrustedNamed,
      allowTempAsProjectRoot: true,
    });
    expect(resTrusted.classification).toBe("nested-project");
    expect(resTrusted.available).toBe(true);
    expect(resTrusted.importable).toBe(true);

    // Negative case: arbitrary nested directory without explicitlyTrustedNamed remains non-importable
    const resArbitrary = classifyWorkspaceTarget(arbitrarySub, {
      explicitlyTrustedNamed,
      allowTempAsProjectRoot: true,
    });
    expect(resArbitrary.classification).toBe("nested-project");
    expect(resArbitrary.available).toBe(true);
    expect(resArbitrary.importable).toBe(false);
    expect(resArbitrary.rejectionReasons[0]).toContain("Nested subdirectory of parent repository");
  });
});
