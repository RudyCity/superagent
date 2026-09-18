import http from "http";
import { URL } from "url";
import { daemonScheduler } from "./daemonScheduler.js";

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
