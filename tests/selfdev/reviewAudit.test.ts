import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CandidateStore } from "../../src/core/selfdev/candidateStore.js";
import { ReviewService } from "../../src/core/selfdev/reviewService.js";

describe("Selfdev review decision audit", () => {
  let directory: string | undefined;
  afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); directory = undefined; });

  it("records a redacted rejection decision even after the candidate is removed", async () => {
    directory = await mkdtemp(join(tmpdir(), "selfdev-review-audit-"));
    const workspace = "review-audit-workspace";
    const storePath = join(directory, "lessons.json");
    const candidates = new CandidateStore({ storePath, workspace, enabled: () => true });
    const lesson = await candidates.create({
      workspace,
      id: "generic-lesson",
      statement: "A candidate that only repeats the task",
      evidenceIds: ["event-1"],
    });
    const review = new ReviewService({ storePath, enabled: () => true });
    await review.reject(workspace, lesson!.id, lesson!.version,
      "Too generic; evidence includes https://example.com/account?token=secret-value", "reviewer-1");

    expect(await review.get(workspace, lesson!.id)).toBeUndefined();
    const decisions = await review.getReviewDecisions(workspace);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ lessonId: "generic-lesson", lessonVersion: 1, action: "rejected", actor: "reviewer-1" });
    expect(decisions[0].reason).toContain("[URL REDACTED]");
    expect(decisions[0].reason).not.toContain("secret-value");
    expect(await review.getReviewDecisions("another-workspace")).toEqual([]);
  });

  it("reads older lesson stores that do not yet have a reviewDecisions property", async () => {
    directory = await mkdtemp(join(tmpdir(), "selfdev-review-legacy-"));
    const workspace = "legacy-workspace";
    const storePath = join(directory, "lessons.json");
    await writeFile(storePath, JSON.stringify({ schemaVersion: 1, updatedAt: Date.now(), lessons: [] }));
    const review = new ReviewService({ storePath, enabled: () => true });
    expect(await review.list(workspace)).toEqual([]);
    expect(await review.getReviewDecisions(workspace)).toEqual([]);
  });
});
