import { randomUUID } from "node:crypto";
import { getSelfDevConfig, updateSelfDevConfig } from "../selfdev/settings.js";
import { getSelfDevLessonsPath } from "../config/paths.js";
import { getHistoryDb } from "../storage/historyDb.js";
import { SelfDevEventStore } from "../selfdev/eventStore.js";
import { ReviewService } from "../selfdev/reviewService.js";
import { CandidateStore } from "../selfdev/candidateStore.js";
import { distillAndStore } from "../selfdev/distiller.js";

function safeSelfDevEvidenceText(value: string): string {
  return value
    .replace(/https?:\/\/[^\s)\]}]+/gi, "[URL REDACTED]")
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/=:-]+/gi, "[REDACTED]")
    .replace(/\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{8,})\b/g, "[REDACTED]")
    .slice(0, 240);
}
export function printSelfDevHelp(): void {
  console.log(`
Usage: superagent selfdev <command> [options]

Commands:
  status                                Show Self-Dev engine configuration and lesson counts
  doctor                                Run read-only configuration/storage/workspace diagnostics
  metrics                               Show stored learning metrics and current-process counters
  enable                                Enable self-development globally
  disable                               Disable self-development globally
  list [candidate|active|retired]       List lessons for current workspace
  inspect <lesson_id>                   Inspect lesson provenance and workspace-scoped evidence
  review                                Interactive review wizard for pending candidate lessons
  distill [max]                         Distill recent session events into candidate lessons
  approve <lesson_id> [version]         Approve a candidate lesson to make it active
  feedback <lesson_id> <applied|helped|harmed>  Record explicit feedback for an active lesson
  reject <lesson_id> [reason]           Reject and discard a candidate lesson
  retire <lesson_id> [reason]           Retire an active lesson to stop injecting it
  lesson-metrics <lesson_id>            Show per-lesson feedback counts
  decisions [limit]                     Show recent review audit decisions
  export <output.json> [--overwrite]    Export redacted workspace backup
  backup <output.json> [--overwrite]    Alias for export
  restore <backup.json> [--apply]       Validate restore; dry-run unless --apply
  retention --days <N> [--apply]        Preview/delete old unreferenced events

Examples:
  superagent selfdev status
  superagent selfdev list
  superagent selfdev distill
  superagent selfdev approve lesson_123
  superagent selfdev enable
`);
}

