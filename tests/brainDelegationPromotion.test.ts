import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createBrainSession } from "../src/core/brain/brainWorkspace.js";

const mockGetJob = vi.hoisted(() => vi.fn());
vi.mock("../src/core/tools/cliBridgeDelegateJobs.js", () => ({
  getDelegateJob: mockGetJob,
}));
import { promoteBrainDelegation } from "../src/core/brain/brainDelegationArtifacts.js";

const roots: string[] = [];
afterEach(() => {
  mockGetJob.mockReset(); delete process.env.SUPERAGENT_CONFIG_DIR;
  for (const r of roots.splice(0)) fs.rmSync(r, { force: true, recursive: true });
});

describe("Brain delegated artifact promotion", () => {
  it("promotes a verified AGY result but never grants cross-owner access", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "brain-promote-"));roots.push(root);
    process.env.SUPERAGENT_CONFIG_DIR = root;
    const owned = createBrainSession("oauth:one", "job_session");
    createBrainSession("oauth:two", "job_session");
    const produced = path.join(owned.scratchPath, "diagram.png");
    fs.writeFileSync(produced, Buffer.from("verified payload"));
    const hash = crypto.createHash("sha256").update(fs.readFileSync(produced)).digest("hex");
    mockGetJob.mockResolvedValue({
      jobId: "clj_1792638000000_abcdefab", cwd: owned.scratchPath, status: "succeeded",
      completionState: "artifacts_verified",
      artifactEvidence: [{ path: "diagram.png", state: "created", bytes: 16, sha256: hash }],
    });
    await expect(promoteBrainDelegation("oauth:two","job_session","clj_1792638000000_abcdefab")).rejects.toThrow(/not owned/);
    const promoted=await promoteBrainDelegation("oauth:one","job_session","clj_1792638000000_abcdefab");
    expect(promoted.sourceVerified).toBe(true);
    expect(fs.readFileSync(path.join(owned.artifactsPath,"diagram.png"))).toEqual(Buffer.from("verified payload"));
    await expect(promoteBrainDelegation("oauth:one","job_session","clj_1792638000000_abcdefab")).rejects.toThrow();
    fs.writeFileSync(produced,"mutated");
    await expect(promoteBrainDelegation("oauth:one","job_session","clj_1792638000000_abcdefab","different.png")).rejects.toThrow(/changed/);
    mockGetJob.mockResolvedValue({
      jobId: "clj_1792638000000_abcdefab", cwd: owned.scratchPath, status:"running",
      completionState:"unverified", artifactEvidence: [{ path:"diagram.png", state:"created", bytes:16, sha256:hash }],
    });
    await expect(promoteBrainDelegation("oauth:one","job_session","clj_1792638000000_abcdefab","third.png")).rejects.toThrow(/verified/);
  });
});
