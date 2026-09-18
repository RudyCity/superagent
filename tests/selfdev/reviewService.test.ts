import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ReviewService } from "../../src/core/selfdev/reviewService.js";
import { CandidateStore } from "../../src/core/selfdev/candidateStore.js";

describe("ReviewService", () => {
  let tmpDir: string;
  let storePath: string;
  const workspace = "test-workspace";

  beforeEach(async () => {
    const root = resolve("tmp");
    await mkdir(root, { recursive: true });
    tmpDir = await mkdtemp(join(root, "review-service-"));
    storePath = join(tmpDir, "lessons.json");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it("lists, inspects, and approves candidate lessons", async () => {
    const candidateStore = new CandidateStore({ storePath, workspace, enabled: () => true });
    const candidate = await candidateStore.create({
      workspace,
      statement: "Always run tests before committing code",
      evidenceIds: ["ev-101"],
      tags: ["workflow"],
    });
    expect(candidate).toBeDefined();

    const reviewService = new ReviewService({ storePath, enabled: () => true });
    const candidates = await reviewService.list(workspace, "candidate");
    expect(candidates).toHaveLength(1);
    expect(candidates[0].id).toBe(candidate!.id);

    const inspected = await reviewService.inspect(workspace, candidate!.id);
    expect(inspected?.lesson.statement).toBe("Always run tests before committing code");

    // Approve candidate
    const approved = await reviewService.approve(workspace, candidate!.id, candidate!.version, "human_reviewer");
    expect(approved.status).toBe("active");
    expect(approved.version).toBe(candidate!.version + 1);
    expect(approved.approvedBy).toBe("human_reviewer");
    expect(approved.approvedAt).toBeGreaterThan(0);

    // Active list should contain it
    const activeLessons = await reviewService.list(workspace, "active");
    expect(activeLessons).toHaveLength(1);
    expect(activeLessons[0].id).toBe(candidate!.id);

    // Candidate list should now be empty
    expect(await reviewService.list(workspace, "candidate")).toHaveLength(0);
  });

  it("fails approval if version does not match or status is not candidate", async () => {
    const candidateStore = new CandidateStore({ storePath, workspace, enabled: () => true });
    const candidate = await candidateStore.create({
      workspace,
      statement: "Use git worktree for parallel features",
      evidenceIds: ["ev-201"],
    });

    const reviewService = new ReviewService({ storePath, enabled: () => true });
    await expect(reviewService.approve(workspace, candidate!.id, 999, "user")).rejects.toThrow("version conflict");

    await reviewService.approve(workspace, candidate!.id, candidate!.version, "user");
    // Approving again when already active must fail
    await expect(reviewService.approve(workspace, candidate!.id, 2, "user")).rejects.toThrow("Cannot approve lesson with status: active");
  });

  it("retires an active lesson with reason", async () => {
    const candidateStore = new CandidateStore({ storePath, workspace, enabled: () => true });
    const candidate = await candidateStore.create({
      workspace,
      statement: "Deprecated guideline",
      evidenceIds: ["ev-301"],
    });

    const reviewService = new ReviewService({ storePath, enabled: () => true });
    const approved = await reviewService.approve(workspace, candidate!.id, candidate!.version, "user");

    const retired = await reviewService.retire(workspace, approved.id, approved.version, "Rule superseded by new framework");
    expect(retired.status).toBe("retired");
    expect(retired.retiredReason).toBe("Rule superseded by new framework");
    expect(retired.retiredAt).toBeGreaterThan(0);

    const activeLessons = await reviewService.list(workspace, "active");
    expect(activeLessons).toHaveLength(0);

    const retiredLessons = await reviewService.list(workspace, "retired");
    expect(retiredLessons).toHaveLength(1);
  });

  it("rejects a candidate by deleting it", async () => {
    const candidateStore = new CandidateStore({ storePath, workspace, enabled: () => true });
    const candidate = await candidateStore.create({
      workspace,
      statement: "Bad proposal",
      evidenceIds: ["ev-401"],
    });

    const reviewService = new ReviewService({ storePath, enabled: () => true });
    await reviewService.reject(workspace, candidate!.id, candidate!.version);

    expect(await reviewService.list(workspace)).toHaveLength(0);
  });

  it("resets an active lesson back to candidate when edited", async () => {
    const candidateStore = new CandidateStore({ storePath, workspace, enabled: () => true });
    const candidate = await candidateStore.create({
      workspace,
      statement: "Initial rule",
      evidenceIds: ["ev-501"],
    });

    const reviewService = new ReviewService({ storePath, enabled: () => true });
    const approved = await reviewService.approve(workspace, candidate!.id, candidate!.version, "user");

    const edited = await reviewService.edit(workspace, approved.id, approved.version, {
      statement: "Modified rule with more nuance",
    });

    // Invalidation: status is reset to candidate and approval is stripped
    expect(edited.status).toBe("candidate");
    expect(edited.statement).toBe("Modified rule with more nuance");
    expect(edited.approvedBy).toBeUndefined();
    expect(edited.approvedAt).toBeUndefined();

    // Must be in candidate list, not active list
    expect(await reviewService.list(workspace, "active")).toHaveLength(0);
    expect(await reviewService.list(workspace, "candidate")).toHaveLength(1);
  });
});