export async function handleSelfDevCliCommand(args: string[]): Promise<void> {
  const subcommand = args[0]?.toLowerCase();
  const workspace = process.cwd();

  if (!subcommand || subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    printSelfDevHelp();
    process.exit(0);
  }

  const config = getSelfDevConfig();
  const storePath = config.storePath || getSelfDevLessonsPath();

  const eventStore = new SelfDevEventStore({
    workspace,
    getDb: () => getHistoryDb() as any,
    config,
  });

  const candidateStore = new CandidateStore({
    storePath,
    workspace,
    enabled: () => config.enabled,
  });

  const reviewService = new ReviewService({
    storePath,
    enabled: () => config.enabled,
    eventStore,
  });

  if (["export", "backup", "restore", "retention", "lesson-metrics", "decisions"].includes(subcommand)) {
    const { handleSelfDevMaintenanceCommand } = await import("../selfdev/maintenanceCli.js");
    console.log(await handleSelfDevMaintenanceCommand(subcommand, args.slice(1), workspace));
    process.exit(0);
  }

  switch (subcommand) {
    case "status": {
      let candidateCount = 0;
      let activeCount = 0;
      let retiredCount = 0;

      try {
        const lessons = await reviewService.list(workspace);
        candidateCount = lessons.filter((l) => l.status === "candidate").length;
        activeCount = lessons.filter((l) => l.status === "active").length;
        retiredCount = lessons.filter((l) => l.status === "retired").length;
      } catch {}

      console.log("Self-Development Engine Status:");
      console.log(`- Enabled           : ${config.enabled ? "Yes" : "No"}`);
      console.log(`- Config Version    : ${config.configVersion}`);
      console.log(`- Explicit Opt-out  : ${config.userOptOut ? "Yes" : "No"}`);
      console.log(`- Event Collection  : ${config.collectionEnabled ? "Yes" : "No"}`);
      console.log(`- Prompt Injection  : ${config.injectionEnabled ? "Yes" : "No"}`);
      console.log(`- Active Workspace  : ${workspace}`);
      console.log(`- Store Path        : ${storePath}`);
      console.log(`- Active Lessons    : ${activeCount}`);
      console.log(`- Candidate Lessons : ${candidateCount}`);
      console.log(`- Retired Lessons   : ${retiredCount}`);
      process.exit(0);
      break;
    }

    case "doctor": {
      try {
        const { getSelfDevDoctorReport } = await import("../selfdev/diagnostics.js");
        const report = await getSelfDevDoctorReport(workspace);
        console.log("Selfdev Doctor (read-only):");
        console.log(`- Enabled: ${report.enabled ? "Yes" : "No"}`);
        console.log(`- Explicit opt-out: ${report.userOptOut ? "Yes" : "No"}`);
        console.log(`- Config version: ${report.configVersion}`);
        console.log(`- Events in workspace: ${report.eventCount}`);
        for (const check of report.checks) {
          const marker = check.state === "ok" ? "OK" : check.state === "error" ? "ERROR" : check.state.toUpperCase();
          console.log(`[${marker}] ${check.name}: ${check.detail}`);
        }
        process.exit(report.healthy ? 0 : 1);
      } catch {
        console.log("Selfdev Doctor failed: diagnostic operation could not complete.");
        process.exit(1);
      }
      break;
    }

    case "metrics": {
      try {
        const { getSelfDevMetricsReport } = await import("../selfdev/diagnostics.js");
        const report = await getSelfDevMetricsReport(workspace);
        console.log("Selfdev Metrics (workspace-scoped stored data):");
        console.log(`- Enabled: ${report.enabled ? "Yes" : "No"}`);
        console.log(`- Config version: ${report.configVersion}`);
        console.log(`- Storage query: ${report.storageAvailable ? "available" : "FAILED (counts may be incomplete)"}`);
        console.log(`- Stored events: ${report.eventCount}`);
        console.log(`- Lessons: ${report.lessonCounts.candidate} candidate, ${report.lessonCounts.active} active, ${report.lessonCounts.retired} retired`);
        console.log("Events by kind:");
        for (const [kind, count] of Object.entries(report.eventsByKind).sort(([a], [b]) => a.localeCompare(b))) {
          console.log(`  ${kind}: ${count}`);
        }
        console.log("Explicit feedback:");
        console.log(`  injected: ${report.feedback.injected}; applied: ${report.feedback.applied}; helped: ${report.feedback.helped}; harmed: ${report.feedback.harmed}`);
        console.log("Current-process counters (reset on restart):");
        console.log(JSON.stringify(report.runtime, null, 2));
        process.exit(0);
      } catch {
        console.log("Selfdev metrics failed: diagnostic operation could not complete.");
        process.exit(1);
      }
      break;
    }

    case "feedback": {
      const id = args[1];
      const metric = args[2]?.toLowerCase();
      if (!id || !["applied", "helped", "harmed"].includes(metric || "")) {
        console.log("Usage: superagent selfdev feedback <lesson_id> <applied|helped|harmed> [session_id]");
        process.exit(1);
      }
      try {
        const lesson = await reviewService.get(workspace, id);
        if (!lesson || lesson.status !== "active") {
          console.log("Feedback can only be recorded for an active lesson in the current workspace.");
          process.exit(1);
        }
        const { FeedbackTracker } = await import("../selfdev/feedback.js");
        const tracker = new FeedbackTracker({ getDb: () => getHistoryDb() as any, enabled: () => getSelfDevConfig().enabled });
        const sessionId = args[3] || `manual:${randomUUID()}`;
        const feedbackResult = tracker.recordDetailed(workspace, sessionId, lesson.id, lesson.version, metric as "applied" | "helped" | "harmed");
        if (feedbackResult.status === "duplicate") {
          console.log(`Feedback already recorded for session ${sessionId}, lesson ${lesson.id}, version ${lesson.version}, metric ${metric}.`);
          process.exit(0);
        }
        if (feedbackResult.status !== "recorded") {
          console.log(`Feedback was not recorded (status: ${feedbackResult.status}).`);
          process.exit(1);
        }
        console.log(`Recorded ${metric} feedback for active lesson ${lesson.id} (v${lesson.version}, session ${sessionId}).`);
        process.exit(0);
      } catch {
        console.log("Feedback failed: operation could not complete.");
        process.exit(1);
      }
      break;
    }

    case "enable": {
      updateSelfDevConfig({ enabled: true });
      console.log("Self-Development engine enabled.");
      process.exit(0);
      break;
    }

    case "disable": {
      updateSelfDevConfig({ enabled: false });
      console.log("Self-Development engine disabled.");
      process.exit(0);
      break;
    }

    case "inspect": {
      const id = args[1];
      if (!id) {
        console.log("Usage: superagent selfdev inspect <lesson_id>");
        process.exit(1);
      }
      try {
        const result = await reviewService.inspect(workspace, id);
        if (!result) {
          console.log("Lesson not found in the current workspace.");
          process.exit(1);
        }
        const lesson = result.lesson;
        const evidenceEvents = result.evidenceEvents ?? [];
        const evidenceById = new Map(evidenceEvents.map(event => [event.id, event]));
        const sourceLabels: Record<string, string> = {
          fix_cycle: "failure followed by verified success",
          user_feedback: "explicit user feedback",
          lesson_proposed: "explicit lesson proposal",
        };
        const sources = lesson.tags.filter(tag => sourceLabels[tag]).map(tag => sourceLabels[tag]);
        console.log(`Selfdev Lesson Provenance — ${lesson.id}`);
        console.log(`- Workspace-scoped result: yes`);
        console.log(`- Status/version: ${lesson.status} / v${lesson.version}`);
        console.log(`- Statement: ${lesson.statement}`);
        console.log(`- Source signals: ${sources.length ? [...new Set(sources)].join(", ") : "not explicitly categorized"}`);
        console.log(`- Evidence references: ${lesson.evidenceIds.length}; verified event records: ${evidenceEvents.length}; missing/unavailable: ${Math.max(0, lesson.evidenceIds.length - evidenceEvents.length)}`);
        if (lesson.approvedBy) console.log(`- Approved by: ${lesson.approvedBy}`);
        if (lesson.approvedAt) console.log(`- Approved at: ${new Date(lesson.approvedAt).toISOString()}`);
        if (lesson.retiredAt) console.log(`- Retired at: ${new Date(lesson.retiredAt).toISOString()}`);
        if (lesson.retiredReason) console.log(`- Retirement reason: ${safeSelfDevEvidenceText(lesson.retiredReason)}`);
        console.log("Evidence (bounded summaries; exact workspace only):");
        if (lesson.evidenceIds.length === 0) console.log("  No evidence references are attached.");
        for (const evidenceId of lesson.evidenceIds) {
          const event = evidenceById.get(evidenceId);
          if (!event) {
            console.log(`  - ${evidenceId}: MISSING or unavailable in this workspace`);
            continue;
          }
          console.log(`  - ${event.id} | ${event.kind} | session ${event.sessionId} | ${new Date(event.ts).toISOString()}`);
          console.log(`    ${safeSelfDevEvidenceText(event.summary)}`);
        }
        console.log("Note: evidence count and explicit feedback are review signals, not a calibrated probability score.");
        process.exit(0);
      } catch {
        console.log("Lesson inspection failed: the lesson store or workspace evidence could not be read.");
        process.exit(1);
      }
      break;
    }

    case "list": {
      const filterStatus = args[1]?.toLowerCase() as any;
      try {
        const lessons = await reviewService.list(workspace, filterStatus);
        if (lessons.length === 0) {
          console.log(`No ${filterStatus ? filterStatus + " " : ""}lessons found for workspace: ${workspace}`);
          console.log("Run 'superagent selfdev distill' to generate candidates from recent session events.");
          process.exit(0);
        }

        console.log(`Lessons for workspace (${lessons.length}):`);
        for (const l of lessons) {
          console.log(`\n- [${l.status.toUpperCase()}] ID: ${l.id} (v${l.version})`);
          console.log(`  Statement: ${l.statement}`);
          console.log(`  Rationale: ${l.rationale || "None"}`);
          console.log(`  Tags     : ${l.tags?.join(", ") || "none"}`);
        }
        process.exit(0);
      } catch (err: any) {
        console.log(`Failed to list lessons: ${err.message}`);
        process.exit(1);
      }
      break;
    }

    case "review": {
      try {
        const candidates = await reviewService.list(workspace, "candidate");
        if (candidates.length === 0) {
          console.log("No candidate lessons pending review for this workspace.");
          console.log("Run 'superagent selfdev distill' to extract new candidates from recent tasks.");
          process.exit(0);
        }

        console.log(`Starting interactive review for ${candidates.length} candidate lesson(s)...\n`);
        const readline = await import("readline");
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        });

        const question = (query: string): Promise<string> =>
          new Promise((resolve) => rl.question(query, resolve));

        for (let i = 0; i < candidates.length; i++) {
          const c = candidates[i];
          console.log(`------------------------------------------------------------`);
          console.log(`[${i + 1}/${candidates.length}] Lesson ID: ${c.id} (v${c.version})`);
          console.log(`Statement: ${c.statement}`);
          console.log(`Rationale: ${c.rationale || "None"}`);
          console.log(`Tags     : ${c.tags?.join(", ") || "none"}`);
          console.log(`------------------------------------------------------------`);

          const answer = (await question("Action: [a]pprove, [r]eject, [s]kip, [q]uit? ")).trim().toLowerCase();

          if (answer === "a" || answer === "approve") {
            await reviewService.approve(workspace, c.id, c.version, "cli_reviewer");
            console.log(`✓ Approved and activated ${c.id}.\n`);
          } else if (answer === "r" || answer === "reject") {
            const reason = (await question("Rejection reason (optional): ")).trim() || "Rejected in CLI review";
            await reviewService.reject(workspace, c.id, c.version, reason);
            console.log(`✗ Rejected and deleted candidate ${c.id}.\n`);
          } else if (answer === "q" || answer === "quit") {
            console.log("Review session terminated.");
            break;
          } else {
            console.log(`Skipped ${c.id}.\n`);
          }
        }

        rl.close();
        console.log("Review completed.");
        process.exit(0);
      } catch (err: any) {
        console.log(`Review failed: ${err.message}`);
        process.exit(1);
      }
      break;
    }

    case "distill": {
      const maxCandidates = args[1] ? parseInt(args[1], 10) : 5;
      console.log(`Distilling recent task events for workspace: ${workspace}...`);
      try {
        const events = eventStore.list({ limit: 100 });
        if (events.length === 0) {
          console.log("No recorded events found in this workspace yet.");
          process.exit(0);
        }

        const existingLessons = await candidateStore.list();
        const saved = await distillAndStore({
          workspace,
          events,
          existingLessons,
          candidateStore,
          maxCandidates,
          validateEvidence: id => eventStore.hasEvidence(id),
        });

        if (saved.length === 0) {
          console.log(`Analyzed ${events.length} events: no new candidates generated.`);
        } else {
          console.log(`Distillation complete! Generated ${saved.length} new candidate lesson(s):`);
          for (const l of saved) {
            console.log(`- [Candidate] ${l.id}: ${l.statement}`);
            console.log(`  To approve: superagent selfdev approve ${l.id} ${l.version}`);
          }
        }
        process.exit(0);
      } catch (err: any) {
        console.log(`Distillation failed: ${err.message}`);
        process.exit(1);
      }
      break;
    }

    case "approve": {
      const id = args[1];
      if (!id) {
        console.log("Usage: superagent selfdev approve <lesson_id> [version]");
        process.exit(1);
      }
      try {
        let version = args[2] ? parseInt(args[2], 10) : undefined;
        if (version === undefined) {
          const lesson = await reviewService.get(workspace, id);
          if (!lesson) {
            console.log(`Error: Lesson not found: ${id}`);
            process.exit(1);
          }
          version = lesson.version;
        }

        const approved = await reviewService.approve(workspace, id, version, "human_reviewer");
        console.log(`Lesson approved and activated: ${approved.id}`);
        console.log(`Statement: ${approved.statement}`);
        process.exit(0);
      } catch (err: any) {
        console.log(`Approval failed: ${err.message}`);
        process.exit(1);
      }
      break;
    }

    case "reject": {
      const id = args[1];
      const reason = args.slice(2).join(" ") || "Rejected by user via CLI";
      if (!id) {
        console.log("Usage: superagent selfdev reject <lesson_id> [reason]");
        process.exit(1);
      }
      try {
        const lesson = await reviewService.get(workspace, id);
        if (!lesson) {
          console.log(`Error: Lesson not found: ${id}`);
          process.exit(1);
        }
        await reviewService.reject(workspace, id, lesson.version, reason);
        console.log(`Lesson ${id} rejected.`);
        process.exit(0);
      } catch (err: any) {
        console.log(`Rejection failed: ${err.message}`);
        process.exit(1);
      }
      break;
    }

    case "retire": {
      const id = args[1];
      const reason = args.slice(2).join(" ") || "Retired by user via CLI";
      if (!id) {
        console.log("Usage: superagent selfdev retire <lesson_id> [reason]");
        process.exit(1);
      }
      try {
        const lesson = await reviewService.get(workspace, id);
        if (!lesson) {
          console.log(`Error: Lesson not found: ${id}`);
          process.exit(1);
        }
        const retired = await reviewService.retire(workspace, id, lesson.version, reason);
        console.log(`Lesson ${retired.id} retired.`);
        process.exit(0);
      } catch (err: any) {
        console.log(`Retire failed: ${err.message}`);
        process.exit(1);
      }
      break;
    }

    default: {
      console.log(`Unknown selfdev command: ${subcommand}`);
      printSelfDevHelp();
      process.exit(1);
    }
  }
}
