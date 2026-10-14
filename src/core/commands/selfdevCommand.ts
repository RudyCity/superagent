import { registry } from "./registry.js";
import { SlashCommand } from "./types.js";

// /selfdev command
export const selfdevCommand: SlashCommand = {
  name: "selfdev",
  description: "Inspect, distill, review, and manage self-development behavioral lessons",
  async execute(args, ctx) {
    const parts = args.trim().split(/\s+/).filter(Boolean);
    const subcommand = (parts[0] || "status").toLowerCase();
    const now = Date.now();
    const workspace = ctx.agent?.workingDirectory || process.cwd();

    const { getSelfDevConfig, updateSelfDevConfig } = await import("../selfdev/settings.js");
    const { getSelfDevLessonsPath } = await import("../config/paths.js");
    const { getHistoryDb } = await import("../storage/historyDb.js");
    const { SelfDevEventStore } = await import("../selfdev/eventStore.js");
    const { ReviewService } = await import("../selfdev/reviewService.js");
    const { CandidateStore } = await import("../selfdev/candidateStore.js");
    const { distillAndStore } = await import("../selfdev/distiller.js");

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

        ctx.addLine({
          type: "system",
          content: [
            "Self-Development Engine Status:",
            `- Enabled           : ${config.enabled ? "Yes" : "No"}`,
            `- Config Version    : ${config.configVersion}`,
            `- Explicit Opt-out  : ${config.userOptOut ? "Yes" : "No"}`,
            `- Event Collection  : ${config.collectionEnabled ? "Yes" : "No"}`,
            `- Prompt Injection  : ${config.injectionEnabled ? "Yes" : "No"}`,
            `- Active Workspace  : ${workspace}`,
            `- Store Path        : ${storePath}`,
            `- Active Lessons    : ${activeCount}`,
            `- Candidate Lessons : ${candidateCount}`,
            `- Retired Lessons   : ${retiredCount}`,
            "",
            "Commands: /selfdev list | /selfdev inspect <id> | /selfdev distill | /selfdev approve <id> | /selfdev enable | /selfdev disable",
          ].join("\n"),
          timestamp: now,
        });
        break;
      }

      case "doctor": {
        try {
          const { getSelfDevDoctorReport } = await import("../selfdev/diagnostics.js");
          const report = await getSelfDevDoctorReport(workspace);
          ctx.addLine({
            type: report.healthy ? "system" : "error",
            content: [
              "Selfdev Doctor (read-only):",
              `- Enabled: ${report.enabled ? "Yes" : "No"}`,
              `- Explicit opt-out: ${report.userOptOut ? "Yes" : "No"}`,
              `- Config version: ${report.configVersion}`,
              `- Events in workspace: ${report.eventCount}`,
              ...report.checks.map(check => `[${check.state.toUpperCase()}] ${check.name}: ${check.detail}`),
            ].join("\n"),
            timestamp: now,
          });
        } catch {
          ctx.addLine({ type: "error", content: "Selfdev Doctor failed: diagnostic operation could not complete.", timestamp: now });
        }
        break;
      }

      case "metrics": {
        try {
          const { getSelfDevMetricsReport } = await import("../selfdev/diagnostics.js");
          const report = await getSelfDevMetricsReport(workspace);
          ctx.addLine({
            type: "system",
            content: [
              "Selfdev Metrics (workspace-scoped stored data):",
              `- Enabled: ${report.enabled ? "Yes" : "No"}`,
              `- Config version: ${report.configVersion}`,
              `- Storage query: ${report.storageAvailable ? "available" : "FAILED (counts may be incomplete)"}`,
              `- Stored events: ${report.eventCount}`,
              `- Lessons: ${report.lessonCounts.candidate} candidate, ${report.lessonCounts.active} active, ${report.lessonCounts.retired} retired`,
              "Events by kind:",
              ...Object.entries(report.eventsByKind).sort(([a], [b]) => a.localeCompare(b)).map(([kind, count]) => `  ${kind}: ${count}`),
              `Feedback: injected ${report.feedback.injected}; applied ${report.feedback.applied}; helped ${report.feedback.helped}; harmed ${report.feedback.harmed}`,
              "Current-process counters reset on restart.",
              JSON.stringify(report.runtime),
            ].join("\n"),
            timestamp: now,
          });
        } catch {
          ctx.addLine({ type: "error", content: "Selfdev metrics failed: diagnostic operation could not complete.", timestamp: now });
        }
        break;
      }

      case "feedback": {
        const id = parts[1];
        const metric = parts[2]?.toLowerCase();
        if (!id || !["applied", "helped", "harmed"].includes(metric || "")) {
          ctx.addLine({ type: "error", content: "Usage: /selfdev feedback <lesson_id> <applied|helped|harmed>", timestamp: now });
          break;
        }
        try {
          const lesson = await reviewService.get(workspace, id);
          if (!lesson || lesson.status !== "active") {
            ctx.addLine({ type: "error", content: "Feedback can only be recorded for an active lesson in this workspace.", timestamp: now });
            break;
          }
          const { FeedbackTracker } = await import("../selfdev/feedback.js");
          const tracker = new FeedbackTracker({ getDb: () => getHistoryDb() as any, enabled: () => getSelfDevConfig().enabled });
          const sessionId = ctx.agent?.sessionId || `slash:${workspace}:${lesson.id}:v${lesson.version}`;
          const recorded = tracker.record(workspace, sessionId, lesson.id, lesson.version, metric as "applied" | "helped" | "harmed");
          ctx.addLine({
            type: recorded ? "system" : "error",
            content: recorded ? `Recorded ${metric} feedback for lesson ${lesson.id} (v${lesson.version}).` : "Feedback was not recorded; check Selfdev state and database availability.",
            timestamp: now,
          });
        } catch {
          ctx.addLine({ type: "error", content: "Feedback failed: operation could not complete.", timestamp: now });
        }
        break;
      }

      case "enable": {
        updateSelfDevConfig({ enabled: true });
        ctx.addLine({
          type: "system",
          content: "Self-Development engine enabled. Events will be collected and lessons applied.",
          timestamp: now,
        });
        break;
      }

      case "disable": {
        updateSelfDevConfig({ enabled: false });
        ctx.addLine({
          type: "system",
          content: "Self-Development engine disabled.",
          timestamp: now,
        });
        break;
      }

      case "inspect": {
        const id = parts[1];
        if (!id) {
          ctx.addLine({ type: "error", content: "Usage: /selfdev inspect <lesson_id>", timestamp: now });
          break;
        }
        try {
          const result = await reviewService.inspect(workspace, id);
          if (!result) {
            ctx.addLine({ type: "error", content: "Lesson not found in the current workspace.", timestamp: now });
            break;
          }
          const lesson = result.lesson;
          const evidenceEvents = result.evidenceEvents ?? [];
          const evidenceById = new Map(evidenceEvents.map(event => [event.id, event]));
          const sourceLabels: Record<string, string> = {
            fix_cycle: "failure followed by verified success",
            user_feedback: "explicit user feedback",
            lesson_proposed: "explicit lesson proposal",
          };
          const sources = [...new Set(lesson.tags.filter(tag => sourceLabels[tag]).map(tag => sourceLabels[tag]))];
          const lines = [
            `Selfdev Lesson Provenance — ${lesson.id}`,
            "- Workspace-scoped result: yes",
            `- Status/version: ${lesson.status} / v${lesson.version}`,
            `- Statement: ${lesson.statement}`,
            `- Source signals: ${sources.length ? sources.join(", ") : "not explicitly categorized"}`,
            `- Evidence references: ${lesson.evidenceIds.length}; verified event records: ${evidenceEvents.length}; missing/unavailable: ${Math.max(0, lesson.evidenceIds.length - evidenceEvents.length)}`,
            ...(lesson.approvedBy ? [`- Approved by: ${lesson.approvedBy}`] : []),
            ...(lesson.approvedAt ? [`- Approved at (epoch ms): ${lesson.approvedAt}`] : []),
            "Evidence (bounded summaries; exact workspace only):",
          ];
          if (lesson.evidenceIds.length === 0) lines.push("  No evidence references are attached.");
          for (const evidenceId of lesson.evidenceIds) {
            const event = evidenceById.get(evidenceId);
            if (!event) {
              lines.push(`  - ${evidenceId}: MISSING or unavailable in this workspace`);
              continue;
            }
            lines.push(`  - ${event.id} | ${event.kind} | session ${event.sessionId} | ts ${event.ts}`, `    ${event.summary.slice(0, 240)}`);
          }
          lines.push("Note: evidence count and explicit feedback are review signals, not a calibrated probability score.");
          ctx.addLine({ type: "system", content: lines.join("\n"), timestamp: now });
        } catch {
          ctx.addLine({ type: "error", content: "Lesson inspection failed: the lesson store or workspace evidence could not be read.", timestamp: now });
        }
        break;
      }

      case "list": {
        const filterStatus = parts[1]?.toLowerCase() as any;
        try {
          const lessons = await reviewService.list(workspace, filterStatus);
          if (lessons.length === 0) {
            ctx.addLine({
              type: "system",
              content: `No ${filterStatus ? filterStatus + " " : ""}lessons found for workspace:\n${workspace}\n\nRun /selfdev distill to generate candidates from recent session events.`,
              timestamp: now,
            });
            break;
          }

          const lines = [`Lessons for ${workspace} (${lessons.length}):`];
          for (const l of lessons) {
            lines.push(
              `\n- [${l.status.toUpperCase()}] ID: ${l.id} (v${l.version})`,
              `  Statement: ${l.statement}`,
              `  Rationale: ${l.rationale || "None"}`,
              `  Tags     : ${l.tags?.join(", ") || "none"}`
            );
          }
          ctx.addLine({ type: "system", content: lines.join("\n"), timestamp: now });
        } catch (err: any) {
          ctx.addLine({ type: "error", content: `Failed to list lessons: ${err.message}`, timestamp: now });
        }
        break;
      }

      case "distill": {
        const maxCandidates = parts[1] ? parseInt(parts[1], 10) : 5;
        ctx.addLine({
          type: "system",
          content: `Distilling recent task events for workspace: ${workspace}...`,
          timestamp: now,
        });

        try {
          // Read events from eventStore
          const events = eventStore.list({ limit: 100 });
          if (events.length === 0) {
            ctx.addLine({
              type: "system",
              content: "No recorded events found in this workspace yet. Execute tasks to record events.",
              timestamp: Date.now(),
            });
            break;
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
            ctx.addLine({
              type: "system",
              content: `Analyzed ${events.length} events: no new operational lesson candidates found (or duplicates detected).`,
              timestamp: Date.now(),
            });
          } else {
            const lines = [
              `Distillation complete! Generated ${saved.length} new candidate lesson(s):`,
            ];
            for (const l of saved) {
              lines.push(
                `\n- Candidate ID: ${l.id}`,
                `  Statement: ${l.statement}`,
                `  To approve: /selfdev approve ${l.id} ${l.version}`
              );
            }
            ctx.addLine({ type: "system", content: lines.join("\n"), timestamp: Date.now() });
          }
        } catch (err: any) {
          ctx.addLine({ type: "error", content: `Distillation error: ${err.message}`, timestamp: Date.now() });
        }
        break;
      }

      case "approve": {
        const id = parts[1];
        if (!id) {
          ctx.addLine({ type: "error", content: "Usage: /selfdev approve <lesson_id> [version]", timestamp: now });
          break;
        }

        try {
          let version = parts[2] ? parseInt(parts[2], 10) : undefined;
          if (version === undefined) {
            const lesson = await reviewService.get(workspace, id);
            if (!lesson) {
              ctx.addLine({ type: "error", content: `Lesson not found: ${id}`, timestamp: now });
              break;
            }
            version = lesson.version;
          }

          const approved = await reviewService.approve(workspace, id, version, "human_reviewer");
          ctx.addLine({
            type: "system",
            content: [
              `Lesson approved and activated!`,
              `- ID       : ${approved.id}`,
              `- Status   : active`,
              `- Statement: ${approved.statement}`,
              "This operational lesson will now be automatically injected into system prompts for this workspace.",
            ].join("\n"),
            timestamp: now,
          });
        } catch (err: any) {
          ctx.addLine({ type: "error", content: `Approval failed: ${err.message}`, timestamp: now });
        }
        break;
      }

      case "reject": {
        const id = parts[1];
        const reason = parts.slice(2).join(" ") || "Rejected by user";
        if (!id) {
          ctx.addLine({ type: "error", content: "Usage: /selfdev reject <lesson_id> [reason]", timestamp: now });
          break;
        }

        try {
          const lesson = await reviewService.get(workspace, id);
          if (!lesson) {
            ctx.addLine({ type: "error", content: `Lesson not found: ${id}`, timestamp: now });
            break;
          }
          await reviewService.reject(workspace, id, lesson.version, reason);
          ctx.addLine({
            type: "system",
            content: `Candidate lesson ${id} rejected and removed.`,
            timestamp: now,
          });
        } catch (err: any) {
          ctx.addLine({ type: "error", content: `Rejection failed: ${err.message}`, timestamp: now });
        }
        break;
      }

      case "retire": {
        const id = parts[1];
        const reason = parts.slice(2).join(" ") || "Retired by user";
        if (!id) {
          ctx.addLine({ type: "error", content: "Usage: /selfdev retire <lesson_id> [reason]", timestamp: now });
          break;
        }

        try {
          const lesson = await reviewService.get(workspace, id);
          if (!lesson) {
            ctx.addLine({ type: "error", content: `Lesson not found: ${id}`, timestamp: now });
            break;
          }
          const retired = await reviewService.retire(workspace, id, lesson.version, reason);
          ctx.addLine({
            type: "system",
            content: `Lesson ${retired.id} retired and will no longer be injected into prompts.`,
            timestamp: now,
          });
        } catch (err: any) {
          ctx.addLine({ type: "error", content: `Retire failed: ${err.message}`, timestamp: now });
        }
        break;
      }

      case "review": {
        try {
          const candidates = await reviewService.list(workspace, "candidate");
          if (candidates.length === 0) {
            ctx.addLine({
              type: "system",
              content: [
                "No candidate lessons pending review for this workspace.",
                "Run /selfdev distill to extract lessons from recent task trajectories.",
              ].join("\n"),
              timestamp: now,
            });
            break;
          }

          const lines = [
            `Candidate Lessons Pending Review (${candidates.length}):`,
            "Review each candidate below and approve or reject:",
          ];
          for (let i = 0; i < candidates.length; i++) {
            const c = candidates[i];
            lines.push(
              `\n[${i + 1}] ID: ${c.id} (v${c.version})`,
              `    Statement: ${c.statement}`,
              `    Rationale: ${c.rationale || "None"}`,
              `    Tags     : ${c.tags?.join(", ") || "none"}`,
              `    Approve  : /selfdev approve ${c.id} ${c.version}`,
              `    Reject   : /selfdev reject ${c.id}`
            );
          }
          lines.push(
            "",
            "Tip: You can also use interactive step-by-step CLI review by running:",
            "  superagent selfdev review"
          );

          ctx.addLine({ type: "system", content: lines.join("\n"), timestamp: now });
        } catch (err: any) {
          ctx.addLine({ type: "error", content: `Failed to load review candidates: ${err.message}`, timestamp: now });
        }
        break;
      }

      default: {
        ctx.addLine({
          type: "system",
          content: [
            "Usage: /selfdev <subcommand> [options]",
            "",
            "Subcommands:",
            "  status                        - Show Self-Dev engine status and lesson counts",
            "  doctor                        - Run read-only health diagnostics",
            "  metrics                       - Show stored learning metrics",
            "  enable                        - Enable self-development globally",
            "  disable                       - Disable self-development globally",
            "  list [candidate|active|ret]   - List lessons for current workspace",
            "  review                        - Review pending candidate lessons",
            "  distill [max]                 - Distill recent events into candidate lessons",
            "  approve <id> [version]        - Approve candidate lesson to become active",
            "  feedback <id> <applied|helped|harmed> - Record explicit lesson feedback",
            "  reject <id> [reason]          - Reject and discard candidate lesson",
            "  retire <id> [reason]          - Retire active lesson so it stops injecting",
          ].join("\n"),
          timestamp: now,
        });
      }
    }
  },
};

registry.register(selfdevCommand);
