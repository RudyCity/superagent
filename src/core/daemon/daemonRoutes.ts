import http from "http";
import { URL } from "url";
import { daemonScheduler } from "./daemonScheduler.js";
import { getDaemonRun, listDaemonRuns } from "../storage/daemonRunLedger.js";
import type { DaemonRunStatus } from "./daemonTypes.js";
import { projectDaemonRun } from "../channels/unifiedChannelTask.js";

export async function handleDaemonRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  parsedUrl: URL,
  ctx: {
    sendJSON: (res: http.ServerResponse, status: number, data: any) => void;
    readBody: (req: http.IncomingMessage) => Promise<string>;
  }
): Promise<boolean> {
  const { sendJSON, readBody } = ctx;

  // Durable run diagnostics and cancellation. API requests are authenticated by server.ts.
  if (pathname === "/api/daemon/runs" && req.method === "GET") {
    const validStatuses = new Set<DaemonRunStatus>([
      "queued", "running", "success", "error", "interrupted", "timed_out", "cancelled",
    ]);
    const rawLimit = parsedUrl.searchParams.get("limit");
    const limit = rawLimit == null ? 100 : Number(rawLimit);
    const status = parsedUrl.searchParams.get("status");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500 ||
        (status !== null && !validStatuses.has(status as DaemonRunStatus))) {
      sendJSON(res, 400, { success: false, error: "Invalid limit (1–500) or run status." });
      return true;
    }
    const jobId = parsedUrl.searchParams.get("job");
    const projectId = parsedUrl.searchParams.get("project");
    if ((jobId && jobId.length > 2048) || (projectId && projectId.length > 2048)) {
      sendJSON(res, 400, { success: false, error: "Run filter exceeds maximum length." });
      return true;
    }
    const runs = listDaemonRuns({
      limit,
      ...(status ? { status: status as DaemonRunStatus } : {}),
      ...(jobId ? { jobId } : {}),
      ...(projectId ? { projectId } : {}),
    });
    // Opt-in normalized read-only view; no new routes or broadened grants.
    const normalized = parsedUrl.searchParams.get("normalized") === "1";
    sendJSON(res, 200, normalized
      ? { success: true, runs, count: runs.length, channelTasks: runs.map(projectDaemonRun) }
      : { success: true, runs, count: runs.length });
    return true;
  }

  if (pathname.startsWith("/api/daemon/runs/")) {
    const suffix = pathname.slice("/api/daemon/runs/".length);
    const cancellation = suffix.endsWith("/cancel");
    const encodedRunId = cancellation ? suffix.slice(0, -"/cancel".length) : suffix;
    let runId: string;
    try {
      runId = decodeURIComponent(encodedRunId);
      if (!runId || runId.includes("/") || runId.length > 256) throw new Error("Invalid run id");
    } catch {
      sendJSON(res, 400, { success: false, error: "Invalid run id." });
      return true;
    }
    const run = getDaemonRun(runId);
    if (req.method === "GET" && !cancellation) {
      const normalized = parsedUrl.searchParams.get("normalized") === "1";
      sendJSON(res, run ? 200 : 404,
        run ? (normalized
          ? { success: true, run, channelTask: projectDaemonRun(run) }
          : { success: true, run })
        : { success: false, error: "Run not found." });
      return true;
    }
    if (req.method === "POST" && cancellation) {
      if (!run) {
        sendJSON(res, 404, { success: false, error: "Run not found." });
      } else if (run.status !== "running" || !daemonScheduler.cancelRun(runId)) {
        sendJSON(res, 409, { success: false, error: "Run is not currently active and cancellable." });
      } else {
        sendJSON(res, 202, { success: true, runId, cancellation: "requested" });
      }
      return true;
    }
    sendJSON(res, 405, { success: false, error: "Unsupported method for run endpoint." });
    return true;
  }

  // Status
  if (pathname === "/api/daemon/status" && req.method === "GET") {
    sendJSON(res, 200, { success: true, ...daemonScheduler.getStatus() });
    return true;
  }

  // Start Daemon
  if (pathname === "/api/daemon/start" && req.method === "POST") {
    try {
      const rawBody = await readBody(req);
      const { tickIntervalMs } = JSON.parse(rawBody || "{}");
      daemonScheduler.startDaemon(tickIntervalMs);
      sendJSON(res, 200, { success: true, running: true, message: "Daemon scheduler started" });
    } catch (err: any) {
      sendJSON(res, 500, { error: err.message });
    }
    return true;
  }

  // Stop Daemon
  if (pathname === "/api/daemon/stop" && req.method === "POST") {
    daemonScheduler.stopDaemon();
    sendJSON(res, 200, { success: true, running: false, message: "Daemon scheduler stopped" });
    return true;
  }

  // List Jobs
  if (pathname === "/api/daemon/jobs" && req.method === "GET") {
    sendJSON(res, 200, { success: true, jobs: daemonScheduler.listJobs() });
    return true;
  }

  // Add Job
  if (pathname === "/api/daemon/jobs" && req.method === "POST") {
    try {
      const rawBody = await readBody(req);
      const payload = JSON.parse(rawBody || "{}");
      if (!payload.name || !payload.cronExpression || !payload.prompt) {
        sendJSON(res, 400, { error: "Missing required fields: name, cronExpression, prompt" });
        return true;
      }
      const job = daemonScheduler.addJob(payload);
      sendJSON(res, 201, { success: true, job });
    } catch (err: any) {
      sendJSON(res, 400, { error: err.message });
    }
    return true;
  }

  // Update Job
  if (pathname === "/api/daemon/jobs" && req.method === "PATCH") {
    try {
      const rawBody = await readBody(req);
      const payload = JSON.parse(rawBody || "{}");
      const id = payload.id || parsedUrl.searchParams.get("id");
      if (!id) {
        sendJSON(res, 400, { error: "Missing job id" });
        return true;
      }
      const updated = daemonScheduler.updateJob(id, payload);
      if (!updated) {
        sendJSON(res, 404, { error: `Job not found: ${id}` });
        return true;
      }
      sendJSON(res, 200, { success: true, job: updated });
    } catch (err: any) {
      sendJSON(res, 400, { error: err.message });
    }
    return true;
  }

  // Delete Job
  if (pathname === "/api/daemon/jobs" && req.method === "DELETE") {
    try {
      const rawBody = await readBody(req);
      const parsedBody = rawBody ? JSON.parse(rawBody) : {};
      const id = parsedBody.id || parsedUrl.searchParams.get("id");
      if (!id) {
        sendJSON(res, 400, { error: "Missing job id" });
        return true;
      }
      const deleted = daemonScheduler.deleteJob(id);
      sendJSON(res, 200, { success: deleted, deletedId: id });
    } catch (err: any) {
      sendJSON(res, 400, { error: err.message });
    }
    return true;
  }

  // Run Job Immediately
  if (pathname === "/api/daemon/jobs/run" && req.method === "POST") {
    try {
      const rawBody = await readBody(req);
      const payload = JSON.parse(rawBody || "{}");
      const id = payload.id || parsedUrl.searchParams.get("id");
      if (!id) {
        sendJSON(res, 400, { error: "Missing job id" });
        return true;
      }
      const result = await daemonScheduler.triggerJobNow(id);
      sendJSON(res, result.success ? 200 : 400, result);
    } catch (err: any) {
      sendJSON(res, 500, { error: err.message });
    }
    return true;
  }

  return false;
}
