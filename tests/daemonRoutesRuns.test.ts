import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";

const mocked = vi.hoisted(() => ({
  listDaemonRuns: vi.fn(),
  getDaemonRun: vi.fn(),
  cancelRun: vi.fn(),
}));
vi.mock("../src/core/storage/daemonRunLedger.js", () => ({
  listDaemonRuns: mocked.listDaemonRuns,
  getDaemonRun: mocked.getDaemonRun,
}));
vi.mock("../src/core/daemon/daemonScheduler.js", () => ({
  daemonScheduler: { cancelRun: mocked.cancelRun },
}));
import { handleDaemonRoutes } from "../src/core/daemon/daemonRoutes.js";

describe("daemon run REST endpoints", () => {
  const response = vi.fn();
  const sendJSON = (_res: ServerResponse, status: number, data: unknown) => response(status, data);
  const readBody = vi.fn(async () => "");
  const activeRun = { runId: "run-a", jobId: "job-a", status: "running", notificationStatus: "pending" };

  beforeEach(() => {
    response.mockReset();
    mocked.listDaemonRuns.mockReset();
    mocked.getDaemonRun.mockReset();
    mocked.cancelRun.mockReset();
  });

  async function call(method: string, url: string) {
    const parsedUrl = new URL(url, "http://127.0.0.1");
    return handleDaemonRoutes({ method } as IncomingMessage, {} as ServerResponse,
      parsedUrl.pathname, parsedUrl, { sendJSON, readBody });
  }

  it("queries run history with bounded validated filters", async () => {
    mocked.listDaemonRuns.mockReturnValue([activeRun]);
    expect(await call("GET", "/api/daemon/runs?job=job-a&status=running&limit=9&project=project-a")).toBe(true);
    expect(mocked.listDaemonRuns).toHaveBeenCalledWith({
      jobId: "job-a", status: "running", projectId: "project-a", limit: 9,
    });
    expect(response).toHaveBeenCalledWith(200, { success: true, runs: [activeRun], count: 1 });
  });

  it("provides opt-in normalized channel state without changing legacy responses", async () => {
    const run = {
      ...activeRun, projectId: "project-a", workspacePath: "/workspace/a",
      startedAt: 100, completedAt: null, executionPolicyJson: "{}",
      attemptNumber: 1, mode: "single",
    };
    mocked.listDaemonRuns.mockReturnValue([run]);
    await call("GET", "/api/daemon/runs?normalized=1");
    const payload = response.mock.calls.at(-1)?.[1];
    expect(payload.channelTasks).toMatchObject([{
      schemaVersion: 1, channel: "daemon", taskId: "run-a",
      projectId: "project-a", status: "running", notification: "pending",
    }]);
    await call("GET", "/api/daemon/runs");
    expect(response.mock.calls.at(-1)?.[1]).not.toHaveProperty("channelTasks");
    mocked.getDaemonRun.mockReturnValue(run);
    await call("GET", "/api/daemon/runs/run-a?normalized=1");
    expect(response.mock.calls.at(-1)?.[1].channelTask.taskId).toBe("run-a");
  });

  it("rejects malformed filters without querying the ledger", async () => {
    await call("GET", "/api/daemon/runs?limit=501");
    await call("GET", "/api/daemon/runs?status=maybe");
    expect(response.mock.calls.every(([status]) => status === 400)).toBe(true);
    expect(mocked.listDaemonRuns).not.toHaveBeenCalled();
  });

  it("returns run details and a not-found response", async () => {
    mocked.getDaemonRun.mockReturnValueOnce(activeRun).mockReturnValueOnce(null);
    expect(await call("GET", "/api/daemon/runs/run-a")).toBe(true);
    expect(response).toHaveBeenLastCalledWith(200, { success: true, run: activeRun });
    expect(await call("GET", "/api/daemon/runs/does-not-exist")).toBe(true);
    expect(response).toHaveBeenLastCalledWith(404, { success: false, error: "Run not found." });
  });

  it("accepts cancellation only for a confirmed currently active run", async () => {
    mocked.getDaemonRun.mockReturnValue(activeRun);
    mocked.cancelRun.mockReturnValueOnce(true).mockReturnValueOnce(false);
    expect(await call("POST", "/api/daemon/runs/run-a/cancel")).toBe(true);
    expect(mocked.cancelRun).toHaveBeenCalledWith("run-a");
    expect(response).toHaveBeenLastCalledWith(202, {
      success: true, runId: "run-a", cancellation: "requested",
    });
    expect(await call("POST", "/api/daemon/runs/run-a/cancel")).toBe(true);
    expect(response.mock.calls.at(-1)?.[0]).toBe(409);
  });

  it("rejects malformed run identifiers, wrong methods, and already terminated runs", async () => {
    await call("GET", "/api/daemon/runs/%2Fbad");
    expect(response.mock.calls.at(-1)?.[0]).toBe(400);
    mocked.getDaemonRun.mockReturnValue({ ...activeRun, status: "success" });
    await call("POST", "/api/daemon/runs/run-a/cancel");
    expect(response.mock.calls.at(-1)?.[0]).toBe(409);
    expect(mocked.cancelRun).not.toHaveBeenCalled();
    await call("DELETE", "/api/daemon/runs/run-a");
    expect(response.mock.calls.at(-1)?.[0]).toBe(405);
  });
});
