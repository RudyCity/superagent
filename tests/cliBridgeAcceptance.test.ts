import { describe, it, expect, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import {
  acquireResourceClaims,
  inspectResourceClaim,
  releaseResourceClaims,
  canonicalResourceIdentity,
} from "../src/core/tools/cliBridgeResourceClaims.js";
import {
  executeAcceptanceVerification,
  verifyArtifacts,
  verifyGitDiffConstraints,
  type AcceptanceContract,
} from "../src/core/tools/cliBridgeAcceptance.js";

describe("Milestone M3 — Resource Claims & Verified Completion Contracts", () => {
  const tempDir = path.join(os.tmpdir(), `superagent-acceptance-test-${Date.now()}`);
  const claimsDir = path.join(tempDir, "claims");
  process.env.SUPERAGENT_CLI_BRIDGE_CLAIMS_DIR = claimsDir;

  fs.mkdirSync(tempDir, { recursive: true });
  fs.mkdirSync(claimsDir, { recursive: true });

  afterAll(() => {
    delete process.env.SUPERAGENT_CLI_BRIDGE_CLAIMS_DIR;
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  describe("Resource Claims (P3.2 & P3.3)", () => {
    it("allows multiple concurrent read claims on the same target", async () => {
      const target = "src/models/user.ts";
      const lease1 = await acquireResourceClaims([{ type: "file", target, mode: "read" }], "job1");
      const lease2 = await acquireResourceClaims([{ type: "file", target, mode: "read" }], "job2");

      expect(lease1).toHaveLength(1);
      expect(lease2).toHaveLength(1);

      const inspection = await inspectResourceClaim(canonicalResourceIdentity("file", target));
      expect(inspection.locked).toBe(true);
      expect(inspection.activeReaders).toBe(2);
      expect(inspection.activeWriters).toBe(0);

      await releaseResourceClaims([...lease1, ...lease2]);
      const postInspection = await inspectResourceClaim(canonicalResourceIdentity("file", target));
      expect(postInspection.locked).toBe(false);
    });

    it("prevents write claims when resource is already read-locked or write-locked", async () => {
      const target = "package.json";
      const readLease = await acquireResourceClaims([{ type: "file", target, mode: "read" }], "jobA");

      // Attempting write claim while read-locked must fail
      await expect(
        acquireResourceClaims([{ type: "file", target, mode: "write" }], "jobB")
      ).rejects.toThrow("currently locked by active readers");

      await releaseResourceClaims(readLease);

      // Now write claim succeeds
      const writeLease = await acquireResourceClaims([{ type: "file", target, mode: "write" }], "jobB");
      expect(writeLease).toHaveLength(1);

      // Second writer is blocked
      await expect(
        acquireResourceClaims([{ type: "file", target, mode: "write" }], "jobC")
      ).rejects.toThrow("currently locked by active writer");

      // Reader is also blocked by writer
      await expect(
        acquireResourceClaims([{ type: "file", target, mode: "read" }], "jobD")
      ).rejects.toThrow("currently exclusively locked by writer");

      await releaseResourceClaims(writeLease);
    });
  });

  describe("Artifact Verification & SHA-256 Hashes (P4.1 & P4.3)", () => {
    it("fails verification if required artifact does not exist", async () => {
      const res = await verifyArtifacts(tempDir, [
        { path: "missing.json", mustExist: true },
      ]);
      expect(res.passed).toBe(false);
      expect(res.failureReason).toContain("does not exist");
    });

    it("verifies artifact size and matching SHA-256 hash", async () => {
      const artifactPath = path.join(tempDir, "output.txt");
      const content = "Hello World Verified Evidence";
      fs.writeFileSync(artifactPath, content, "utf-8");
      const expectedSha256 = crypto.createHash("sha256").update(content).digest("hex");

      const res = await verifyArtifacts(tempDir, [
        { path: "output.txt", minBytes: 10, expectedSha256 },
      ]);
      expect(res.passed).toBe(true);
      expect(res.details[0].passed).toBe(true);
      expect(res.details[0].sha256).toBe(expectedSha256);
    });

    it("fails verification if SHA-256 hash mismatches", async () => {
      const artifactPath = path.join(tempDir, "corrupt.txt");
      fs.writeFileSync(artifactPath, "tampered content", "utf-8");

      const res = await verifyArtifacts(tempDir, [
        { path: "corrupt.txt", expectedSha256: "0000000000000000000000000000000000000000000000000000000000000000" },
      ]);
      expect(res.passed).toBe(false);
      expect(res.failureReason).toContain("SHA-256 mismatch");
    });
  });

  describe("End-to-End Acceptance Verification Pipeline (P4.2 & P4.3)", () => {
    it("returns succeeded_unverified when no acceptance contract is specified", async () => {
      const res = await executeAcceptanceVerification(tempDir);
      expect(res.state).toBe("succeeded_unverified");
    });

    it("returns verified when all artifacts and commands succeed", async () => {
      const artifactPath = path.join(tempDir, "verified_result.txt");
      fs.writeFileSync(artifactPath, "PROVEN_SUCCESS", "utf-8");

      const contract: AcceptanceContract = {
        artifacts: [{ path: "verified_result.txt", minBytes: 5 }],
        commands: [process.platform === "win32" ? "cmd /c echo OK" : "echo OK"],
      };

      const res = await executeAcceptanceVerification(tempDir, contract);
      expect(res.state).toBe("verified");
      expect(res.artifactsPassed).toBe(true);
      expect(res.commandResults?.[0].passed).toBe(true);
    });

    it("returns verification_failed when command exits non-zero", async () => {
      const contract: AcceptanceContract = {
        commands: [process.platform === "win32" ? "cmd /c exit 1" : "exit 1"],
      };

      const res = await executeAcceptanceVerification(tempDir, contract);
      expect(res.state).toBe("verification_failed");
      expect(res.failureReason).toContain("failed with exit code 1");
    });
  });
});
