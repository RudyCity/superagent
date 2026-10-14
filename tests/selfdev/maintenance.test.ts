import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CandidateStore } from "../../src/core/selfdev/candidateStore.js";
import { SelfDevEventStore } from "../../src/core/selfdev/eventStore.js";
import { FeedbackTracker } from "../../src/core/selfdev/feedback.js";
import { ReviewService } from "../../src/core/selfdev/reviewService.js";
import {
  applySelfDevRetention,
  createSelfDevBackupBundle,
  inspectSelfDevRetention,
  restoreSelfDevBackupBundle,
  validateSelfDevBackupBundle,
  type SelfDevMaintenanceStores,
} from "../../src/core/selfdev/maintenance.js";

const workspace = "selfdev-maintenance-workspace";
const directories: string[] = [];
const databases: DatabaseSync[] = [];

async function fixture(targetWorkspace = workspace): Promise<SelfDevMaintenanceStores & { testDb: DatabaseSync }> {
  const directory = await mkdtemp(join(tmpdir(), "superagent-selfdev-maint-"));
  directories.push(directory);
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  const storePath = join(directory, "lessons.json");
  const eventStore = new SelfDevEventStore({
    workspace: targetWorkspace,
    getDb: () => db as any,
    config: { enabled: true, collectionEnabled: true, maxEventsPerWorkspace: 1000 },
  });
  const candidateStore = new CandidateStore({ storePath, workspace: targetWorkspace, enabled: () => true });
  const reviewService = new ReviewService({ storePath, enabled: () => true, eventStore });
  const feedbackTracker = new FeedbackTracker({ getDb: () => db as any, enabled: () => true });
  return { workspace: targetWorkspace, eventStore, candidateStore, reviewService, feedbackTracker, testDb: db };
}

