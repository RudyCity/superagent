import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizePublicAcceptanceContract } from "../src/core/tools/cliBridgeAcceptanceContract.js";
import { verifyArtifacts } from "../src/core/tools/cliBridgeAcceptance.js";

describe("CLI Bridge public acceptance contract validation", () => {
  it("accepts bounded artifact and git-diff proof", () => {
    const result = normalizePublicAcceptanceContract({
      artifacts: [{ path: "reports/result.json", minBytes: 10, expectedSha256: "a".repeat(64) }],
      gitDiff: { maxChangedFiles: 4, prohibitedPaths: [".env"], requireCommit: false, baseCommitSha: "abcdef1" },
    });
    expect(result?.artifacts?.[0].path).toBe("reports/result.json");
    expect(result?.gitDiff?.maxChangedFiles).toBe(4);
  });

  it.each([
    { commands: ["echo bypass"] },
    { tests: ["bun test"] },
    { build: ["bun run build"] },
    { customVerifier: "powershell -Command whoami" },
  ])("rejects public executable verifier fields: %j", (input) => {
    expect(() => normalizePublicAcceptanceContract(input)).toThrow(/unsupported field/);
  });

  it("rejects absolute and escaping artifact paths", () => {
    expect(() => normalizePublicAcceptanceContract({ artifacts: [{ path: "../outside.txt" }] })).toThrow(/escapes/);
    expect(() => normalizePublicAcceptanceContract({ artifacts: [{ path: "C:\\outside.txt" }] })).toThrow(/relative/);
  });

  it("rejects malformed hashes and empty contracts", () => {
    expect(() => normalizePublicAcceptanceContract({ artifacts: [{ path: "x", expectedSha256: "bad" }] })).toThrow(/SHA-256/);
    expect(() => normalizePublicAcceptanceContract({})).toThrow(/must contain/);
  });

  it("fails closed when direct verifier receives an escaping artifact path", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cli-acceptance-boundary-"));
    try {
      const result = await verifyArtifacts(root, [{ path: "../outside.txt" }]);
      expect(result.passed).toBe(false);
      expect(result.failureReason).toContain("outside the delegated workspace");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects symlink artifacts when supported by the host", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cli-acceptance-symlink-"));
    const target = path.join(root, "target.txt");
    const link = path.join(root, "link.txt");
    fs.writeFileSync(target, "evidence");
    try {
      try { fs.symlinkSync(target, link, "file"); } catch { return; }
      const result = await verifyArtifacts(root, [{ path: "link.txt" }]);
      expect(result.passed).toBe(false);
      expect(result.failureReason).toContain("symbolic link");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
