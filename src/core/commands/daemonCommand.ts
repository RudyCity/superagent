import { registry } from "./registry.js";
import { SlashCommand } from "./types.js";

// /daemon command
export const daemonCommand: SlashCommand = {
  name: "daemon",
  description: "Manage the autonomous background daemon & cron scheduler",
  async execute(args, ctx) {
    const parts = args.trim().split(/\s+/).filter(Boolean);
    const subcommand = (parts[0] || "status").toLowerCase();
    const now = Date.now();

    const { daemonScheduler } = await import("../daemon/daemonScheduler.js");
    const { describeCron, isValidCron } = await import("../daemon/cronParser.js");

    switch (subcommand) {
      case "start": {
        daemonScheduler.startDaemon();
        ctx.addLine({
          type: "system",
          content: [
            "Daemon scheduler started.",
            "- Tick interval: 30s",
            `- PID: ${process.pid}`,
            "Note: The daemon runs in-process. Use 'superagent daemon start' from a terminal for a persistent background session.",
          ].join("\n"),
          timestamp: now,
        });
        break;
      }

      case "stop": {
        daemonScheduler.stopDaemon();
        ctx.addLine({
          type: "system",
          content: "Daemon scheduler stopped.",
          timestamp: now,
        });
        break;
      }

      case "status": {
        const status = daemonScheduler.getStatus();
        const jobs = daemonScheduler.listJobs();
        ctx.addLine({
          type: "system",
          content: [
            "Daemon Status:",
            `- Running    : ${status.running ? "Yes" : "No"}`,
            `- PID        : ${status.pid}`,
            `- Uptime     : ${status.uptime}s`,
            `- Active jobs: ${status.activeJobsCount}`,
            `- Total jobs : ${jobs.length}`,
          ].join("\n"),
          timestamp: now,
        });
        break;
      }

      case "top":
      case "dashboard":
      case "dash": {
        const { renderDaemonDashboard } = await import("../daemon/daemonScheduler.js");
        const status = daemonScheduler.getStatus();
        const jobs = daemonScheduler.listJobs();
        const dashboard = renderDaemonDashboard(status, jobs, (id) => daemonScheduler.isJobRunning(id));
        ctx.addLine({
          type: "system",
          content: dashboard,
          timestamp: now,
        });
        break;
      }

      case "list": {
        const jobs = daemonScheduler.listJobs();
        if (jobs.length === 0) {
          ctx.addLine({
            type: "system",
            content: "No scheduled daemon jobs found.\nUse /daemon add --name <n> --cron <c> --prompt <p> to create one.",
            timestamp: now,
          });
          break;
        }
        const lines = [`Scheduled Jobs (${jobs.length}):`];
        for (const job of jobs) {
          const nextStr = job.nextRun ? new Date(job.nextRun).toLocaleString() : "None";
          lines.push(
            `\n- [${job.enabled ? "ON " : "OFF"}] ${job.name} (${job.id})`,
            `  Schedule : ${job.cronExpression} — ${describeCron(job.cronExpression)}`,
            `  Mode     : ${job.mode}`,
            `  Runs     : ${job.runCount}${job.maxRuns ? `/${job.maxRuns}` : ""}`,
            `  Status   : ${job.lastStatus || "Never run"}`,
            `  Next run : ${nextStr}`,
            `  Prompt   : ${job.prompt.slice(0, 80)}${job.prompt.length > 80 ? "..." : ""}`
          );
        }
        ctx.addLine({ type: "system", content: lines.join("\n"), timestamp: now });
        break;
      }

      case "add": {
        const nameIdx = parts.indexOf("--name");
        const cronIdx = parts.indexOf("--cron");
        const promptIdx = parts.indexOf("--prompt");
        const wsIdx = parts.indexOf("--workspace");
        const maxRunsIdx = parts.indexOf("--max-runs");
        const tagsIdx = parts.indexOf("--tags");
        const isMulti = parts.includes("--multi");
        const notifyGateway = parts.includes("--notify-gateway");

        const name = nameIdx !== -1 && parts[nameIdx + 1] ? parts[nameIdx + 1] : "";
        const cron = cronIdx !== -1 && parts[cronIdx + 1] ? parts[cronIdx + 1] : "";
        // Allow multi-word prompt by collecting from --prompt until next flag
        let prompt = "";
        if (promptIdx !== -1) {
          const promptParts: string[] = [];
          for (let i = promptIdx + 1; i < parts.length; i++) {
            if (parts[i].startsWith("--")) break;
            promptParts.push(parts[i]);
          }
          prompt = promptParts.join(" ");
        }
        const workspace = wsIdx !== -1 && parts[wsIdx + 1] ? parts[wsIdx + 1] : process.cwd();
        const maxRuns = maxRunsIdx !== -1 && parts[maxRunsIdx + 1] ? parseInt(parts[maxRunsIdx + 1], 10) : undefined;
        const tags = tagsIdx !== -1 && parts[tagsIdx + 1] ? parts[tagsIdx + 1].split(",").map(t => t.trim()) : undefined;

        if (!name || !cron || !prompt) {
          ctx.addLine({
            type: "error",
            content: [
              "Missing required arguments for daemon add.",
              "Usage: /daemon add --name <name> --cron <cron> --prompt <task>",
              "         [--workspace <path>] [--multi] [--notify-gateway]",
              "         [--max-runs <n>] [--tags <tag1,tag2>]",
              'Example: /daemon add --name nightly --cron "0 2 * * *" --prompt "Clean cache"',
            ].join("\n"),
            timestamp: now,
          });
          break;
        }

        if (!isValidCron(cron)) {
          ctx.addLine({
            type: "error",
            content: `Invalid cron expression: "${cron}"\nExpected 5-field format: minute hour day month day-of-week`,
            timestamp: now,
          });
          break;
        }

        try {
          const job = daemonScheduler.addJob({
            name,
            cronExpression: cron,
            prompt,
            workspace,
            mode: isMulti ? "multi" : "single",
            notifyGateway,
            maxRuns: Number.isFinite(maxRuns) ? maxRuns : undefined,
            tags,
          });
          ctx.addLine({
            type: "system",
            content: [
              "Daemon job added:",
              `- ID       : ${job.id}`,
              `- Name     : ${job.name}`,
              `- Schedule : ${job.cronExpression} — ${describeCron(job.cronExpression)}`,
              `- Mode     : ${job.mode}`,
              `- Notify   : ${job.notifyGateway ? "Yes" : "No"}`,
              `- Next run : ${job.nextRun ? new Date(job.nextRun).toLocaleString() : "Unknown"}`,
            ].join("\n"),
            timestamp: now,
          });
        } catch (err: any) {
          ctx.addLine({ type: "error", content: `Failed to add job: ${err.message}`, timestamp: now });
        }
        break;
      }

      case "remove":
      case "delete": {
        const id = parts[1];
        if (!id) {
          ctx.addLine({ type: "error", content: "Usage: /daemon remove <job_id>", timestamp: now });
          break;
        }
        const deleted = daemonScheduler.deleteJob(id);
        ctx.addLine({
          type: deleted ? "system" : "error",
          content: deleted ? `Job ${id} deleted.` : `Job not found: ${id}`,
          timestamp: now,
        });
        break;
      }

      case "enable":
      case "disable": {
        const id = parts[1];
        if (!id) {
          ctx.addLine({ type: "error", content: `Usage: /daemon ${subcommand} <job_id>`, timestamp: now });
          break;
        }
        const enable = subcommand === "enable";
        const updated = daemonScheduler.updateJob(id, { enabled: enable });
        ctx.addLine({
          type: updated ? "system" : "error",
          content: updated ? `Job ${id} ${enable ? "enabled" : "disabled"}.` : `Job not found: ${id}`,
          timestamp: now,
        });
        break;
      }

      case "run": {
        const id = parts[1];
        if (!id) {
          ctx.addLine({ type: "error", content: "Usage: /daemon run <job_id>", timestamp: now });
          break;
        }
        ctx.addLine({ type: "system", content: `Triggering job ${id} now (running in background)...`, timestamp: now });
        daemonScheduler.triggerJobNow(id).then((result) => {
          if (result.success) {
            ctx.addLine({
              type: "system",
              content: `Job ${id} completed.\n${result.output ? result.output.slice(0, 500) : ""}`,
              timestamp: Date.now(),
            });
          } else {
            ctx.addLine({ type: "error", content: `Job ${id} failed: ${result.error}`, timestamp: Date.now() });
          }
        }).catch((err: any) => {
          ctx.addLine({ type: "error", content: `Job ${id} error: ${err.message}`, timestamp: Date.now() });
        });
        break;
      }

      default: {
        ctx.addLine({
          type: "system",
          content: [
            "Usage: /daemon <subcommand> [options]",
            "",
            "Subcommands:",
            "  status                             - Show daemon status and job count",
            "  top, dash                          - Display live daemon dashboard & job countdowns",
            "  start                              - Start the in-process daemon scheduler",
            "  stop                               - Stop the in-process daemon scheduler",
            "  list                               - List all scheduled jobs",
            "  add --name <n> --cron <c> --prompt <p>",
            "    [--workspace <path>] [--multi]",
            "    [--notify-gateway] [--max-runs <n>]",
            "    [--tags <t1,t2>]               - Add a new scheduled job",
            "  remove <id>                        - Delete a job by ID",
            "  enable <id>                        - Enable a paused job",
            "  disable <id>                       - Disable a job without deleting",
            "  run <id>                           - Trigger a job immediately (async)",
          ].join("\n"),
          timestamp: now,
        });
      }
    }
  },
};

registry.register(daemonCommand);
