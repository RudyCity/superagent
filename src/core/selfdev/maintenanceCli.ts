import path from "node:path";
import { getSelfDevConfig } from "./settings.js";
import { getSelfDevLessonsPath } from "../config/paths.js";
import { getHistoryDb } from "../storage/historyDb.js";
import { CandidateStore } from "./candidateStore.js";
import { SelfDevEventStore } from "./eventStore.js";
import { FeedbackTracker } from "./feedback.js";
import { ReviewService } from "./reviewService.js";
import {
  applySelfDevRetention,
  createSelfDevBackupBundle,
  inspectSelfDevRetention,
  readSelfDevBackupBundle,
  restoreSelfDevBackupBundle,
  writeSelfDevBackupBundle,
} from "./maintenance.js";

function intFlag(args: string[], name: string): number | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = Number(args[index + 1]);
  if (!Number.isSafeInteger(value)) throw new Error(`Expected an integer after ${name}`);
  return value;
}

function createStores(workspace: string) {
  const live = getSelfDevConfig();
  // Maintenance/recovery operations remain available when collection is disabled.
  const maintenanceConfig = { ...live, enabled: true, collectionEnabled: true, injectionEnabled: true, redactSecrets: true };
  const storePath = live.storePath || getSelfDevLessonsPath();
  const eventStore = new SelfDevEventStore({
    workspace,
    getDb: () => getHistoryDb() as any,
    config: maintenanceConfig,
  });
  const candidateStore = new CandidateStore({ storePath, workspace, enabled: () => true });
  const reviewService = new ReviewService({ storePath, enabled: () => true, eventStore });
  const feedbackTracker = new FeedbackTracker({ getDb: () => getHistoryDb() as any, enabled: () => true });
  return { workspace, eventStore, candidateStore, reviewService, feedbackTracker };
}

function readableTime(ts?: number): string {
  return typeof ts === "number" && Number.isFinite(ts) ? new Date(ts).toISOString() : "not recorded";
}

