import { daemonScheduler } from "./daemonScheduler.js";
import { describeCron, isValidCron } from "./cronParser.js";

export async function handleDaemonCli(args: string[]): Promise<void> {
  const subcommand = args[0] ? args[0].toLowerCase() : "status";

  switch (subcommand) {
    case "start": {
      daemonScheduler.startDaemon();
      console.log("Superagent daemon scheduler started in background.");
      console.log("- Status: Running");
      console.log(`- PID: ${process.pid}`);
      // Keep process alive if invoked as standalone daemon runner
      process.stdin.resume();
      break;
    }

    case "stop": {
      daemonScheduler.stopDaemon();
      console.log("Superagent daemon scheduler stopped.");
      process.exit(0);
      break;
    }

    case "status": {
      const status = daemonScheduler.getStatus();
      const jobs = daemonScheduler.listJobs();
      console.log("Superagent Daemon Status:");
      console.log(`- Running: ${status.running ? "Yes" : "No"}`);
      console.log(`- PID: ${status.pid}`);
      console.log(`- Uptime: ${status.uptime}s`);
      console.log(`- Active Running Jobs: ${status.activeJobsCount}`);
      console.log(`- Total Scheduled Jobs: ${jobs.length}`);
      process.exit(0);
      break;
    }

    case "top":
    case "dashboard":
    case "dash": {
      const { renderDaemonDashboard } = await import("./daemonScheduler.js");
      const status = daemonScheduler.getStatus();
      const jobs = daemonScheduler.listJobs();
      const dashboard = renderDaemonDashboard(status, jobs, (id) => daemonScheduler.isJobRunning(id));
      console.log(dashboard);
      process.exit(0);
      break;
    }

    case "list": {
      const jobs = daemonScheduler.listJobs();
      if (jobs.length === 0) {
        console.log("No scheduled daemon jobs found.");
        console.log("Use 'superagent daemon add' to create a scheduled job.");
        process.exit(0);
      }
      console.log(`Scheduled Jobs (${jobs.length}):`);
      for (const job of jobs) {
        const nextTimeStr = job.nextRun ? new Date(job.nextRun).toLocaleString() : "None";
        console.log(`- ID: ${job.id}`);
        console.log(`  Name: ${job.name}`);
        console.log(`  Schedule: ${job.cronExpression} (${describeCron(job.cronExpression)})`);
        console.log(`  Enabled: ${job.enabled ? "Yes" : "No"}`);
        console.log(`  Next Run: ${nextTimeStr}`);
        console.log(`  Run Count: ${job.runCount}`);
        console.log(`  Last Status: ${job.lastStatus || "Never run"}`);
        console.log(`  Prompt: ${job.prompt.slice(0, 80)}${job.prompt.length > 80 ? "..." : ""}`);
      }
      process.exit(0);
      break;
    }

    case "add": {
      const nameIndex = args.indexOf("--name");
      const cronIndex = args.indexOf("--cron");
      const promptIndex = args.indexOf("--prompt");
      const wsIndex = args.indexOf("--workspace");
      const maxRunsIndex = args.indexOf("--max-runs");
      const tagsIndex = args.indexOf("--tags");
      const isMulti = args.includes("--multi");
      const notifyGateway = args.includes("--notify-gateway");

      const name = nameIndex !== -1 && args[nameIndex + 1] ? args[nameIndex + 1] : "";
      const cron = cronIndex !== -1 && args[cronIndex + 1] ? args[cronIndex + 1] : "";
      const prompt = promptIndex !== -1 && args[promptIndex + 1] ? args[promptIndex + 1] : "";
      const workspace = wsIndex !== -1 && args[wsIndex + 1] ? args[wsIndex + 1] : process.cwd();
      const maxRuns = maxRunsIndex !== -1 && args[maxRunsIndex + 1] ? parseInt(args[maxRunsIndex + 1], 10) : undefined;
      const tags = tagsIndex !== -1 && args[tagsIndex + 1] ? args[tagsIndex + 1].split(",").map(t => t.trim()) : undefined;

      if (!name || !cron || !prompt) {
        console.log("Error: Missing required arguments for 'daemon add'.");
        console.log("Usage: superagent daemon add --name <job_name> --cron <cron_expression> --prompt <task_prompt>");
        console.log("         [--workspace <path>] [--multi] [--notify-gateway] [--max-runs <n>] [--tags <t1,t2>]");
        process.exit(1);
      }

      if (!isValidCron(cron)) {
        console.log(`Error: Invalid cron expression "${cron}". Expected 5 fields: minute hour day month day-of-week`);
        process.exit(1);
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
        console.log("Successfully added scheduled daemon job:");
        console.log(`- ID: ${job.id}`);
        console.log(`- Name: ${job.name}`);
        console.log(`- Schedule: ${job.cronExpression} (${describeCron(job.cronExpression)})`);
        console.log(`- Mode: ${job.mode}`);
        console.log(`- Notify Gateway: ${job.notifyGateway ? "Yes" : "No"}`);
        console.log(`- Max Runs: ${job.maxRuns ?? "Unlimited"}`);
        console.log(`- Next Run: ${job.nextRun ? new Date(job.nextRun).toLocaleString() : "Unknown"}`);
        process.exit(0);
      } catch (err: any) {
        console.log(`Failed to add daemon job: ${err.message}`);
        process.exit(1);
      }
      break;
    }

    case "remove":
    case "delete": {
      const id = args[1];
      if (!id) {
        console.log("Error: Missing job ID.");
        console.log("Usage: superagent daemon remove <job_id>");
        process.exit(1);
      }
      const deleted = daemonScheduler.deleteJob(id);
      if (deleted) {
        console.log(`Successfully deleted job ${id}.`);
        process.exit(0);
      } else {
        console.log(`Error: Job not found: ${id}`);
        process.exit(1);
      }
      break;
    }

    case "run": {
      const id = args[1];
      if (!id) {
        console.log("Error: Missing job ID.");
        console.log("Usage: superagent daemon run <job_id>");
        process.exit(1);
      }
      console.log(`Triggering job ${id} now...`);
      const result = await daemonScheduler.triggerJobNow(id);
      if (result.success) {
        console.log("Job completed successfully.");
        if (result.output) {
          console.log("Output:");
          console.log(result.output);
        }
        process.exit(0);
      } else {
        console.log(`Job failed with error: ${result.error}`);
        process.exit(1);
      }
      break;
    }

    default: {
      console.log(`Unknown daemon command: ${subcommand}`);
      console.log("Available daemon commands:");
      console.log("- superagent daemon status");
      console.log("- superagent daemon top");
      console.log("- superagent daemon start");
      console.log("- superagent daemon stop");
      console.log("- superagent daemon list");
      console.log("- superagent daemon add --name <n> --cron <c> --prompt <p> [--workspace <w>] [--multi]");
      console.log("- superagent daemon remove <id>");
      console.log("- superagent daemon run <id>");
      process.exit(1);
    }
  }
}
