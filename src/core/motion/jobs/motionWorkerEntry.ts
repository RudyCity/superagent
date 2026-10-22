/**
 * Separate process entry for detached Motion rendering.
 * No SuperAgent daemon, HTTP endpoint or agent session is bootstrapped here.
 */
import { runPreparedMotionJob } from "./motionJobs.js";

const [workspace, jobId] = process.argv.slice(2);
if (!workspace || !/^(?:studiojob|motionjob)-[0-9a-f]{24}$/.test(jobId ?? "")) {
  process.exitCode = 2;
} else {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.on("SIGINT", abort);
  process.on("SIGTERM", abort);
  try {
    const job = await runPreparedMotionJob(workspace, jobId, { signal: controller.signal });
    process.exitCode = job.status === "completed" ? 0 : job.status === "cancelled" ? 130 : 1;
  } catch (error) {
    console.error("Motion worker startup failed:", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
