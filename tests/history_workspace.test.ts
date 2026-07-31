import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getCurrentWorkspaceIdentifier, normalizeAndCheckSubpath } from "../src/core/config/history.js";
import { workspaceMode } from "../src/core/ssh/workspaceMode.js";
import { workspaceChainManager } from "../src/core/workspace/WorkspaceChainManager.js";
import path from "path";

describe("getCurrentWorkspaceIdentifier & normalizeAndCheckSubpath tests", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    workspaceMode.setLocalMode();
    // Use dynamic mock or explicit method to clear chain if active
    vi.spyOn(workspaceChainManager, "getActiveChain").mockReturnValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("getCurrentWorkspaceIdentifier", () => {
    it("should return absolute local path in local mode", () => {
      const id = getCurrentWorkspaceIdentifier("/tmp/local-workspace");
      expect(id).toBe(path.resolve("/tmp/local-workspace"));
    });

    it("should return SSH target in SSH mode", () => {
      vi.spyOn(workspaceMode, "isSsh").mockReturnValue(true);
      vi.spyOn(workspaceMode, "getConfig").mockReturnValue({
        host: "remote-host",
        port: 2222,
        username: "testuser",
        remoteCwd: "/var/www/app"
      });

      const id = getCurrentWorkspaceIdentifier();
      expect(id).toBe("ssh://testuser@remote-host:2222/var/www/app");
    });

    it("should return chain target in workspace chain mode", () => {
      vi.spyOn(workspaceChainManager, "getActiveChain").mockReturnValue({
        id: "project-chain-xyz",
        name: "My project chain",
        nodes: [],
        primaryNodeId: "main",
        createdAt: Date.now(),
        updatedAt: Date.now()
      });

      const id = getCurrentWorkspaceIdentifier();
      expect(id).toBe("chain:project-chain-xyz");
    });
  });

  describe("normalizeAndCheckSubpath", () => {
    it("should check local paths correctly", () => {
      const main = path.resolve("/tmp/foo");
      const sub = path.resolve("/tmp/foo/bar");
      const other = path.resolve("/tmp/baz");

      expect(normalizeAndCheckSubpath(sub, main)).toBe(true);
      expect(normalizeAndCheckSubpath(main, sub)).toBe(true);
      expect(normalizeAndCheckSubpath(other, main)).toBe(false);
    });

    it("should match chain identifiers exactly case-insensitive", () => {
      expect(normalizeAndCheckSubpath("chain:my-chain", "chain:my-chain")).toBe(true);
      expect(normalizeAndCheckSubpath("chain:My-Chain", "chain:my-chain")).toBe(true);
      expect(normalizeAndCheckSubpath("chain:my-chain", "chain:other-chain")).toBe(false);
    });

    it("should check SSH targets and remote paths correctly", () => {
      const s1 = "ssh://user@host:22/remote/path";
      const s1Sub = "ssh://user@host:22/remote/path/subdir";
      const s2 = "ssh://user@host:22/other/path";
      const sDiffUser = "ssh://otheruser@host:22/remote/path";

      expect(normalizeAndCheckSubpath(s1Sub, s1)).toBe(true);
      expect(normalizeAndCheckSubpath(s1, s1Sub)).toBe(true);
      expect(normalizeAndCheckSubpath(s2, s1)).toBe(false);
      expect(normalizeAndCheckSubpath(sDiffUser, s1)).toBe(false);
    });
  });
});
