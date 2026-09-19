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
            `- Event Collection  : ${config.collectionEnabled ? "Yes" : "No"}`,
            `- Prompt Injection  : ${config.injectionEnabled ? "Yes" : "No"}`,
            `- Active Workspace  : ${workspace}`,
            `- Store Path        : ${storePath}`,
            `- Active Lessons    : ${activeCount}`,
            `- Candidate Lessons : ${candidateCount}`,
            `- Retired Lessons   : ${retiredCount}`,
            "",
            "Commands: /selfdev list | /selfdev distill | /selfdev approve <id> | /selfdev enable | /selfdev disable",
          ].join("\n"),
          timestamp: now,
        });
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
            "  enable                        - Enable self-development globally",
            "  disable                       - Disable self-development globally",
            "  list [candidate|active|ret]   - List lessons for current workspace",
            "  review                        - Review pending candidate lessons",
            "  distill [max]                 - Distill recent events into candidate lessons",
            "  approve <id> [version]        - Approve candidate lesson to become active",
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
