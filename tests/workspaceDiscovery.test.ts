import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import {
  getWorkspaceFingerprint,
  discoverWorkspace,
  injectWorkspaceOverview,
  getWorkspaceCachePath
} from "../src/core/workspaceDiscovery.js";

describe("workspaceDiscovery", () => {
  let testWorkspaceDir: string;
  let testConfigDir: string;
  let originalConfigDirEnv: string | undefined;

  beforeEach(() => {
    // Save original env
    originalConfigDirEnv = process.env.SUPERAGENT_CONFIG_DIR;

    // Create unique temp directories
    testWorkspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "sa-test-workspace-"));
    testConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "sa-test-config-"));

    // Override config dir environment
    process.env.SUPERAGENT_CONFIG_DIR = testConfigDir;

    // Set up initial test files in the mock workspace
    fs.writeFileSync(path.join(testWorkspaceDir, "agents.md"), "# Project Specs\nBuild things.");
    fs.writeFileSync(path.join(testWorkspaceDir, "package.json"), JSON.stringify({ name: "test-project", version: "1.0.0" }));
    fs.mkdirSync(path.join(testWorkspaceDir, "src"));
    fs.writeFileSync(path.join(testWorkspaceDir, "src", "index.ts"), "console.log('hello');");
    
    // Create folders that should be ignored
    fs.mkdirSync(path.join(testWorkspaceDir, ".git"));
    fs.writeFileSync(path.join(testWorkspaceDir, ".git", "config"), "some git configuration");
    fs.mkdirSync(path.join(testWorkspaceDir, "node_modules"));
    fs.writeFileSync(path.join(testWorkspaceDir, "node_modules", "package.json"), "{}");
  });

  afterEach(() => {
    // Restore original env
    process.env.SUPERAGENT_CONFIG_DIR = originalConfigDirEnv;

    // Clean up temp directories
    try {
      fs.rmSync(testWorkspaceDir, { recursive: true, force: true });
      fs.rmSync(testConfigDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup failures in temp dirs if file handles are locked
    }
  });

  describe("getWorkspaceFingerprint", () => {
    it("should recursively walk directory and calculate a fingerprint", async () => {
      const { fingerprint, fileList, files } = await getWorkspaceFingerprint(testWorkspaceDir);
      
      expect(fileList).toContain("agents.md");
      expect(fileList).toContain("package.json");
      expect(fileList).toContain("src/index.ts");
      
      // Git and node_modules folders should be ignored
      expect(fileList).not.toContain(".git/config");
      expect(fileList).not.toContain("node_modules/package.json");

      expect(files["agents.md"]).toBeDefined();
      expect(files["agents.md"].size).toBeGreaterThan(0);
      expect(files["agents.md"].mtimeMs).toBeGreaterThan(0);
      
      expect(fingerprint).toBeDefined();
      expect(typeof fingerprint).toBe("string");
      expect(fingerprint.length).toBe(32); // MD5 hex length
    });

    it("should change fingerprint when a file is modified", async () => {
      const original = await getWorkspaceFingerprint(testWorkspaceDir);
      
      // Wait a moment and write/modify a file to change size and mtime
      fs.writeFileSync(path.join(testWorkspaceDir, "src", "index.ts"), "console.log('hello modified');");
      
      const modified = await getWorkspaceFingerprint(testWorkspaceDir);
      expect(modified.fingerprint).not.toEqual(original.fingerprint);
    });

    it("should change fingerprint when a new file is added", async () => {
      const original = await getWorkspaceFingerprint(testWorkspaceDir);
      
      fs.writeFileSync(path.join(testWorkspaceDir, "src", "utils.ts"), "export const add = (a, b) => a + b;");
      
      const added = await getWorkspaceFingerprint(testWorkspaceDir);
      expect(added.fingerprint).not.toEqual(original.fingerprint);
      expect(added.fileList).toContain("src/utils.ts");
    });

    it("should change fingerprint when a file is deleted", async () => {
      const original = await getWorkspaceFingerprint(testWorkspaceDir);
      
      fs.unlinkSync(path.join(testWorkspaceDir, "src", "index.ts"));
      
      const deleted = await getWorkspaceFingerprint(testWorkspaceDir);
      expect(deleted.fingerprint).not.toEqual(original.fingerprint);
      expect(deleted.fileList).not.toContain("src/index.ts");
    });
  });

  describe("discoverWorkspace", () => {
    it("should run full scan and return isIdentical = false on first call", async () => {
      const { isIdentical, cache } = await discoverWorkspace(testWorkspaceDir);
      
      expect(isIdentical).toBe(false);
      expect(cache.fingerprint).toBeDefined();
      expect(cache.fileList).toContain("src/index.ts");
      expect(cache.agentsMd).toContain("# Project Specs");
      expect(cache.packageJson.name).toBe("test-project");

      // Verify cache file was written to disk
      const cachePath = getWorkspaceCachePath(testWorkspaceDir);
      expect(fs.existsSync(cachePath)).toBe(true);
    });

    it("should return isIdentical = true on second call when no changes occur", async () => {
      await discoverWorkspace(testWorkspaceDir);
      
      const { isIdentical, cache } = await discoverWorkspace(testWorkspaceDir);
      expect(isIdentical).toBe(true);
      expect(cache.agentsMd).toContain("# Project Specs");
    });

    it("should perform partial scan and return isIdentical = false when files are changed", async () => {
      await discoverWorkspace(testWorkspaceDir);
      
      // Modify agents.md
      fs.writeFileSync(path.join(testWorkspaceDir, "agents.md"), "# Project Specs\nModified.");
      
      const { isIdentical, cache } = await discoverWorkspace(testWorkspaceDir);
      expect(isIdentical).toBe(false);
      expect(cache.agentsMd).toContain("Modified.");
    });
  });

  describe("injectWorkspaceOverview", () => {
    it("should append the workspace files and agents.md overview to the prompt", () => {
      const cache = {
        workspaceDir: testWorkspaceDir,
        fingerprint: "dummy",
        fileList: ["agents.md", "package.json", "src/index.ts"],
        files: {},
        agentsMd: "# Specs\nDo it.",
        packageJson: { name: "test" },
        lastScanTime: Date.now()
      };

      const basePrompt = "You are a coding assistant.";
      const injectedPrompt = injectWorkspaceOverview(basePrompt, cache);
      
      expect(injectedPrompt).toContain("You are a coding assistant.");
      expect(injectedPrompt).not.toContain("WORKSPACE FILES LIST:");
      expect(injectedPrompt).not.toContain("src/index.ts");
      expect(injectedPrompt).toContain("PROJECT SPECIFICATIONS (agents.md):");
      expect(injectedPrompt).toContain("# Specs");
      expect(injectedPrompt).toContain("PROJECT METADATA (package.json):");
    });
  });
});