afterEach(async () => {
  for (const db of databases.splice(0)) db.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("Selfdev maintenance", () => {
  it("creates and verifies a bounded redacted backup bundle", async () => {
    const stores = await fixture();
    stores.eventStore.record({
      id: "event-protected",
      ts: Date.now() - 3 * 24 * 60 * 60 * 1000,
      workspace,
      sessionId: "session-a",
      kind: "user_feedback",
      summary: "Always run focused tests before merge. See https://example.com/path?token=abc123secret",
    });
    stores.eventStore.record({
      id: "event-unreferenced",
      ts: Date.now() - 3 * 24 * 60 * 60 * 1000,
      workspace,
      sessionId: "session-b",
      kind: "task_completed",
      summary: "Task completed with a harmless summary",
    });
    const lesson = await stores.candidateStore.create({
      workspace,
      statement: "Run focused tests before merging a change",
      evidenceIds: ["event-protected"],
      tags: ["workflow"],
    });
    expect(lesson).toBeDefined();
    stores.feedbackTracker.record(workspace, "session-a", lesson!.id, lesson!.version, "injected");

    const bundle = await createSelfDevBackupBundle(stores);
    expect(bundle.manifest.counts.events).toBe(2);
    expect(bundle.manifest.counts.lessons).toBe(1);
    expect(bundle.manifest.counts.feedback).toBe(1);
    expect(bundle.manifest.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(bundle)).not.toContain("https://example.com");
    expect(JSON.stringify(bundle)).not.toContain("abc123secret");
    expect(validateSelfDevBackupBundle(bundle, workspace).manifest.sha256).toBe(bundle.manifest.sha256);

    const tampered = structuredClone(bundle);
    tampered.data.events[0].summary += " tampered";
    expect(() => validateSelfDevBackupBundle(tampered, workspace)).toThrow(/checksum/i);
    expect(() => validateSelfDevBackupBundle(bundle, "other-workspace")).toThrow(/workspace mismatch/i);
  });

  it("restores events, lessons, and feedback only into a fully empty workspace", async () => {
    const source = await fixture();
    source.eventStore.record({
      id: "restore-evidence",
      workspace,
      sessionId: "restore-session",
      kind: "user_feedback",
      summary: "Keep workspace state isolated",
    });
    const lesson = await source.candidateStore.create({
      workspace,
      statement: "Keep workspace state isolated",
      evidenceIds: ["restore-evidence"],
      tags: ["workspace"],
    });
    source.feedbackTracker.record(workspace, "restore-session", lesson!.id, lesson!.version, "injected");
    const bundle = await createSelfDevBackupBundle(source);

    const target = await fixture();
    await restoreSelfDevBackupBundle(target, bundle);
    expect(target.eventStore.getWorkspaceEventCount()).toBe(1);
    expect(await target.candidateStore.list()).toHaveLength(1);
    expect(target.feedbackTracker.getRecordCount(workspace)).toBe(1);
    expect(target.eventStore.hasEvidence("restore-evidence")).toBe(true);

    await expect(restoreSelfDevBackupBundle(target, bundle)).rejects.toThrow(/empty target workspace/i);
  });

  it("requires exact workspace matching and refuses malformed evidence before import", async () => {
    const source = await fixture();
    source.eventStore.record({
      id: "required-event",
      workspace,
      sessionId: "s",
      kind: "user_feedback",
      summary: "An evidence record",
    });
    await source.candidateStore.create({
      workspace,
      statement: "An evidence-based lesson",
      evidenceIds: ["required-event"],
    });
    const bundle = await createSelfDevBackupBundle(source);

    const wrongWorkspaceTarget = await fixture("another-workspace");
    await expect(restoreSelfDevBackupBundle(wrongWorkspaceTarget, bundle)).rejects.toThrow(/workspace mismatch/i);
    const malformed = structuredClone(bundle);
    malformed.data.lessons[0].evidenceIds = ["missing-evidence"];
    expect(() => validateSelfDevBackupBundle(malformed, workspace)).toThrow(/checksum/i);
  });

  it("rolls back a restore when an event write fails after lessons have been restored", async () => {
    const source = await fixture();
    source.eventStore.record({
      id: "trigger-failure-event",
      workspace,
      sessionId: "s-failure",
      kind: "task_completed",
      summary: "Should never partially restore",
    });
    const bundle = await createSelfDevBackupBundle(source);
    const target = await fixture();
    target.eventStore.getWorkspaceEventCount();
    target.testDb.exec("CREATE TRIGGER reject_selfdev_restore BEFORE INSERT ON selfdev_events BEGIN SELECT RAISE(ABORT, 'injected restore fault'); END");

    await expect(restoreSelfDevBackupBundle(target, bundle)).rejects.toThrow(/injected restore fault/i);
    expect(target.eventStore.getWorkspaceEventCount()).toBe(0);
    expect(await target.candidateStore.list()).toHaveLength(0);
    expect(target.feedbackTracker.getRecordCount(workspace)).toBe(0);
  });

  it("retention preview protects any event referenced by a lesson and deletes only unreferenced old events", async () => {
    const stores = await fixture();
    const old = Date.now() - 4 * 24 * 60 * 60 * 1000;
    stores.eventStore.record({
      id: "protected-old",
      ts: old,
      workspace,
      sessionId: "s1",
      kind: "user_feedback",
      summary: "Old event supporting a lesson",
    });
    stores.eventStore.record({
      id: "unprotected-old",
      ts: old - 1,
      workspace,
      sessionId: "s2",
      kind: "task_completed",
      summary: "Old event with no linked lesson",
    });
    await stores.candidateStore.create({
      workspace,
      statement: "Retain evidence for reviewed lessons",
      evidenceIds: ["protected-old"],
    });

    const preview = await inspectSelfDevRetention(stores, 1);
    expect(preview.protectedEvents).toBe(1);
    expect(preview.deletableEvents).toBe(1);
    expect(stores.eventStore.getWorkspaceEventCount()).toBe(2);

    const deleted = await applySelfDevRetention(stores, 1);
    expect(deleted).toBe(1);
    expect(stores.eventStore.getWorkspaceEventCount()).toBe(1);
    expect(stores.eventStore.hasEvidence("protected-old")).toBe(true);
  });
});
