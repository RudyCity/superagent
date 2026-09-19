import { getSelfDevConfig, updateSelfDevConfig } from "../selfdev/settings.js";
import { getSelfDevLessonsPath } from "../config/paths.js";
import { getHistoryDb } from "../storage/historyDb.js";
import { SelfDevEventStore } from "../selfdev/eventStore.js";
import { ReviewService } from "../selfdev/reviewService.js";
import { CandidateStore } from "../selfdev/candidateStore.js";
import { distillAndStore } from "../selfdev/distiller.js";

export function printSelfDevHelp(): void {
  console.log(`
Usage: superagent selfdev <command> [options]

Commands:
  status                                Show Self-Dev engine configuration and lesson counts
  enable                                Enable self-development globally
  disable                               Disable self-development globally
  list [candidate|active|retired]       List lessons for current workspace
  review                                Interactive review wizard for pending candidate lessons
  distill [max]                         Distill recent session events into candidate lessons
  approve <lesson_id> [version]         Approve a candidate lesson to make it active
  reject <lesson_id> [reason]           Reject and discard a candidate lesson
  retire <lesson_id> [reason]           Retire an active lesson to stop injecting it

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