export async function handleSelfDevMaintenanceCommand(command: string, args: string[], workspace: string): Promise<string> {
  const stores = createStores(workspace);
  switch (command) {
    case "export":
    case "backup": {
      const destination = args.find(arg => !arg.startsWith("--"));
      if (!destination) throw new Error(`Usage: selfdev ${command} <output.json> [--overwrite]`);
      const bundle = await createSelfDevBackupBundle(stores);
      await writeSelfDevBackupBundle(path.resolve(destination), bundle, args.includes("--overwrite"));
      return [
        `Selfdev ${command} completed.`,
        `- File: ${path.resolve(destination)}`,
        `- Workspace: ${workspace}`,
        `- Events: ${bundle.manifest.counts.events}`,
        `- Lessons: ${bundle.manifest.counts.lessons}`,
        `- Feedback: ${bundle.manifest.counts.feedback}`,
        `- Review decisions: ${bundle.manifest.counts.reviewDecisions}`,
        `- SHA-256: ${bundle.manifest.sha256}`,
        "- Text fields were redacted for common secrets and URLs.",
      ].join("\n");
    }
    case "restore": {
      const source = args.find(arg => !arg.startsWith("--"));
      if (!source) throw new Error("Usage: selfdev restore <backup.json> [--apply]");
      const bundle = await readSelfDevBackupBundle(path.resolve(source), workspace);
      const targetEvents = stores.eventStore.getWorkspaceEventCount();
      const targetLessons = (await stores.candidateStore.list()).length;
      const targetFeedback = stores.feedbackTracker.getRecordCount(workspace);
      const targetDecisions = (await stores.candidateStore.getReviewDecisions()).length;
      const report = [
        "Selfdev restore validation passed.",
        `- Source: ${path.resolve(source)}`,
        `- Workspace match: ${workspace}`,
        `- Incoming records: ${bundle.manifest.counts.events} events, ${bundle.manifest.counts.lessons} lessons, ${bundle.manifest.counts.feedback} feedback, ${bundle.manifest.counts.reviewDecisions} review decisions`,
        `- Target records: ${targetEvents} events, ${targetLessons} lessons, ${targetFeedback} feedback, ${targetDecisions} review decisions`,
        "- Restore is permitted only when all target workspace stores are empty.",
      ];
      if (!args.includes("--apply")) {
        report.push("Dry run only. No data was changed. Add --apply to create a pre-restore backup and apply the restore.");
        return report.join("\n");
      }
      const preRestore = path.join(path.dirname(path.resolve(source)), `selfdev-pre-restore-${Date.now()}.json`);
      const currentBundle = await createSelfDevBackupBundle(stores);
      await writeSelfDevBackupBundle(preRestore, currentBundle, false);
      await restoreSelfDevBackupBundle(stores, bundle);
      report.push(`Pre-restore backup: ${preRestore}`, "Restore applied successfully.");
      return report.join("\n");
    }
    case "retention": {
      const days = intFlag(args, "--days");
      if (days === undefined) throw new Error("Usage: selfdev retention --days <1..3650> [--apply]");
      const report = await inspectSelfDevRetention(stores, days);
      const output = [
        `Selfdev retention ${args.includes("--apply") ? "apply request" : "dry run"}.`,
        `- Workspace: ${workspace}`,
        `- Retention age: ${report.days} day(s); cutoff: ${readableTime(report.cutoffMs)}`,
        `- Total events: ${report.totalEvents}`,
        `- Older than cutoff: ${report.oldEvents}`,
        `- Protected by lesson evidence: ${report.protectedEvents}`,
        `- Eligible for deletion: ${report.deletableEvents}`,
        "- All lesson states protect their referenced evidence; lessons and feedback are never deleted by this operation.",
      ];
      if (!args.includes("--apply")) {
        output.push("Dry run only. No data was changed. Add --apply to delete only the listed eligible event IDs.");
        return output.join("\n");
      }
      const deleted = await applySelfDevRetention(stores, days);
      output.push(`Deleted event records: ${deleted}`);
      return output.join("\n");
    }
    case "lesson-metrics": {
      const id = args[0];
      if (!id) throw new Error("Usage: selfdev lesson-metrics <lesson_id>");
      const lesson = await stores.reviewService.get(workspace, id);
      if (!lesson) throw new Error("Lesson not found in the current workspace");
      const metrics = stores.feedbackTracker.getMetrics(workspace, id);
      return [
        `Selfdev lesson metrics: ${id}`,
        `- Status/version: ${lesson.status} / v${lesson.version}`,
        `- Injected sessions: ${metrics.injectedCount}`,
        `- Applied sessions: ${metrics.appliedCount}`,
        `- Explicitly helped: ${metrics.helpedCount}`,
        `- Explicitly harmed: ${metrics.harmedCount}`,
        `- Last signal: ${readableTime(metrics.lastRecordedAt)}`,
        "- Counts are deduplicated per session, lesson version, and metric; they are not a confidence probability.",
      ].join("\n");
    }
    case "decisions": {
      const requested = args[0] ? Number(args[0]) : 50;
      if (!Number.isSafeInteger(requested) || requested < 1 || requested > 500) throw new Error("Usage: selfdev decisions [limit: 1..500]");
      const decisions = await stores.reviewService.getReviewDecisions(workspace, requested);
      if (!decisions.length) return `No review decisions recorded for workspace: ${workspace}`;
      return [
        `Selfdev review decisions (${decisions.length}, newest first):`,
        ...decisions.map(item => `- ${readableTime(item.timestamp)} | ${item.action} | ${item.lessonId} v${item.lessonVersion} | actor ${item.actor}${item.reason ? ` | ${item.reason}` : ""}`),
      ].join("\n");
    }
    default:
      throw new Error("Unknown Selfdev maintenance command");
  }
}

export async function handleSelfDevMaintenanceSlash(
  command: string,
  args: string[],
  workspace: string,
  addLine: (line: { type: "system" | "error"; content: string; timestamp: number }) => void,
): Promise<void> {
  try {
    const content = await handleSelfDevMaintenanceCommand(command, args, workspace);
    addLine({ type: "system", content, timestamp: Date.now() });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Maintenance operation failed";
    addLine({ type: "error", content: `Selfdev ${command} failed: ${message}`, timestamp: Date.now() });
  }
}
