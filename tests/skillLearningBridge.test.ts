import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import { getWorkspaceId } from "../src/core/config/paths.js";
import { getRMemoryProjectId } from "../src/core/rmemoryUtil.js";
import { filterEligibleMemoryRecords } from "../src/core/memoryLifecycle.js";
import {
  bridgeRepeatedSkillFailures,
  bridgeNegativeSkillFeedback,
  selectConsecutiveSkillFailures,
} from "../src/core/skills/skillLearningBridge.js";
import type { DaemonRunRecord } from "../src/core/daemon/daemonTypes.js";

const workspace = path.resolve("workspace-learning-fixture");
const projectId = getWorkspaceId(workspace);
const pinnedSkillVersion = "review-checks@abcdef123456";
const run = (overrides: Partial<DaemonRunRecord> = {}): DaemonRunRecord => ({
  runId: "run-a",
  jobId: "job-1",
  attemptNumber: 1,
  workspacePath: workspace,
  projectId,
  mode: "single",
  status: "error",
  executionPolicyJson: "{}",
  pinnedSkillVersion,
  startedAt: 1000,
  completedAt: 1500,
  durationMs: 500,
  notificationStatus: "not_configured",
  recoveryAction: "none",
  createdAt: 1000,
  ...overrides,
});

function clientFixture() {
  const records = new Map<string, { content: string; metadata: any }>();
  const client = {
    inspectAtomic: vi.fn(async ({ id }: { id: string }) => {
      const item = records.get(id);
      return item ? { id, scope: "project", ...item } : null;
    }),
    updateAtomic: vi.fn(async ({ id, content, metadata }: { id: string; content: string; metadata: any }) => {
      records.set(id, { content, metadata });
      return { id, updated_at: new Date().toISOString() };
    }),
  };
  return { client, records };
}

describe("skill failure to quarantined memory evidence bridge", () => {
  const failures = [
    run({ runId: "run-b", attemptNumber: 2, startedAt: 2000, completedAt: 2500 }),
    run(),
  ];

  it("requires two consecutive failures with the same immutable pin and project", () => {
    expect(selectConsecutiveSkillFailures(failures, {
      jobId: "job-1", workspacePath: workspace, pinnedSkillVersion,
    }).map(r => r.runId)).toEqual(["run-b", "run-a"]);
    for (const blockingStatus of ["success", "cancelled", "running"] as const) {
      const mixed = [run({ runId: "run-c", startedAt: 3000, status: blockingStatus }), ...failures];
      expect(selectConsecutiveSkillFailures(mixed, {
        jobId: "job-1", workspacePath: workspace, pinnedSkillVersion,
      })).toEqual([]);
    }
    expect(selectConsecutiveSkillFailures([
      run({ runId: "other-project", projectId: "foreign", startedAt: 3000 }), ...failures,
    ], { jobId: "job-1", workspacePath: workspace, pinnedSkillVersion })).toEqual([]);
    expect(selectConsecutiveSkillFailures([
      run({ runId: "different-skill", pinnedSkillVersion: "another@abcdef123456", startedAt: 3000 }), ...failures,
    ], { jobId: "job-1", workspacePath: workspace, pinnedSkillVersion })).toEqual([]);
  });

  it("creates a project-scoped quarantined candidate citing exact run IDs only", async () => {
    const { client, records } = clientFixture();
    const result = await bridgeRepeatedSkillFailures({
      jobId: "job-1", workspacePath: workspace, pinnedSkillVersion, runs: failures,
      client: client as any,
    });
    expect(result).toMatchObject({
      status: "created",
      memoryId: "skill-regression-review-checks-abcdef123456",
      memoryProjectId: getRMemoryProjectId(workspace),
      evidenceRunIds: ["run-b", "run-a"],
    });
    const record = records.get(result.memoryId!);
    expect(record?.metadata).toMatchObject({
      memoryType: "advisory_lesson",
      scope: "project",
      validationStatus: "candidate",
      reviewState: "quarantined",
      projectId: getRMemoryProjectId(workspace),
      assertionKey: "skill_regression_review-checks",
    });
    expect(record?.metadata.evidence.map((x: { id: string }) => x.id)).toEqual(["run-b", "run-a"]);
    expect(record?.content).not.toContain("run-b");
    const eligible = filterEligibleMemoryRecords([{
      id: result.memoryId!, content: record!.content,
      scope: "project", metadata: record!.metadata,
    }], { projectId: getRMemoryProjectId(workspace) });
    expect(eligible.items).toHaveLength(0);
    expect(eligible.withheldCount).toBe(1);
  });

  it("never overwrites an existing advisory, including one approved/rejected by its owner", async () => {
    const { client, records } = clientFixture();
    records.set("skill-regression-review-checks-abcdef123456", {
      content: "owner reviewed",
      metadata: { validationStatus: "verified", reviewState: "reviewed" },
    });
    const result = await bridgeRepeatedSkillFailures({
      jobId: "job-1", workspacePath: workspace, pinnedSkillVersion, runs: failures, client: client as any,
    });
    expect(result.status).toBe("already_exists");
    expect(client.updateAtomic).not.toHaveBeenCalled();
    expect(records.get(result.memoryId!)?.content).toBe("owner reviewed");
  });

  it("creates a quarantined, scoped candidate for explicitly recorded negative feedback", async () => {
    const { client, records } = clientFixture();
    const feedbackId = "skill-feedback-12345678-1234-1234-1234-123456789abc";
    const result = await bridgeNegativeSkillFeedback({
      skillName: "review-checks",
      skillVersion: "abcdef123456",
      workspacePath: workspace,
      feedbackId,
      client: client as any,
    });
    expect(result.status).toBe("created");
    expect(result.memoryId).toBe("skill-feedback-review-checks-abcdef123456");
    const record = records.get(result.memoryId!);
    expect(record?.metadata).toMatchObject({
      scope: "project",
      projectId: getRMemoryProjectId(workspace),
      validationStatus: "candidate",
      reviewState: "quarantined",
    });
    expect(record?.metadata.evidence).toMatchObject([
      { id: feedbackId, kind: "user_feedback", status: "negative" },
    ]);
    expect(record?.content).not.toContain(feedbackId);
    expect((await bridgeNegativeSkillFeedback({
      skillName: "review-checks", skillVersion: "abcdef123456", workspacePath: workspace,
      feedbackId, client: client as any,
    })).status).toBe("already_exists");
    expect(client.updateAtomic).toHaveBeenCalledTimes(1);
  });

  it("rejects invented/malformed feedback references before contacting RMemory", async () => {
    const { client } = clientFixture();
    await expect(bridgeNegativeSkillFeedback({
      skillName: "review-checks", skillVersion: "abcdef123456", workspacePath: workspace,
      feedbackId: "not-an-evidence-id", client: client as any,
    })).rejects.toThrow(/Invalid version-bound/);
    expect(client.updateAtomic).not.toHaveBeenCalled();
    expect(client.inspectAtomic).not.toHaveBeenCalled();
  });

  it("does not invoke memory client when there is insufficient run evidence", async () => {
    const { client } = clientFixture();
    const result = await bridgeRepeatedSkillFailures({
      jobId: "job-1", workspacePath: workspace, pinnedSkillVersion, runs: [failures[0]], client: client as any,
    });
    expect(result.status).toBe("insufficient_evidence");
    expect(client.updateAtomic).not.toHaveBeenCalled();
  });
});
